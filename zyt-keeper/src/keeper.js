import cron from "node-cron";
import { JsonRpcProvider, Contract, Wallet } from "ethers";
import { CONFIG } from "./config.js";
import { getDb } from "./db.js";
import { logRun, notify } from "./alert.js";
import { lock } from "./lock.js";
import { Ledger } from "./ledger.js";
import { DEFLATION_IFACE } from "./abis.js";

const DEFLATION_ABI = [
  "function dailySnapshot(uint256 totalPower)",
  "function lastSnapshotDay() view returns (uint256)",
];
const POOL_VIEW_ABI = [
  "function poolGST() view returns (uint256)",
  "function poolZYT() view returns (uint256)",
  "function poolUSDT() view returns (uint256)",
  "function snapshotPoolGST() view returns (uint256)",
  "function getPrice() view returns (uint256)",
  "function getStage() view returns (uint256)",
  "function getCurrentSlippage() view returns (uint256)",
  "function dividendPool() view returns (uint256)",
];

/**
 * Keeper 快照机器人：每日 08:00（北京时间）触发每日快照/通缩/产出释放。
 * - 全网算力由链下账本统计后传入合约
 * - v8：签名钱包接入 —— 写交易（dailySnapshot）必须由 KEEPER_PRIVATE_KEY 签名；
 *       私钥地址仅作「定时触发器」，合约不向其授权资金操作；缺失私钥时拒绝执行并告警
 * - 失败自动重试 + 补快照
 */
export class Keeper {
  constructor() {
    this.provider = new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
    // v8：签名钱包（生产必须配置；本地无私钥时降级为只读并告警）
    this.signerReady = false;
    this.signerAddress = "";
    const pk = CONFIG.keeper.privateKey.trim();
    if (pk) {
      try {
        const wallet = new Wallet(pk, this.provider);
        this.signerAddress = wallet.address;
        this.deflation = new Contract(CONFIG.contracts.deflation, DEFLATION_ABI, wallet);
        this.signerReady = true;
      } catch (e) {
        logRun("keeper", "error", `private key invalid: ${e.message}`);
      }
    }
    if (!this.signerReady) {
      // 只读实例（查询 lastSnapshotDay 等仍可用）
      this.deflation = new Contract(CONFIG.contracts.deflation, DEFLATION_ABI, this.provider);
    }
    this.ledger = new Ledger(this.provider, {
      pool: new Contract(CONFIG.contracts.pool, POOL_VIEW_ABI, this.provider),
      zyt: new Contract(CONFIG.contracts.zyt, ["function getUserCount() view returns (uint256)", "function getUserAt(uint256) view returns (address)"], this.provider),
      mining: new Contract(CONFIG.contracts.mining, ["function userInfo(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool)"], this.provider),
    });
    this.lock = false;
  }

  /** 执行一次每日快照（含重试） */
  async runSnapshot({ force = false } = {}) {
    if (this.lock) return;
    this.lock = true;
    const db = await getDb();
    const day = Math.floor(Date.now() / 86400000);
    try {
      // v8：签名钱包必须就绪（写交易无法匿名执行）
      if (!this.signerReady) {
        const msg = "keeper private key not configured (KEEPER_PRIVATE_KEY)";
        logRun("keeper", "error", msg);
        await notify(`[ZYT Keeper] ${msg}`);
        return;
      }
      // v8：双实例互斥锁（Redis SETNX / 文件锁降级）——防多实例重复触发
      const lockKey = "daily-snapshot";
      const got = await lock.acquire(lockKey, CONFIG.keeper.lockTtlMs);
      if (!got) {
        logRun("keeper", "skip", `lock "${lockKey}" held by another instance`);
        return;
      }
      try {
        await this._runSnapshotInternal({ force });
      } finally {
        await lock.release(lockKey);
      }
    } catch (e) {
      logRun("keeper", "error", e.message);
      await notify(`[ZYT Keeper] 每日快照失败: ${e.message}`);
    } finally {
      this.lock = false;
    }
  }

  /** 快照执行体（持有互斥锁期间运行） */
  async _runSnapshotInternal({ force }) {
    const db = await getDb();
    const day = Math.floor(Date.now() / 86400000);
    // 防重复：同日已跑过（force 可覆盖，用于补快照）
    const last = await db.get("SELECT day FROM snapshots ORDER BY day DESC LIMIT 1");
    if (!force && last && Number(last.day) >= day) {
      logRun("keeper", "skip", `day ${day} already snapshotted`);
      return;
    }
    const totalPower = await this.ledger.totalPower();
    const errors = [];
    for (let attempt = 1; attempt <= CONFIG.keeper.retryTimes; attempt++) {
      try {
        // 由签名钱包发出（gas 自动估算；hardhat 节点勿显式超 cap）
        const tx = await this.deflation.dailySnapshot(totalPower);
        await tx.wait();
        // 记录快照
        const dayOnChain = await this.deflation.lastSnapshotDay();
        await db.run(
          "INSERT OR REPLACE INTO snapshots (day, total_power, created_at) VALUES (?,?,?)",
          [String(dayOnChain), String(totalPower), Math.floor(Date.now() / 1000)]
        );
        await this.ledger.reconcile();
        logRun("keeper", "ok", `snapshot day=${dayOnChain} totalPower=${totalPower} signer=${this.signerAddress}`);
        return;
      } catch (e) {
        errors.push(e.message);
        logRun("keeper", "retry", `attempt ${attempt}: ${e.message}`);
        if (attempt < CONFIG.keeper.retryTimes) {
          await new Promise((r) => setTimeout(r, CONFIG.keeper.retryDelayMs));
        }
      }
    }
    throw new Error(errors.join(" | "));
  }

  start() {
    const expr = CONFIG.keeper.snapshotCron;
    cron.schedule(expr, () => this.runSnapshot());
    const signerState = this.signerReady
      ? `signer=${this.signerAddress}`
      : "signer=NOT_CONFIGURED (写交易将拒绝)";
    logRun("keeper", "start", `cron="${expr}" (${Intl.DateTimeFormat().resolvedOptions().timeZone}) ${signerState}`);
  }
}
