import { JsonRpcProvider, Contract, formatEther } from "ethers";
import { CONFIG } from "./config.js";
import { getDb } from "./db.js";
import { logRun, notify } from "./alert.js";

/**
 * 强制卖出窗口链下追踪（生产缺口 #7）
 *
 * 与 ZYTForceSell 合约同款参数：
 *   4×15 天窗口，累计应卖目标（基点）：20% / 30% / 40% / 60%
 *   required = 当前余额 × 累计目标 / 10000（与合约 checkAndBurn 公式一致）
 *   窗口到期未卖足 → 链上转账时差额自动销毁（atRisk 预警该风险）
 *
 * 数据源：链上权威（ZYTToken.userList 遍历 + ZYTForceSell 视图），不依赖事件重建。
 * 写入 force_sell 表供前端 /force-sell/:addr 查询（#8 前端接 API 数据源）。
 */

// ===================== 纯函数（可单测，API 复用） =====================

export const FS_WINDOW_SEC = 15 * 86400; // 15 天
/** 各窗口累计应卖目标（基点）：窗口1=20%、窗口2=30%、窗口3=40%、窗口4=60% */
export const FS_CUM_TARGETS = [2000, 3000, 4000, 6000];

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
  }

  /** 遍历链上 userList 同步各用户强制卖出状态入库 */
  async syncOnce() {
    const db = await getDb();
    const n = Number(await this.zyt.getUserCount());
    const now = Math.floor(Date.now() / 1000);
    let atRiskCount = 0;
    for (let i = 0; i < n; i++) {
      const addr = (await this.zyt.getUserAt(i)).toLowerCase();
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
    logRun("forcesell", "ok", `users=${n} atRisk=${atRiskCount}`);
    return { users: n, atRisk: atRiskCount };
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
}
