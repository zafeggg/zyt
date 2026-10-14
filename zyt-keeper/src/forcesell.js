import cron from "node-cron";
import { JsonRpcProvider, Contract, Wallet, formatEther } from "ethers";
import { CONFIG } from "./config.js";
import { getDb } from "./db.js";
import { logRun, notify } from "./alert.js";

/**
 * v9.2 卖币窗口链下追踪与到期结算
 *
 * 合约口径（ZYTForceSell，2026-10-13/14 拍板终版）：
 *   - 唯一卖币窗口：每月 14 日、28 日全天（北京时间 UTC+8）；窗口外真实卖出 revert
 *   - 当期额度 = 该窗口首次活动时的持币数量 × 档位，锁存于窗口内（不可多卖）
 *     档位：首期 20% / 常规 10% / 累计卖出达入金 60% 后 2%（档位由合约 tierBpsOf 给出，链下不重算）
 *   - 未卖足：次日凌晨（15 日 / 29 日）由 keeper 调 settleExpired 销毁差额，无宽限期
 *   - 转账视同卖出：计入当期已卖与首期进度；窗口外转账不阻断、不计入任何窗口
 *
 * 日历口径必须与合约 `ZYTForceSell._beijingDate`（Howard Hinnant civil_from_days，
 * 纯整数，z = (ts + 8h)/86400 + 719468）逐字一致，否则链上链下判定会分叉。
 *
 * 本模块职责：
 *   1) 纯函数（可单测、API 复用）：北京时间日期换算、窗口 id、阶段、当期额度/欠账推导
 *   2) ForceSellTracker：链上权威读取 → 写入 force_sell 表 → 风险预警 → 到期结算
 *   3) 结算调度：15/29 日凌晨 cron + 休眠唤醒兜底（合约按链上时间推导目标窗口，
 *      非结算日 pendingSettleWindow()=0 → 零操作，故兜底轮询安全）
 */

// ===================== 纯函数（可单测，API 复用） =====================

export const TZ_OFFSET_SEC = 8 * 3600; // 北京时间 UTC+8
export const DAY_SEC = 86400;

/** 基点常量（与合约一致，仅用于展示兜底；权威档位以合约 tierBpsOf 为准） */
export const TIER_FIRST_BPS = 2000;
export const TIER_STEP_BPS = 1000;
export const TIER_AFTER60_BPS = 200;

/** civil_from_days：自 1970-01-01 起的整数天数 → 公历（与合约同算法） */
function civilFromDays(z) {
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  return { y, m, d };
}

/** 时间戳 → 北京时间公历日期 */
export function beijingDate(tsSec) {
  const z = Math.floor((Number(tsSec) + TZ_OFFSET_SEC) / DAY_SEC) + 719468;
  return civilFromDays(z);
}

/** 卖币日窗口 id（形如 20261014 / 20261028）；非 14/28 日返回 0（与合约 _windowIdAt 同口径） */
export function windowIdOf(tsSec) {
  const { y, m, d } = beijingDate(tsSec);
  if (d === 14 || d === 28) return y * 10000 + m * 100 + d;
  return 0;
}

/** 该时刻所属北京日的 00:00（UTC 秒） */
export function beijingDayStart(tsSec) {
  const dayIdx = Math.floor((Number(tsSec) + TZ_OFFSET_SEC) / DAY_SEC);
  return dayIdx * DAY_SEC - TZ_OFFSET_SEC;
}

/** 该时刻所属北京日的 24:00（UTC 秒）＝ 次日 00:00 北京 */
export function beijingDayEnd(tsSec) {
  return beijingDayStart(tsSec) + DAY_SEC;
}

/** 待结算窗口 id：昨日为卖币日则返回其 id（与合约 _previousWindowId 同口径） */
export function pendingSettleWindowId(nowSec) {
  return windowIdOf(Number(nowSec) - DAY_SEC);
}

/** 自 nowSec 起（含当日）的下一个卖币日 */
export function nextWindowFrom(nowSec) {
  for (let i = 0; i <= 40; i++) {
    const t = Number(nowSec) + i * DAY_SEC;
    const id = windowIdOf(t);
    if (id) {
      return { windowId: id, startSec: beijingDayStart(t), endSec: beijingDayEnd(t), daysUntil: i };
    }
  }
  return null;
}

/**
 * 当前阶段（前端提醒与结算调度共用）
 * @returns {{phase:'open'|'pending'|'idle', windowId:number, endSec:number,
 *            nextWindowId:number, nextStartSec:number, daysUntilNext:number}}
 *   open    今日为卖币日（窗口开放中）
 *   pending 昨日为卖币日（今日 15/29，等待 keeper 结算）
 *   idle    既非卖币日也非结算日
 */
export function windowPhase(nowSec) {
  const now = Number(nowSec);
  const nx = nextWindowFrom(now);
  const nextWindowId = nx ? nx.windowId : 0;
  const nextStartSec = nx ? nx.startSec : 0;
  const daysUntilNext = nx ? nx.daysUntil : -1;

  const cur = windowIdOf(now);
  if (cur) {
    return {
      phase: "open",
      windowId: cur,
      endSec: beijingDayEnd(now),
      nextWindowId,
      nextStartSec,
      daysUntilNext,
    };
  }
  const pend = pendingSettleWindowId(now);
  if (pend) {
    return {
      phase: "pending",
      windowId: pend,
      endSec: beijingDayEnd(now - DAY_SEC),
      nextWindowId,
      nextStartSec,
      daysUntilNext,
    };
  }
  return {
    phase: "idle",
    windowId: 0,
    endSec: 0,
    nextWindowId,
    nextStartSec,
    daysUntilNext,
  };
}

/**
 * 推导当期额度与欠账（与合约 checkAndBurn / settleExpired 同口径）
 *
 * 合约口径：
 *   - 窗口内首次活动时锁存 quota = 转账前余额 × 档位；此后该窗口 sold 累加
 *   - 结算「目标窗口」时：若锁存窗口 == 目标窗口 → 用锁存 quota/sold；否则用「当前余额 × 档位」
 *     （该窗口无活动 ⇒ 余额自窗口起未变，两者等价）
 *
 * @param {object} p
 * @param {bigint} p.balance        当前持币
 * @param {number} p.tierBps        当期档位（合约 tierBpsOf）
 * @param {number} p.latchedWindowId 链上锁存窗口 id（0 = 无）
 * @param {bigint} p.latchedQuota   链上锁存额度
 * @param {bigint} p.latchedSold    链上该窗口已卖
 * @param {number} p.targetWindowId 要评估的窗口 id（open 阶段 = 当前窗口；pending 阶段 = 待结算窗口）
 */
export function computeWindowQuota({
  balance,
  tierBps,
  latchedWindowId,
  latchedQuota,
  latchedSold,
  targetWindowId,
}) {
  const bal = BigInt(balance ?? 0);
  const latched = Number(latchedWindowId ?? 0) === Number(targetWindowId) && Number(targetWindowId) !== 0;
  const quota = latched ? BigInt(latchedQuota ?? 0) : (bal * BigInt(tierBps || 0)) / 10000n;
  const sold = latched ? BigInt(latchedSold ?? 0) : 0n;
  const deficit = sold < quota ? quota - sold : 0n;
  const progressBps = quota > 0n ? Number((sold * 10000n) / quota) : 10000;
  return { latched, quota, sold, deficit, progressBps };
}

/**
 * 计算卖币窗口全量状态（纯函数，API 与追踪器共用）
 * @returns {{phase, windowId, endSec, nextWindowId, daysUntilNext, tierBps,
 *            quota, sold, deficit, atRisk, progressBps, deadlineSec}}
 *   deadlineSec：当前评估窗口的绝对截止时间戳（秒）；idle 阶段为 0。
 *               前端如需「剩余秒数」自行做 deadlineSec - now（v21 教训：勿把剩余秒数当时戳格式化）。
 */
export function computeForceSell({
  balance,
  tierBps,
  latchedWindowId,
  latchedQuota,
  latchedSold,
  nowSec,
}) {
  const ph = windowPhase(nowSec);
  let targetWindowId = 0;
  let deadlineSec = 0;
  if (ph.phase === "open") {
    targetWindowId = ph.windowId;
    deadlineSec = ph.endSec;
  } else if (ph.phase === "pending") {
    targetWindowId = ph.windowId;
    deadlineSec = ph.endSec; // 已过（窗口刚结束，等待销毁）
  }

  const q = computeWindowQuota({
    balance,
    tierBps,
    latchedWindowId,
    latchedQuota,
    latchedSold,
    targetWindowId,
  });

  // atRisk：评估窗口内未卖足。open = 今天还能卖；pending = 销毁迫在眉睫。
  const atRisk = targetWindowId !== 0 && q.deficit > 0n;

  return {
    ...ph,
    targetWindowId,
    tierBps: Number(tierBps || 0),
    quota: q.quota,
    sold: q.sold,
    deficit: q.deficit,
    latched: q.latched,
    progressBps: q.progressBps,
    atRisk,
    deadlineSec,
  };
}

// ===================== 追踪器 =====================

const FORCESELL_ABI = [
  // v9.2：窗口锁存（windowId, quota, sold）
  "function windows(address) view returns (uint256,uint256,uint256)",
  "function firstSellDone(address) view returns (bool)",
  "function initialized(address) view returns (bool)",
  "function tierBpsOf(address) view returns (uint256)",
  "function currentWindow() view returns (uint256,bool)",
  "function pendingSettleWindow() view returns (uint256)",
  "function windowSettled(address,uint256) view returns (bool)",
  "function keeper() view returns (address)",
];
/** 写通道 ABI（需签名钱包）：settleExpired 由合约销毁未卖足差额，链上不可逆 */
const FORCESELL_WRITE_ABI = [
  "function settleExpired(address) returns (uint256)",
  "event ForceSellBurned(address indexed user, uint256 amount, uint256 window)",
];
const ZYT_FS_ABI = [
  "function getUserCount() view returns (uint256)",
  "function getUserAt(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function sellInfo(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
];

export class ForceSellTracker {
  /** @param {object} [opts] 可注入 provider（测试用），默认自建 */
  constructor({ provider } = {}) {
    this.provider = provider ?? new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
    this.forceSell = new Contract(CONFIG.contracts.forceSell, FORCESELL_ABI, this.provider);
    this.zyt = new Contract(CONFIG.contracts.zyt, ZYT_FS_ABI, this.provider);
    this.cooldown = new Map(); // address -> 上次预警时间（防告警风暴）

    // 到期结算写通道：复用 KEEPER_PRIVATE_KEY（与每日快照同一钱包）。
    // 私钥缺失时结算降级为不执行，只读追踪与预警不受影响。
    this.settleSignerReady = false;
    this.settleSignerAddress = "";
    const pk = (CONFIG.keeper.privateKey || "").trim();
    if (pk) {
      try {
        const wallet = new Wallet(pk, this.provider);
        this.settleSignerAddress = wallet.address;
        this.forceSellWrite = new Contract(CONFIG.contracts.forceSell, FORCESELL_WRITE_ABI, wallet);
        this.settleSignerReady = true;
      } catch (e) {
        logRun("forcesell", "error", `settle private key invalid: ${e.message}`);
      }
    }
  }

  /**
   * 同步各用户卖币窗口状态入库。
   * 用户集合 = keeper 账本 users ∪ 链上 userList（并集去重）：
   *  - 账本覆盖全部入金用户（含只入金、未持币者，链上 userList 不含这类地址）
   *  - 链上 userList 兜底账本索引异常的情况
   */
  async syncOnce({ nowSec } = {}) {
    const db = await getDb();
    const addrSet = new Map();
    const rows = await db.all("SELECT address FROM users");
    for (const r of rows) if (r.address) addrSet.set(String(r.address).toLowerCase(), true);
    try {
      const n = Number(await this.zyt.getUserCount());
      for (let i = 0; i < n; i++) addrSet.set((await this.zyt.getUserAt(i)).toLowerCase(), true);
    } catch (e) {
      logRun("forcesell", "gap", `userList 读取失败，仅用账本用户: ${String(e.message).slice(0, 60)}`);
    }

    const now = Number(nowSec) || Math.floor(Date.now() / 1000);
    // 全局窗口状态只读一次（窗口为全局日历，与用户无关）
    const [chainCurWin] = await this.forceSell.currentWindow();
    const chainPendingWin = Number(await this.forceSell.pendingSettleWindow());
    const ph = windowPhase(now);
    const needTier = ph.phase === "open" || ph.phase === "pending";
    const targetWindowId = ph.phase === "idle" ? 0 : ph.windowId;

    let atRiskCount = 0;
    let scanned = 0;
    for (const addr of addrSet.keys()) {
      // 并行读链上权威数据：锁存窗口状态 + 余额（2 个 view）
      const [win, bal] = await Promise.all([
        this.forceSell.windows(addr),
        this.zyt.balanceOf(addr),
      ]);
      const latchedWindowId = Number(win[0]);
      const latchedQuota = BigInt(win[1]);
      const latchedSold = BigInt(win[2]);
      const balance = BigInt(bal);

      // 无余额且无窗口锁存 → 既无欠账可销毁也无额度可言，跳过（省 RPC，仍写入基础行）
      const noRisk = balance === 0n && latchedWindowId === 0;
      let tierBps = 0;
      let cs = null;
      let sellInfo = [0n, 0n, 0n, 0n, 0n, 0n];
      if (!noRisk) {
        [tierBps, sellInfo] = await Promise.all([
          needTier ? this.forceSell.tierBpsOf(addr) : Promise.resolve(0),
          this.zyt.sellInfo(addr),
        ]);
        cs = computeForceSell({
          balance,
          tierBps,
          latchedWindowId,
          latchedQuota,
          latchedSold,
          nowSec: now,
        });
        if (cs.atRisk) atRiskCount++;
        scanned++;
      }

      await db.run(
        `INSERT OR REPLACE INTO force_sell
         (address, window_id, phase, balance, target_bps, quota, sold_amount, deficit,
          deadline_sec, sell_count, total_sell, at_risk, updated_at, first_receive_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          addr,
          cs ? cs.targetWindowId : 0,
          cs ? cs.phase : ph.phase,
          String(balance),
          Number(tierBps || 0),
          String(cs ? cs.quota : 0n),
          String(cs ? cs.sold : 0n),
          String(cs ? cs.deficit : 0n),
          cs ? cs.deadlineSec : 0,
          Number(sellInfo[0]),
          String(sellInfo[1]),
          cs && cs.atRisk ? 1 : 0,
          now,
          Number(sellInfo[3]), // 首收时间（留档；v9.2 规则已不依赖它）
        ]
      );
    }
    logRun(
      "forcesell",
      "ok",
      `users=${addrSet.size} scanned=${scanned} atRisk=${atRiskCount} phase=${ph.phase} win=${chainCurWin} pending=${chainPendingWin}`
    );
    return { users: addrSet.size, scanned, atRisk: atRiskCount, phase: ph.phase };
  }

  /** 未卖足风险预警（每用户冷却，默认 1h） */
  async checkAlerts() {
    const db = await getDb();
    const rows = await db.all("SELECT * FROM force_sell WHERE at_risk=1");
    let alerted = 0;
    for (const row of rows) {
      const last = this.cooldown.get(row.address) || 0;
      if (Date.now() - last < CONFIG.forceSell.alertCooldownMs) continue;
      this.cooldown.set(row.address, Date.now());
      const quota = BigInt(row.quota || "0");
      const sold = BigInt(row.sold_amount || "0");
      const deficit = BigInt(row.deficit || "0");
      alerted++;
      const when = row.phase === "pending" ? "窗口已结束，销毁迫近" : "窗口开放中";
      logRun(
        "forcesell",
        "alert",
        `[${row.address.slice(0, 10)}] 窗口${row.window_id} ${when}：已卖 ${formatEther(sold)} / 额度 ${formatEther(quota)} ZYT，欠 ${formatEther(deficit)}`
      );
      await notify(
        `[ZYT ForceSell][风险] ${row.address.slice(0, 10)} 窗口${row.window_id} ${when}（已卖 ${formatEther(sold)} / 额度 ${formatEther(quota)} ZYT），未卖足部分将被销毁`
      );
    }
    if (alerted > 0) logRun("forcesell", "alert", `total=${alerted} risk users`);
    return alerted;
  }

  /**
   * 到期结算一轮：对「待结算窗口内未卖足」的用户调用合约 settleExpired。
   *
   * 三重保护：
   *   1. 开关（FORCESELL_SETTLE_ENABLED，默认关）
   *   2. 非结算日零操作：合约 pendingSettleWindow() === 0（昨日非 14/28 日）直接返回，
   *      因此本方法可安全地高频兜底轮询
   *   3. 本地预判 windowSettled(user, windowId)，已结算跳过（合约侧同样会拦，此处省 gas）
   * 单笔失败不阻断后续；每笔之间留 settleTxGapMs 间隔防 nonce 冲突。
   */
  async settleExpiredOnce() {
    const db = await getDb();
    if (!this.settleSignerReady) {
      logRun("forcesell", "error", "settle skipped: KEEPER_PRIVATE_KEY not configured");
      return { scanned: 0, settled: 0, burned: "0", skipped: 0, failed: 0, reason: "no-signer" };
    }

    // 非结算日：合约推导的目标窗口为 0 → 零操作（高频轮询安全）
    const pendingWin = Number(await this.forceSell.pendingSettleWindow());
    if (pendingWin === 0) {
      return { scanned: 0, settled: 0, burned: "0", skipped: 0, failed: 0, reason: "not-settle-day" };
    }

    // LIMIT 直接内联（纯数字，避免 SQLite/MySQL 方言对占位符的差异）
    const limit = Math.max(1, Number(CONFIG.forceSell.settleMaxPerRun) || 10);
    const rows = await db.all(
      `SELECT address FROM force_sell
       WHERE at_risk=1 AND window_id=${pendingWin}
       ORDER BY deficit DESC LIMIT ${limit}`
    );

    let settled = 0;
    let skipped = 0;
    let failed = 0;
    let burnedTotal = 0n;

    for (const row of rows) {
      const addr = row.address;
      try {
        // 预判：该用户该窗口是否已结算
        if (await this.forceSell.windowSettled(addr, pendingWin)) {
          skipped++;
          continue;
        }

        const tx = await this.forceSellWrite.settleExpired(addr);
        const receipt = await tx.wait();

        // 从 ForceSellBurned 事件解析本次销毁量（解析不到则记 0，交易哈希仍保留在日志）
        let burned = 0n;
        for (const lg of receipt.logs || []) {
          try {
            const parsed = this.forceSellWrite.interface.parseLog({ topics: lg.topics, data: lg.data });
            if (parsed && parsed.name === "ForceSellBurned") burned += BigInt(parsed.args[1]);
          } catch {
            /* 非本合约日志，忽略 */
          }
        }

        burnedTotal += burned;
        settled++;
        logRun(
          "forcesell",
          "settle",
          `[${addr.slice(0, 10)}] win=${pendingWin} burned=${formatEther(burned)} ZYT tx=${tx.hash}`
        );
        if (burned > 0n) {
          await notify(
            `[ZYT ForceSell][结算] ${addr.slice(0, 10)} 窗口${pendingWin} 未卖足，已自动销毁 ${formatEther(burned)} ZYT`
          );
        }
      } catch (e) {
        failed++;
        logRun("forcesell", "error", `settle ${addr.slice(0, 10)} failed: ${e.message}`);
      }

      if (CONFIG.forceSell.settleTxGapMs > 0) {
        await new Promise((r) => setTimeout(r, CONFIG.forceSell.settleTxGapMs));
      }
    }

    logRun(
      "forcesell",
      "ok",
      `settle win=${pendingWin} scanned=${rows.length} settled=${settled} skipped=${skipped} failed=${failed} burned=${formatEther(burnedTotal)}`
    );
    return { scanned: rows.length, settled, burned: burnedTotal.toString(), skipped, failed, windowId: pendingWin };
  }

  /**
   * 启动结算调度：15/29 日凌晨 cron + 休眠唤醒兜底
   * （node-cron 无 catch-up；合约允许在 15/29 日全天结算，故兜底轮询可在唤醒后补齐）
   */
  startScheduler() {
    if (this.settleCronTask) return;
    const expr = CONFIG.forceSell.settleCron;
    const tz = CONFIG.forceSell.settleCronTz;
    this.settleCronTask = cron.schedule(expr, () => this.settleExpiredOnce(), { timezone: tz });
    const gapMs = Number(CONFIG.forceSell.settleCatchUpMs) || 30 * 60_000;
    this.settleCatchUpTimer = setTimeout(() => this.settleExpiredOnce(), 60_000);
    this.settleCatchUpInterval = setInterval(() => this.settleExpiredOnce(), gapMs);
    logRun("forcesell", "start", `settle cron="${expr}" tz=${tz} catchUp=${gapMs}ms`);
  }

  stopScheduler() {
    if (this.settleCronTask) this.settleCronTask.stop();
    if (this.settleCatchUpTimer) clearTimeout(this.settleCatchUpTimer);
    if (this.settleCatchUpInterval) clearInterval(this.settleCatchUpInterval);
  }
}
