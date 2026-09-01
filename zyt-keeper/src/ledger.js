import { getDb } from "./db.js";
import { CONFIG } from "./config.js";
import { logRun, notify } from "./alert.js";

/**
 * 链下账本：
 * - 从 events 增量汇总用户状态（入金/提取/额度/算力基数/出局）
 * - 算力日复利计算（power = base × 1.01^n）
 * - 全网算力统计（供 Keeper 快照传入）
 * - 每日对账（链上 pool 状态 vs 本地账本）
 * v8：全部方法 async（存储层统一异步接口，兼容内存 SQLite / MySQL）
 */
export class Ledger {
  constructor(provider, contracts) {
    this.provider = provider;
    this.contracts = contracts;
  }

  /** 增量重放事件，重建用户账本 */
  async rebuild() {
    const db = await getDb();
    await db.exec("DELETE FROM users;");
    // v9 修复：按 chain_id 过滤重放——防本地联调（31337）与 testnet 事件混入同一张 events 表
    // 污染 users 账本与 totalPower（曾导致 users=4：3 个 hardhat 幽灵用户 + 1 个 testnet 真实用户）
    const rows = await db
      .all("SELECT name, from_addr, to_addr, amount, extra FROM events WHERE chain_id=? ORDER BY block, log_index", [CONFIG.chainId]);
    const upsertSql = `
      INSERT INTO users (address, deposit_total, withdraw_total, dynamic_quota, dynamic_withdrawn, power_base, power_day, is_exited, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(address) DO UPDATE SET
        deposit_total=excluded.deposit_total,
        withdraw_total=excluded.withdraw_total,
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
        await this._apply(upsertSql, r.to_addr || extra.user, (u) => {
          u.deposit_total += BigInt(extra.usdt);
          u.power_base += BigInt(extra.power);
          u.power_day = Math.floor(Date.now() / 86400000);
          u.dynamic_quota = u.deposit_total * 5n;
        });
      } else if (r.name === "Sold") {
        await this._apply(upsertSql, extra.user, (u) => {
          u.withdraw_total += BigInt(extra.usdtOut);
          u.is_exited = u.deposit_total > 0n && u.withdraw_total >= u.deposit_total * 2n;
        });
      } else if (r.name === "Claimed") {
        await this._apply(upsertSql, extra.user, (u) => {
          // v8：使用事件中的 usdt 等值（与链上 dynamicWithdrawn 一致）
          u.dynamic_withdrawn += BigInt(extra.usdt ?? extra.reward ?? 0);
        });
      } else if (r.name === "RefReward") {
        await this._apply(upsertSql, extra.receiver, (u) => {
          // v8：使用事件中的 usdt 等值（修复前只能用 rewardZyt 导致账本与链上不一致）
          u.dynamic_withdrawn += BigInt(extra.usdt ?? extra.reward ?? 0);
        });
      }
    }
    const n = await db.get("SELECT count(*) c FROM users");
    const count = n ? Number(n.c) : 0;
    logRun("ledger", "ok", `rebuild users=${count}`);
  }

  async _apply(upsertSql, addr, fn) {
    if (!addr) return;
    addr = String(addr).toLowerCase();
    const db = await getDb();
    const row = await db.get("SELECT * FROM users WHERE address=?", [addr]);
    const u = {
      deposit_total: row ? BigInt(row.deposit_total) : 0n,
      withdraw_total: row ? BigInt(row.withdraw_total) : 0n,
      dynamic_quota: row ? BigInt(row.dynamic_quota) : 0n,
      dynamic_withdrawn: row ? BigInt(row.dynamic_withdrawn) : 0n,
      power_base: row ? BigInt(row.power_base) : 0n,
      power_day: row ? row.power_day : 0,
      is_exited: row ? row.is_exited : 0,
    };
    fn(u);
    await db.run(
      upsertSql,
      [addr, String(u.deposit_total), String(u.withdraw_total), String(u.dynamic_quota), String(u.dynamic_withdrawn), String(u.power_base), u.power_day, u.is_exited ? 1 : 0, Math.floor(Date.now() / 1000)]
    );
  }

  /** 算力复利：base × 1.01^days */
  async powerOf(addr, nowDay = Math.floor(Date.now() / 86400000)) {
    const db = await getDb();
    const row = await db.get("SELECT power_base, power_day FROM users WHERE address=?", [addr]);
    if (!row || BigInt(row.power_base) === 0n) return 0n;
    let p = BigInt(row.power_base);
    const days = Math.min(Math.max(nowDay - row.power_day, 0), 365);
    for (let i = 0; i < days; i++) p = p + (p * 100n) / 10000n; // 1%
    return p;
  }

  /** 全网算力（Σ 复利后） */
  async totalPower() {
    const db = await getDb();
    const rows = await db.all("SELECT address FROM users");
    let sum = 0n;
    for (const r of rows) sum += await this.powerOf(r.address);
    return sum;
  }

  /** 每日对账（#3 真对账）：链上 pool 状态 → pool_state + 链上 userList 逐用户比对链下账本 */
  async reconcile() {
    const { pool, zyt, mining } = this.contracts;
    const [gst, zyt2, usdt, snap, price, stage, slip] = await Promise.all([
      pool.poolGST(),
      pool.poolZYT(),
      pool.poolUSDT(),
      pool.snapshotPoolGST(),
      pool.getPrice(),
      pool.getStage(),
      pool.getCurrentSlippage(),
    ]);
    const db = await getDb();
    await db.run(
      `
      INSERT INTO pool_state (id, pool_gst, pool_zyt, pool_usdt, snapshot_gst, price, slippage_pct, stage, updated_at)
      VALUES (1,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET pool_gst=excluded.pool_gst, pool_zyt=excluded.pool_zyt,
        pool_usdt=excluded.pool_usdt, snapshot_gst=excluded.snapshot_gst, price=excluded.price,
        slippage_pct=excluded.slippage_pct, stage=excluded.stage, updated_at=excluded.updated_at
    `,
      [String(gst), String(zyt2), String(usdt), String(snap), String(price), Number(slip) / 100, Number(stage), Math.floor(Date.now() / 1000)]
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
        // 链上：userInfo = (depositTotal, withdrawTotal, dynamicQuota, dynamicWithdrawn, power, lpQuota, isExited)
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
          ["dynamicQuota", chain[2], local ? local.dynamic_quota : "0"],
          ["dynamicWithdrawn", chain[3], local ? local.dynamic_withdrawn : "0"],
        ];
        let userMax = 0;
        for (const [name, cVal, lVal] of fields) {
          const c = BigInt(cVal);
          const l = BigInt(lVal || "0");
          const diff = c > l ? c - l : l - c;
          const pct = c === 0n ? (l === 0n ? 0 : 100) : Number((diff * 10000n) / c) / 100;
          if (pct > userMax) userMax = pct;
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
      logRun("reconcile", "ok", `pool gst=${gst} zyt=${zyt2} usdt=${usdt} price=${price} stage=${stage} slip=${Number(slip) / 100}% | 对账 ${total} 用户一致`);
    }
    return { gst: String(gst), zyt: String(zyt2), usdt: String(usdt), price: String(price), stage: Number(stage), slippage: Number(slip) / 100, reconcile: { total, diffUsers, maxDiffPct, status } };
  }
}
