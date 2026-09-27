import { Indexer } from "./indexer.js";
import { Keeper } from "./keeper.js";
import { startApi } from "./api.js";
import { Ledger } from "./ledger.js";
import { Monitor } from "./monitor.js";
import { ForceSellTracker } from "./forcesell.js";
import { JsonRpcProvider, Contract, FetchRequest } from "ethers";
import { CONFIG } from "./config.js";
import { POOL_VIEW_ABI, MINING_USERINFO_ABI } from "./abis.js";
import { lock } from "./lock.js";
import { logRun } from "./alert.js";

/**
 * 众赢币 ZYT 链下服务主入口：
 * 1. 索引器：事件轮询入库
 * 2. 账本：事件重放重建用户状态
 * 3. Keeper：每日 08:01 快照（签名钱包 + 双实例互斥锁）
 * 4. 监控：规则引擎（底池突变/大额卖出/滑点跳变/索引延迟/失败率）
 * 5. 强制卖出追踪：4×15 天窗口应卖量/风险状态（链上权威遍历）
 * 6. API：数据查询
 */

// 退出时释放互斥锁与 Redis 连接（防崩溃残留死锁）
process.on("exit", () => {
  lock.dispose().catch(() => {});
});
process.on("SIGINT", () => {
  lock.dispose().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  lock.dispose().then(() => process.exit(0));
});
async function main() {
  logRun("service", "start", `chain=${CONFIG.chainId} rpc=${CONFIG.rpc}`);

  // 2026-09-26：provider 加单请求超时（FetchRequest.timeout）。
  // 背景：主网公共 RPC（blockrazor 等）偶发单请求无响应挂起，ethers 默认无超时会
  //       永久等下去，把整个 keeper 拖死（本次部署与 keeper 初次同步均踩此坑）。
  // batchMaxCount=1 禁批处理：避免单点超时拖垮整批请求。
  const _req = new FetchRequest(CONFIG.rpc);
  _req.timeout = 20000;
  const provider = new JsonRpcProvider(_req, CONFIG.chainId, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  const pool = new Contract(CONFIG.contracts.pool, POOL_VIEW_ABI, provider);
  const zyt = new Contract(CONFIG.contracts.zyt, ["function getUserCount() view returns (uint256)", "function getUserAt(uint256) view returns (address)"], provider);
  const mining = new Contract(CONFIG.contracts.mining, MINING_USERINFO_ABI, provider);
  // v17：对账参数校准用（staticExitMul）；config 地址未配置时为 null，ledger 沿用环境变量默认值
  const configC = CONFIG.contracts.config
    ? new Contract(CONFIG.contracts.config, ["function staticExitMul() view returns (uint256)"], provider)
    : null;

  // 1+2. 索引 + 账本
  // 监控引擎先行创建（indexer 事件回调需要引用它），再注入 indexer（R4 需要 lastBlock）
  const monitor = new Monitor({ provider, pool });
  const indexer = new Indexer({ onEvent: (name, args) => monitor.onEvent(name, args) });
  monitor.setIndexer(indexer);
  const ledger = new Ledger(provider, { pool, zyt, mining, config: configC });
  // 2026-09-26：初始同步与账本首建改为后台执行（不阻塞 api / monitor / keeper 上线）。
  // 背景：主网初次全量同步需数分钟，原 `await indexer.syncOnce()` 阻塞式启动会让服务
  //       长时间不可用；配合 provider 20 秒超时，单批挂起会在下一轮轮询自愈。
  //       events 表 INSERT OR IGNORE 幂等，并发安全；ledger 每 30 秒周期 rebuild 会补齐账本。
  indexer.start();
  ledger.rebuild().catch((e) => logRun("ledger", "error", e.message));
  // 事件入库后周期性重建账本（MVP：每次轮询后重建，数据量小）
  setInterval(async () => {
    try {
      await ledger.rebuild();
    } catch (e) {
      logRun("ledger", "error", e.message);
    }
  }, CONFIG.indexer.pollIntervalMs);

  // 3. Keeper
  const keeper = new Keeper();
  keeper.start();

  // 4. 监控规则引擎（周期检查 R1/R3/R4/R5；R2 走事件回调）
  if (CONFIG.monitor.enabled) {
    const check = () => monitor.checkOnce().catch((e) => logRun("monitor", "error", e.message));
    setTimeout(check, 5000); // 启动 5s 后跑一次（先记基线）
    setInterval(check, CONFIG.monitor.intervalMs);
    logRun("monitor", "start", `interval=${CONFIG.monitor.intervalMs}ms rules=R1/R2/R3/R4/R5`);
  }

  // 5. 强制卖出窗口追踪（链上权威遍历 userList；未卖足预警）
  if (CONFIG.forceSell.enabled && CONFIG.contracts.forceSell) {
    const fsTracker = new ForceSellTracker({ provider });
    const fsSync = () =>
      fsTracker
        .syncOnce()
        .then(() => fsTracker.checkAlerts())
        .catch((e) => logRun("forcesell", "error", e.message));
    setTimeout(fsSync, 6000); // 启动 6s 后首次同步
    setInterval(fsSync, CONFIG.forceSell.syncIntervalMs);
    logRun("forcesell", "start", `interval=${CONFIG.forceSell.syncIntervalMs}ms`);

    // 5b. 到期结算：补需求「未执行后果：自动销毁」的调度方。
    // 对已到期且未卖足的用户调用 ZYTForceSell.settleExpired，由合约销毁差额（不可逆）。
    // 默认关闭，需 FORCESELL_SETTLE_ENABLED=true 显式开启。
    // 数据源是 syncOnce 写入的 force_sell 表，故启动时刻错开。
    if (CONFIG.forceSell.settleEnabled) {
      const fsSettle = () =>
        fsTracker.settleExpiredOnce().catch((e) => logRun("forcesell", "error", `settle: ${e.message}`));
      setTimeout(fsSettle, 30_000); // 启动 30s 后首轮（等首轮 sync 落库）
      setInterval(fsSettle, CONFIG.forceSell.settleIntervalMs);
      const signerState = fsTracker.settleSignerReady
        ? `signer=${fsTracker.settleSignerAddress}`
        : "signer=NOT_CONFIGURED (结算将拒绝执行)";
      logRun(
        "forcesell",
        "start",
        `settle interval=${CONFIG.forceSell.settleIntervalMs}ms maxPerRun=${CONFIG.forceSell.settleMaxPerRun} ${signerState}`
      );
    } else {
      logRun("forcesell", "skip", "settle disabled (set FORCESELL_SETTLE_ENABLED=true to enable)");
    }
  } else {
    logRun("forcesell", "skip", "disabled or FORCESELL_ADDR not set");
  }

  // 6. API
  startApi();

  // 启动时对账一次
  await ledger.reconcile().catch((e) => logRun("reconcile", "error", e.message));
}

main().catch((e) => {
  logRun("service", "error", e.message);
  process.exit(1);
});
