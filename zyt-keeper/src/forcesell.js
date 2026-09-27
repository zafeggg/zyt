import { JsonRpcProvider, Contract, Wallet, formatEther } from "ethers";
import { CONFIG } from "./config.js";
import { getDb } from "./db.js";
import { logRun, notify } from "./alert.js";

/**
 * 强制卖出窗口链下追踪（生产缺口 #7）
 *
 * 与 ZYTForceSell 合约同款参数（口径 2026-09-22 用户确认）：
 *   4×15 天窗口，累计应卖目标（基点）：20% / 30% / 40% / 50%
 *   （每期最低卖出 20% / 10% / 10% / 10%，逐期累计）
 *   required = 当前余额 × 累计目标 / 10000（与合约 checkAndBurn 公式一致）
 *   窗口到期未卖足 → 链上转账时差额自动销毁（atRisk 预警该风险）
 *
 * 数据源：链上权威（ZYTToken.userList 遍历 + ZYTForceSell 视图），不依赖事件重建。
 * 写入 force_sell 表供前端 /force-sell/:addr 查询（#8 前端接 API 数据源）。
 */

// ===================== 纯函数（可单测，API 复用） =====================

export const FS_WINDOW_SEC = 15 * 86400; // 15 天
/** 各窗口累计应卖目标（基点）：窗口1=20%、窗口2=30%、窗口3=40%、窗口4=50% */
export const FS_CUM_TARGETS = [2000, 3000, 4000, 5000];

/**
 * 根据 elapsed 计算当前窗口信息（纯函数）
 * @param {number} elapsedSec 距首次收币的秒数
 * @returns {{window: number, cumBps: number, deadline: number}}
 *   window: 0=未到期 / 1-4=当前窗口；cumBps=累计应卖目标基点；deadline=距下窗口截止秒（0=已结束）
 */
export function windowInfo(elapsedSec) {
  if (elapsedSec < FS_WINDOW_SEC) return { window: 0, cumBps: 0, deadline: FS_WINDOW_SEC - elapsedSec };
  if (elapsedSec < 2 * FS_WINDOW_SEC) return { window: 1, cumBps: FS_CUM_TARGETS[0], deadline: 2 * FS_WINDOW_SEC - elapsedSec };
  if (elapsedSec < 3 * FS_WINDOW_SEC) return { window: 2, cumBps: FS_CUM_TARGETS[1], deadline: 3 * FS_WINDOW_SEC - elapsedSec };
  if (elapsedSec < 4 * FS_WINDOW_SEC) return { window: 3, cumBps: FS_CUM_TARGETS[2], deadline: 4 * FS_WINDOW_SEC - elapsedSec };
  return { window: 4, cumBps: FS_CUM_TARGETS[3], deadline: 0 };
}

/**
 * 计算强制卖出状态（纯函数，与合约公式一致）
 * @param {bigint} balance 当前余额
 * @param {bigint} soldAmount 累计已卖（含转账视同卖出）
 * @param {number} firstReceiveAt 首次收币时间戳（秒）
 * @param {number} nowSec 当前时间戳（秒）
 * @returns {{window:number, cumBps:number, deadline:number, elapsed:number, required:bigint, atRisk:boolean, progressBps:number}}
 */
export function computeForceSell(balance, soldAmount, firstReceiveAt, nowSec) {
  // 未首次收币（firstReceiveAt=0）：不进入强制卖出规则。
  // 2026-09-26 修复：原实现 elapsed = nowSec - 0 得到当前时间戳（约 17.9 亿秒），
  //   被 windowInfo 误判为「已过第 4 窗口、累计应卖 50%」，前端对纯入金用户显示错误的窗口与目标。
  if (!firstReceiveAt || firstReceiveAt <= 0) {
    return { window: 0, cumBps: 0, deadline: 0, elapsed: 0, required: 0n, atRisk: false, progressBps: 10000 };
  }
  const elapsed = nowSec - firstReceiveAt;
  const wi = windowInfo(elapsed);
  const required = (balance * BigInt(wi.cumBps)) / 10000n;
  // atRisk：已进入强制窗口（≥15 天）且累计卖出 < 应卖量（继续持有将在下次转账/窗口结算时被销毁）
  const atRisk = wi.window >= 1 && soldAmount < required;
  // 进度（基点）：应卖量=0（未到期）时视为已完成
  const progressBps = required > 0n ? Number((soldAmount * 10000n) / required) : 10000;
  return { ...wi, elapsed, required, atRisk, progressBps };
}

// ===================== 追踪器 =====================

const FORCESELL_ABI = [
  "function firstReceiveTime(address) view returns (uint256)",
  "function soldAmount(address) view returns (uint256)",
  "function initialized(address) view returns (bool)",
  // 到期结算相关（读）：settledWindows 为位图，第 n 位置位表示第 n+1 个窗口已结算
  "function settledWindows(address) view returns (uint256)",
  "function keeper() view returns (address)",
];
/** 写通道 ABI（需签名钱包）：settleExpired 由合约销毁未卖足差额，链上不可逆 */
const FORCESELL_WRITE_ABI = [
  "function settleExpired(address) returns (uint256)",
  // 结算事件（用于解析本次销毁量）
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
   * 同步各用户强制卖出状态入库。
   * 用户集合 = keeper 账本 users ∪ 链上 userList（并集去重）：
   *  - 账本覆盖全部入金用户（含只入金、未持币者，链上 userList 不含这类地址）
   *  - 链上 userList 兜底账本索引异常的情况
   * 2026-09-26 修改：原实现仅遍历 userList，导致无持币记录的入金用户在前端显示 no-data。
   */
  async syncOnce() {
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
    const now = Math.floor(Date.now() / 1000);
    let atRiskCount = 0;
    for (const addr of addrSet.keys()) {
      // 并行读链上权威数据（4 个 view 调用）
      const [firstReceive, sold, bal, sellInfo] = await Promise.all([
        this.forceSell.firstReceiveTime(addr),
        this.forceSell.soldAmount(addr),
        this.zyt.balanceOf(addr),
        this.zyt.sellInfo(addr),
      ]);
      const cs = computeForceSell(bal, sold, Number(firstReceive), now);
      if (cs.atRisk) atRiskCount++;
      await db.run(
        `INSERT OR REPLACE INTO force_sell
         (address, first_receive_at, sold_amount, balance, current_window, target_bps,
          required_sell, sell_count, total_sell, at_risk, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          addr,
          Number(firstReceive),
          String(sold),
          String(bal),
          cs.window,
          cs.cumBps,
          String(cs.required),
          Number(sellInfo[0]),
          String(sellInfo[1]),
          cs.atRisk ? 1 : 0,
          now,
        ]
      );
    }
    logRun("forcesell", "ok", `users=${addrSet.size} atRisk=${atRiskCount}`);
    return { users: addrSet.size, atRisk: atRiskCount };
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
      const required = BigInt(row.required_sell || "0");
      const sold = BigInt(row.sold_amount || "0");
      alerted++;
      logRun("forcesell", "alert", `[${row.address.slice(0, 10)}] 窗口${row.current_window} 未卖足：已卖 ${formatEther(sold)} / 应卖 ${formatEther(required)} ZYT`);
      await notify(
        `[ZYT ForceSell][风险] ${row.address.slice(0, 10)} 窗口${row.current_window} 未卖足（已卖 ${formatEther(sold)} / 应卖 ${formatEther(required)} ZYT），继续持有将触发自动销毁`
      );
    }
    if (alerted > 0) logRun("forcesell", "alert", `total=${alerted} risk users`);
    return alerted;
  }

  /**
   * 到期结算一轮：对已到期且未卖足的用户调用合约 settleExpired，由合约销毁差额。
   *
   * 数据源为 force_sell 表（由 syncOnce 按链上权威写入），此处不再二次遍历 userList。
   * 三重保护：
   *   1. 开关（FORCESELL_SETTLE_ENABLED，默认关，需显式开启）
   *   2. 单轮上限 settleMaxPerRun，控 gas 支出
   *   3. 本地预判 settledWindows 位图，已结算窗口跳过（合约侧同样会拦，此处省 gas）
   * 单笔失败不阻断后续；每笔之间留 settleTxGapMs 间隔防 nonce 冲突。
   *
   * @returns {Promise<{scanned:number, settled:number, burned:string, skipped:number, failed:number}>}
   */
  async settleExpiredOnce() {
    const db = await getDb();
    if (!this.settleSignerReady) {
      const msg = "settle skipped: KEEPER_PRIVATE_KEY not configured";
      logRun("forcesell", "error", msg);
      return { scanned: 0, settled: 0, burned: "0", skipped: 0, failed: 0 };
    }

    // 只取已到期（current_window >= 1）且在风险中的用户；先到期的优先结算。
    // LIMIT 值直接内联（纯数字，避免 SQLite/MySQL 方言对占位符的差异）。
    const limit = Math.max(1, Number(CONFIG.forceSell.settleMaxPerRun) || 10);
    const rows = await db.all(
      `SELECT address, current_window FROM force_sell
       WHERE at_risk=1 AND current_window >= 1
       ORDER BY first_receive_at ASC LIMIT ${limit}`
    );

    let settled = 0;
    let skipped = 0;
    let failed = 0;
    let burnedTotal = 0n;

    for (const row of rows) {
      const addr = row.address;
      const win = Number(row.current_window);
      try {
        // 预判：位图第 (win-1) 位置位表示该窗口已结算
        const mask = await this.forceSell.settledWindows(addr);
        if ((BigInt(mask) & (1n << BigInt(win - 1))) !== 0n) {
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
          `[${addr.slice(0, 10)}] win=${win} burned=${formatEther(burned)} ZYT tx=${tx.hash}`
        );
        if (burned > 0n) {
          await notify(
            `[ZYT ForceSell][结算] ${addr.slice(0, 10)} 窗口${win} 未卖足，已自动销毁 ${formatEther(burned)} ZYT`
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
      `settle scanned=${rows.length} settled=${settled} skipped=${skipped} failed=${failed} burned=${formatEther(burnedTotal)}`
    );
    return { scanned: rows.length, settled, burned: burnedTotal.toString(), skipped, failed };
  }
}
