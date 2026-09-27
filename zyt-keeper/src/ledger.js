import { getDb } from "./db.js";
import { CONFIG } from "./config.js";
import { logRun, notify } from "./alert.js";

/**
 * 链下账本（v9 口径，2026-09-24）：
 * - 从 events 增量汇总用户状态（入金/买入/卖出/算力基数/静态出局/动态额度）
 * - 算力日复利计算（power = base × 1.01^n）
 * - 全网算力统计（供 Keeper 快照传入）
 * - 每日对账（链上 pool 真池状态 vs 本地账本）
 *
 * v9 事件口径（真池 USDT↔ZYT 直换）：
 * - Deposited(user, usdt, power, quota, ref)：入金得算力 + 买额（quota）；动态额度 = usdt×5
 * - Bought(user, usdtIn, zytOut)：真实 AMM 买入，不影响账本提取额（买币是投入）
 * - Sold(user, zytIn, usdtOut, rate)：卖出实收 USDT 计入 withdraw_total（静态出局进度）
 * - RefPaid(receiver, usdtAmount, level)：推荐奖励 USDT 直发，同时消耗 receiver 动态额度（加速释放）
 * - Converted / BasePoolFunded 已删除（v9 无算力兑换/记账建池）
 * - DynamicExited：动态额度耗尽（复投恢复，Deposited 分支重置）
 */
export class Ledger {
  constructor(provider, contracts) {
    this.provider = provider;
    this.contracts = contracts;
    /** 静态出局倍数（reconcile 时以链上 config 校准） */
    this.exitMul = BigInt(CONFIG.params?.staticExitMul || 2);
    /** 动态额度倍数（v9 加速释放；reconcile 校准） */
    this.dynamicQuotaMul = BigInt(CONFIG.params?.dynamicQuotaMul || 5);
  }

  /** 增量重放事件，重建用户账本 */
  async rebuild() {
    const db = await getDb();
    await db.exec("DELETE FROM users;");
    // Sold 同 tx 去重集合（每次 rebuild 重置；Pool.Sold 与 Mining.Sold 同 tx 双 emit 只记一次）
    const seenSoldTx = new Set();
    // 按 chain_id 过滤重放——防本地联调（31337）与 testnet 事件混入同一张 events 表
    const rows = await db
      .all("SELECT name, from_addr, to_addr, amount, extra, created_at, tx_hash, block, block_time FROM events WHERE chain_id=? ORDER BY block, log_index", [CONFIG.chainId]);
    // 2026-09-26：补齐区块时间戳（power_day / exit_day 与合约 block.timestamp/86400 同口径）
    // 背景：原实现用 Date.now() 作复利起点，补拉或清库重建时历史入金的 power_day 被写成「重建当天」，
    //       复利天数归零导致算力偏低（实测账本 1500 vs 链上 1530.15）。改按事件所属区块时间戳换算。
    await this._ensureBlockTimes(rows);
    const upsertSql = `
      INSERT INTO users (address, deposit_total, withdraw_total, converted_total, received_value, exit_day, dynamic_quota, dynamic_withdrawn, power_base, power_day, is_exited, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(address) DO UPDATE SET
        deposit_total=excluded.deposit_total,
        withdraw_total=excluded.withdraw_total,
        converted_total=excluded.converted_total,
        received_value=excluded.received_value,
        exit_day=excluded.exit_day,
        dynamic_quota=excluded.dynamic_quota,
        dynamic_withdrawn=excluded.dynamic_withdrawn,
        power_base=excluded.power_base,
        power_day=excluded.power_day,
        is_exited=excluded.is_exited,
        updated_at=excluded.updated_at
    `;
    for (const r of rows) {
      const extra = JSON.parse(r.extra || "{}");
      if (r.name === "Deposited") {
        const day = this._dayOf(r);
        await this._apply(upsertSql, r.to_addr || extra.user, (u) => {
          const usdt = BigInt(extra.usdt ?? 0);
          const power = BigInt(extra.power ?? 0);
          u.deposit_total += usdt;
          // v9：动态额度叠加（加速释放载体），复投重置出局状态
          u.dynamic_quota += usdt * this.dynamicQuotaMul;
          u.is_exited = 0;
          u.exit_day = 0;
          // P1-12：与合约同口径，先固化此前累积的复利再重置起点
          if (u.power_base > 0n) {
            u.power_base = this._compound(u.power_base, Math.max(day - u.power_day, 0));
          }
          u.power_base += power;
          u.power_day = day;
          this._applyExit(u, day);
        });
      } else if (r.name === "RefPaid") {
        // v9 加速释放：推荐奖励逐笔消耗 receiver 动态额度
        await this._apply(upsertSql, extra.receiver || r.from_addr, (u) => {
          const paid = BigInt(extra.usdtAmount ?? 0);
          u.dynamic_withdrawn += paid;
          if (u.dynamic_withdrawn > u.dynamic_quota) u.dynamic_withdrawn = u.dynamic_quota;
        });
      } else if (r.name === "Sold") {
        // 同 tx 双 Sold 事件（Pool.Sold + Mining.Sold 各 emit 一条）只记一次，
        // 否则卖出实收 USDT 重复计入 withdraw_total（实测账本 3.0002 vs 链上 2.018 有偏差）
        const txKey = String(r.tx_hash || "");
        if (txKey) {
          if (seenSoldTx.has(txKey)) continue;
          seenSoldTx.add(txKey);
        }
        const day = this._dayOf(r);
        await this._apply(upsertSql, extra.user || extra.seller, (u) => {
          u.withdraw_total += BigInt(extra.usdtOut ?? 0);
          this._applyExit(u, day);
        });
      } else if (r.name === "StaticExited") {
        // 链上出局事件：记录出局日（按区块时间戳换算，与合约同日口径）
        const addr = extra.user || r.from_addr;
        const day = this._dayOf(r);
        await this._apply(upsertSql, addr, (u) => {
          u.is_exited = 1;
          if (!u.exit_day) u.exit_day = day;
        });
      } else if (r.name === "TransferLedger") {
        // P1-7：转账折算记账。转出计入提取额，转入计入受赠额（额度随币转移）
        const v = BigInt(extra.usdtValue ?? 0);
        const isOut = extra.isOut === true || extra.isOut === "true";
        const day = this._dayOf(r);
        await this._apply(upsertSql, extra.user, (u) => {
          if (isOut) {
            u.withdraw_total += v;
            this._applyExit(u, day);
          } else {
            u.received_value += v;
            this._applyExit(u, day);
          }
        });
      }
      // Bought / Claimed / DividendSettled / DailyReleased：不影响账本字段
      // （买入是投入非提取；分红从 pool 分红池划转，已由 /records 事件流呈现）
    }
    const n = await db.get("SELECT count(*) c FROM users");
    const count = n ? Number(n.c) : 0;
    logRun("ledger", "ok", `rebuild users=${count}`);
  }

  /**
   * 静态出局判定：累计提取 USDT 达入金 × exitMul 即停产。
   * 与合约 ZYTCompute.isStaticExited 同口径（入金与受赠双零时不判出局）。
   */
  _applyExit(u, day) {
    // 已出局：链上不会因后续事件自动恢复（只有复投会重置，走 Deposited 分支）
    if (u.exit_day > 0) {
      u.is_exited = 1;
      return;
    }
    // 与链上 ZYTCompute.isStaticExited 同口径：上限 = 入金 × 倍数 + 受赠，双零不判出局
    const cap = u.deposit_total * this.exitMul + u.received_value;
    const exited = (u.deposit_total > 0n || u.received_value > 0n) && u.withdraw_total >= cap;
    if (exited) {
      // 出局日取事件所属区块的天数（缺省回退当前天），与合约 _markExited 的 block.timestamp/86400 同口径
      u.exit_day = day || Math.floor(Date.now() / 86400000);
      u.is_exited = 1;
    }
  }

  /**
   * 事件所属区块的 UTC 天数，与合约 block.timestamp / 86400 同口径。
   * 回退顺序：block_time（区块时间戳）→ created_at（索引入库时间）→ 当前时间。
   */
  _dayOf(r) {
    const bt = Number(r.block_time || 0);
    if (bt > 0) return Math.floor(bt / 86400);
    const ca = Number(r.created_at || 0);
    if (ca > 0) return Math.floor(ca / 86400);
    return Math.floor(Date.now() / 86400000);
  }

  /**
   * 为缺失 block_time 的事件补齐区块时间戳并写回 events 表（只拉一次，后续复用）。
   * 依赖 provider.getBlock；单个块失败不影响其他块，该块事件由 _dayOf 回退到 created_at。
   */
  async _ensureBlockTimes(rows) {
    const pending = new Map();
    for (const r of rows) {
      if (!r.block_time && r.block) pending.set(Number(r.block), true);
    }
    if (pending.size === 0) return;
    const db = await getDb();
    for (const block of pending.keys()) {
      try {
        const b = await this.provider.getBlock(block);
        const ts = b && b.timestamp ? Number(b.timestamp) : 0;
        if (ts > 0) {
          await db.run("UPDATE events SET block_time=? WHERE chain_id=? AND block=?", [ts, CONFIG.chainId, block]);
          for (const r of rows) if (Number(r.block) === block) r.block_time = ts;
        }
      } catch (e) {
        logRun("ledger", "gap", `block_time 拉取失败 block=${block}: ${String(e.message).slice(0, 60)}`);
      }
    }
  }

  async _apply(upsertSql, addr, fn) {
    if (!addr) return;
    addr = String(addr).toLowerCase();
    const db = await getDb();
    const row = await db.get("SELECT * FROM users WHERE address=?", [addr]);
    const u = {
      deposit_total: row ? BigInt(row.deposit_total) : 0n,
      withdraw_total: row ? BigInt(row.withdraw_total) : 0n,
      converted_total: row ? BigInt(row.converted_total || "0") : 0n,
      received_value: row ? BigInt(row.received_value || "0") : 0n,
      exit_day: row ? Number(row.exit_day || 0) : 0,
      dynamic_quota: row ? BigInt(row.dynamic_quota) : 0n,
      dynamic_withdrawn: row ? BigInt(row.dynamic_withdrawn) : 0n,
      power_base: row ? BigInt(row.power_base) : 0n,
      power_day: row ? row.power_day : 0,
      is_exited: row ? row.is_exited : 0,
    };
    fn(u);
    await db.run(
      upsertSql,
      [
        addr,
        String(u.deposit_total),
        String(u.withdraw_total),
        String(u.converted_total),
        String(u.received_value),
        u.exit_day,
        String(u.dynamic_quota),
        String(u.dynamic_withdrawn),
        String(u.power_base),
        u.power_day,
        u.is_exited ? 1 : 0,
        Math.floor(Date.now() / 1000),
      ]
    );
  }

  /** 算力复利纯计算：base × 1.01^days（上限 365 天，与合约 ZYTCompute.MAX_COMPOUND_DAYS 一致） */
  _compound(base, days) {
    const n = Math.min(Math.max(days, 0), 365);
    let p = base;
    for (let i = 0; i < n; i++) p = p + (p * 100n) / 10000n; // 1%
    return p;
  }

  /** 算力复利：base × 1.01^days */
  async powerOf(addr, nowDay = Math.floor(Date.now() / 86400000)) {
    const db = await getDb();
    const row = await db.get("SELECT power_base, power_day, exit_day FROM users WHERE address=?", [addr]);
    if (!row || BigInt(row.power_base) === 0n) return 0n;
    // 与合约 _powerOf 同口径：出局后算力停发（历史算力仍可回算，分红按日结算依赖）
    const exitDay = Number(row.exit_day || 0);
    if (exitDay > 0 && nowDay >= exitDay) return 0n;
    return this._compound(BigInt(row.power_base), nowDay - row.power_day);
  }

  /**
   * 全网算力（Σ 复利后）。单次查询后内存计算，避免逐用户 DB 往返。
   * @param {number} [day] 指定 UTC 天数，缺省用当前天。
   *   快照调用必须传「合约本次将要写入的 day」，以保证 dailyInfo[day].totalPower
   *   与合约侧 Σ _powerOf(user, day) 严格一致（分红公式的分母口径，2026-09-26 对齐）。
   */
  async totalPower(day) {
    const db = await getDb();
    const rows = await db.all("SELECT power_base, power_day, exit_day FROM users");
    const at = day === undefined || day === null ? Math.floor(Date.now() / 86400000) : Number(day);
    let sum = 0n;
    for (const r of rows) {
      const base = BigInt(r.power_base || 0);
      if (base === 0n) continue;
      const pd = Number(r.power_day || 0);
      // 该用户当日尚未入金 → 不计入当日全网算力（与合约 _settleDividend 的 from >= powerDay 一致）
      if (at < pd) continue;
      // 与合约 _powerOf(user, day) 同口径：出局当日起算力归零（历史分红按日回算不受影响）
      const exitDay = Number(r.exit_day || 0);
      if (exitDay > 0 && at >= exitDay) continue;
      sum += this._compound(base, at - pd);
    }
    return sum;
  }

  /** 每日对账（#3 真对账）：链上真池状态 → pool_state + 链上 userList 逐用户比对链下账本 */
  async reconcile() {
    const { pool, zyt, mining, config } = this.contracts;
    // 以链上倍数校准出局/动态额度口径（读失败沿用配置值）
    if (config) {
      try {
        const mul = BigInt(await config.staticExitMul());
        if (mul > 0n && mul !== this.exitMul) {
          logRun("reconcile", "ok", `staticExitMul 校准 ${this.exitMul} → ${mul}`);
          this.exitMul = mul;
        }
        try {
          const dq = BigInt(await config.dynamicQuotaMul());
          if (dq > 0n) this.dynamicQuotaMul = dq;
        } catch { /* 老配置合约无此函数 */ }
      } catch {
        /* 读失败：沿用现值 */
      }
    }
    // v9：真池数据源 = pair 储备（poolZYT/poolUSDT 为 view 直读 pair）
    const [zytRes, usdtRes, peak, snapUsdt, price, stage, slip, divPool, lpBurned] = await Promise.all([
      pool.poolZYT(),
      pool.poolUSDT(),
      pool.peakPoolUSDT ? pool.peakPoolUSDT().catch(() => 0n) : Promise.resolve(0n),
      pool.snapshotPoolUSDT ? pool.snapshotPoolUSDT().catch(() => 0n) : Promise.resolve(0n),
      pool.getPrice(),
      pool.getStage(),
      pool.getCurrentSlippage(),
      pool.dividendPoolZyt ? pool.dividendPoolZyt().catch(() => 0n) : Promise.resolve(0n),
      pool.totalLpBurned ? pool.totalLpBurned().catch(() => 0n) : Promise.resolve(0n),
    ]);
    const db = await getDb();
    // pool_state 列沿用（pool_gst/snapshot_gst/day_sold_gst 为 v8 遗留列写 '0'；
    // peak 滑点基准记入 snapshot_gst，分红池记入 day_sold_gst，供前端读取不新建表）
    await db.run(
      `
      INSERT INTO pool_state (id, pool_gst, pool_zyt, pool_usdt, snapshot_gst, price, slippage_pct, stage, day_sold_gst, snapshot_pool_usdt, updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET pool_gst=excluded.pool_gst, pool_zyt=excluded.pool_zyt,
        pool_usdt=excluded.pool_usdt, snapshot_gst=excluded.snapshot_gst, price=excluded.price,
        slippage_pct=excluded.slippage_pct, stage=excluded.stage,
        day_sold_gst=excluded.day_sold_gst, snapshot_pool_usdt=excluded.snapshot_pool_usdt,
        updated_at=excluded.updated_at
    `,
      ["0", String(zytRes), String(usdtRes), String(peak), String(price), Number(slip) / 100, Number(stage), String(divPool), String(snapUsdt), Math.floor(Date.now() / 1000)]
    );

    // ---- #3 真对账：链上 userList 逐用户比对（差异 >0.1% 视为不一致） ----
    const THRESHOLD_BPS = 10; // 0.1% = 10 基点
    const total = zyt ? Number(await zyt.getUserCount()) : 0;
    let diffUsers = 0;
    let maxDiffPct = 0;
    const diffs = [];
    if (zyt && mining && total > 0) {
      for (let i = 0; i < total; i++) {
        const addr = String(await zyt.getUserAt(i)).toLowerCase();
        // v9 userInfo 8 元组：(depositTotal, withdrawTotal, power, dynamicQuota, dynamicWithdrawn, buyQuotaLeft, staticExited, dynamicExited)
        // 比对 depositTotal / withdrawTotal / dynamicQuota / dynamicWithdrawn 四项
        let chain;
        try {
          chain = await mining.userInfo(addr);
        } catch {
          continue; // 链上读取失败跳过（下一轮重试）
        }
        const local = await db.get("SELECT * FROM users WHERE address=?", [addr]);
        const fields = [
          ["depositTotal", chain[0], local ? local.deposit_total : "0"],
          ["withdrawTotal", chain[1], local ? local.withdraw_total : "0"],
          ["dynamicQuota", chain[3], local ? local.dynamic_quota : "0"],
          ["dynamicWithdrawn", chain[4], local ? local.dynamic_withdrawn : "0"],
        ];
        let userMax = 0;
        for (const [name, cVal, lVal] of fields) {
          const c = BigInt(cVal);
          const l = BigInt(lVal || "0");
          const diff = c > l ? c - l : l - c;
          const pct = c === 0n ? (l === 0n ? 0 : 100) : Number((diff * 10000n) / c) / 100;
          if (pct > userMax) userMax = pct;
        }
        // P1-7：链上受赠值 vs 本地（transferValueOf 返回 (receivedValue, withdrawCap)）
        try {
          const tv = await mining.transferValueOf(addr);
          const chainReceived = BigInt(tv[0]);
          const localReceived = local ? BigInt(local.received_value || "0") : 0n;
          const d = chainReceived > localReceived ? chainReceived - localReceived : localReceived - chainReceived;
          const pct = chainReceived === 0n ? (localReceived === 0n ? 0 : 100) : Number((d * 10000n) / chainReceived) / 100;
          if (pct > userMax) userMax = pct;
        } catch {
          /* 合约未部署该接口，跳过 */
        }
        if (userMax > maxDiffPct) maxDiffPct = userMax;
        if (userMax * 100 > THRESHOLD_BPS) {
          diffUsers++;
          diffs.push(`${addr.slice(0, 8)}:${userMax.toFixed(2)}%`);
        }
      }
    }
    const status = diffUsers > 0 ? "diff" : "ok";
    await db.run(
      "INSERT INTO reconcile_results (checked_at, total_users, diff_users, max_diff_pct, status, detail) VALUES (?,?,?,?,?,?)",
      [Math.floor(Date.now() / 1000), total, diffUsers, maxDiffPct, status, diffs.slice(0, 20).join(",")]
    );
    if (diffUsers > 0) {
      logRun("reconcile", "error", `真对账发现 ${diffUsers}/${total} 用户差异, max=${maxDiffPct.toFixed(2)}%`);
      await notify(`[ZYT Keeper] 对账异常: ${diffUsers}/${total} 用户链上链下不一致, max=${maxDiffPct.toFixed(2)}% (${diffs.slice(0, 5).join(", ")})`);
    } else {
      logRun("reconcile", "ok", `pool zyt=${zytRes} usdt=${usdtRes} peak=${peak} price=${price} stage=${stage} slip=${Number(slip) / 100}% lpBurned=${lpBurned} | 对账 ${total} 用户一致`);
    }
    return { zytReserve: String(zytRes), usdtReserve: String(usdtRes), peak: String(peak), price: String(price), stage: Number(stage), slippage: Number(slip) / 100, lpBurned: String(lpBurned), reconcile: { total, diffUsers, maxDiffPct, status } };
  }
}
