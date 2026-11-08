import cron from "node-cron";
import { JsonRpcProvider, Contract, Wallet } from "ethers";
import { CONFIG } from "./config.js";
import { getDb } from "./db.js";
import { logRun, notify } from "./alert.js";
import { lock } from "./lock.js";
import { Ledger } from "./ledger.js";
import { DEFLATION_IFACE, MINING_USERINFO_ABI } from "./abis.js";

const DEFLATION_ABI = [
  "function dailySnapshot(uint256 totalPower)",
  "function lastSnapshotDay() view returns (uint256)",
];
const POOL_VIEW_ABI = [
  "function poolZYT() view returns (uint256)",
  "function poolUSDT() view returns (uint256)",
  "function getPrice() view returns (uint256)",
  "function getStage() view returns (uint256)",
  "function getCurrentSlippage() view returns (uint256)",
  "function dividendPoolZyt() view returns (uint256)",
];

/**
 * Keeper 快照机器人：每日 08:01（北京时间）触发每日快照/通缩/产出释放。
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
      mining: new Contract(CONFIG.contracts.mining, MINING_USERINFO_ABI, this.provider),
    });
    this.lock = false;
  }

  /** 执行一次每日快照（含重试） */
  async runSnapshot({ force = false } = {}) {
    // 2026-09-26：通缩暂停开关（SNAPSHOT_SKIP_BEFORE_DAY，day 口径 = UTC 天数，与链上一致）。
    // currentDay ≤ 该值时整体跳过快照，cron / 启动 30s 自检 / 10min 自检三条路径统一拦截；
    // 到期自动恢复执行，无需改代码或人工干预。用途：无用户期暂停通缩，避免销毁与分红空转损耗。
    const skipBefore = Number(process.env.SNAPSHOT_SKIP_BEFORE_DAY || 0);
    if (skipBefore > 0) {
      const currentDay = Math.floor(Date.now() / 86400000);
      if (currentDay <= skipBefore) {
        logRun("keeper", "skip", `snapshot paused (day=${currentDay} ≤ SNAPSHOT_SKIP_BEFORE_DAY=${skipBefore})`);
        return;
      }
    }
    if (this.lock) return;
    this.lock = true;
    const db = await getDb();
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
    // 2026-09-26：day 以链上时间为准（与合约 block.timestamp/86400 同源），读块失败回退本地时间。
    // 目的：totalPower 的计算口径必须与合约写入的 dailyInfo[day] 完全对齐（分红公式分母）。
    let day;
    try {
      const latest = await this.provider.getBlock("latest");
      day = Math.floor(Number(latest.timestamp) / 86400);
    } catch {
      day = Math.floor(Date.now() / 86400000);
    }
    // 防重复：同日已跑过（force 可覆盖，用于补快照）
    const last = await db.get("SELECT day FROM snapshots ORDER BY day DESC LIMIT 1");
    if (!force && last && Number(last.day) >= day) {
      logRun("keeper", "skip", `day ${day} already snapshotted`);
      return;
    }
    // 2026-11-08：本地 snapshots 表可能漏记（人工补发 / 写库失败），发送前先对一次链上权威值。
    // 事故表现：链上 day 20765 已完成，本地表最新只到 20764，启动自检于是对着已快照的日子发交易，
    // 被合约 revert "Deflation: once per day"，每天启动都白跑一次 gas 估算并留下噪音告警。
    // 处理：链上已有则直接跳过，并把缺失的那几条补回本地表，让两边对齐。
    if (!force) {
      let chainDay = 0;
      try {
        chainDay = Number(await this.deflation.lastSnapshotDay());
      } catch (e) {
        logRun("keeper", "warn", `read lastSnapshotDay failed: ${String(e.message).slice(0, 60)}`);
      }
      if (chainDay >= day) {
        if (!last || Number(last.day) < chainDay) {
          // 补充本地记录：total_power 取链上 dailyInfo，读不到就写 0（不影响已完成的链上结算）
          let tp = "0";
          try {
            const di = await this.ledger.contracts.mining.dailyInfo(chainDay);
            tp = String(di[0]);
          } catch {
            /* 读失败保持 0 */
          }
          await db.run("INSERT OR REPLACE INTO snapshots (day, total_power, created_at) VALUES (?,?,?)", [
            chainDay,
            tp,
            Math.floor(Date.now() / 1000),
          ]);
          logRun("keeper", "ok", `snapshots 表补齐 day=${chainDay}（链上已快照，本地缺记录）`);
        }
        logRun("keeper", "skip", `chain already snapshotted day=${chainDay}`);
        return;
      }
    }
    // 分红分母口径：传本次将要写入的 day，使 totalPower === Σ _powerOf(user, day)
    const totalPower = await this.ledger.totalPower(day);
    const errors = [];
    for (let attempt = 1; attempt <= CONFIG.keeper.retryTimes; attempt++) {
      try {
        // 由签名钱包发出（gas 自动估算；hardhat 节点勿显式超 cap）
        const tx = await this.deflation.dailySnapshot(totalPower);
        await tx.wait();
        // 记录快照
        const dayOnChain = await this.deflation.lastSnapshotDay();
        if (Number(dayOnChain) !== Number(day)) {
          // 交易打包跨日（或链上时间与本地不一致）时告警：本次 totalPower 按 day 计算，链上记为 dayOnChain
          logRun("keeper", "gap", `快照日不一致：预期 day=${day} / 链上 day=${dayOnChain}，本次 totalPower 口径需复核`);
        }
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
    // v10：显式指定 cron 时区为 UTC（"1 0 * * *" = 北京 08:01），防系统时区漂移；
    // 保留 task 引用防 GC 导致定时任务丢失
    this.cronTask = cron.schedule(expr, () => this.runSnapshot(), {
      timezone: CONFIG.keeper.snapshotCronTz,
    });
    // v9.1 防漏自检（2026-09-25）：node-cron 无 catch-up，系统睡眠/休眠会直接跳过当日调度点
    // （实测：昨晚 19:04 睡眠今晨 09:01 唤醒，08:01 快照丢失且不再触发）。
    // 启动后 30s + 每 10min 调 runSnapshot 兜底——runSnapshot 幂等（同日已快照自动 skip + DB 锁防重），
    // 唤醒后最多 10 分钟内自动补跑。
    this.catchUpTimer = setTimeout(() => this.runSnapshot(), 30_000);
    this.catchUpInterval = setInterval(() => this.runSnapshot(), 10 * 60_000);
    // 2026-11-07：keeper_runs 自动清理（保留 7 天）
    // 事故背景：该表无索引、无清理策略，线上累积 245075 行 / 21.6MB。
    //   monitor 与 ledger 每轮都写入一条，高频小事务在磁盘写满时进一步加剧提交拥塞。
    //   启动 60s 后跑一次，之后每 24h 一次；失败只告警，不阻断快照主流程。
    this.pruneTimer = setTimeout(() => this.cleanupRuns(), 60_000);
    this.pruneInterval = setInterval(() => this.cleanupRuns(), 24 * 3600_000);
    const signerState = this.signerReady
      ? `signer=${this.signerAddress}`
      : "signer=NOT_CONFIGURED (写交易将拒绝)";
    logRun("keeper", "start", `cron="${expr}" tz=${CONFIG.keeper.snapshotCronTz} ${signerState}`);
  }

  /**
   * 清理 keeper_runs 历史记录（2026-11-07 新增）
   * - 保留最近 7 天，超过则删除
   * - 分批 2 万条：先用 LIMIT/OFFSET 取边界 id，再按 id 区间删，
   *   避免单事务删除几十万行造成长事务锁表与 undo 膨胀
   * - MySQL 与内存 SQLite 双后端兼容（LIMIT 值直接内联常量，无注入风险）
   */
  async cleanupRuns() {
    try {
      const db = await getDb();
      const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
      const BATCH = 20000;
      let removed = 0;
      for (let i = 0; i < 50; i++) {
        const edge = await db.get(
          `SELECT id FROM keeper_runs WHERE created_at < ? ORDER BY id LIMIT 1 OFFSET ${BATCH}`,
          [cutoff]
        );
        if (!edge) {
          // 剩余不足一批，一次删净
          const r = await db.run("DELETE FROM keeper_runs WHERE created_at < ?", [cutoff]);
          removed += Number(r?.affectedRows || 0);
          break;
        }
        const r = await db.run("DELETE FROM keeper_runs WHERE created_at < ? AND id < ?", [cutoff, edge.id]);
        removed += Number(r?.affectedRows || 0);
      }
      if (removed > 0) logRun("keeper", "ok", `keeper_runs pruned: ${removed} rows (keep 7d)`);
    } catch (e) {
      logRun("keeper", "error", `prune keeper_runs: ${String(e.message).slice(0, 100)}`);
    }
  }

  stop() {
    if (this.cronTask) this.cronTask.stop();
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    if (this.catchUpInterval) clearInterval(this.catchUpInterval);
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    if (this.pruneInterval) clearInterval(this.pruneInterval);
  }
}
