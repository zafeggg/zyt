import { Indexer } from "./indexer.js";
import { Keeper } from "./keeper.js";
import { startApi } from "./api.js";
import { Ledger } from "./ledger.js";
import { Monitor } from "./monitor.js";
import { ForceSellTracker } from "./forcesell.js";
import { JsonRpcProvider, Contract } from "ethers";
import { CONFIG } from "./config.js";
import { POOL_VIEW_ABI } from "./abis.js";
import { lock } from "./lock.js";
import { logRun } from "./alert.js";

/**
 * 众赢币 ZYT 链下服务主入口：
 * 1. 索引器：事件轮询入库
 * 2. 账本：事件重放重建用户状态
 * 3. Keeper：每日 08:00 快照（签名钱包 + 双实例互斥锁）
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

  const provider = new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
  const pool = new Contract(CONFIG.contracts.pool, POOL_VIEW_ABI, provider);
  const zyt = new Contract(CONFIG.contracts.zyt, ["function getUserCount() view returns (uint256)", "function getUserAt(uint256) view returns (address)"], provider);
  const mining = new Contract(CONFIG.contracts.mining, ["function userInfo(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool)"], provider);

  // 1+2. 索引 + 账本
  // 监控引擎先行创建（indexer 事件回调需要引用它），再注入 indexer（R4 需要 lastBlock）
  const monitor = new Monitor({ provider, pool });
  const indexer = new Indexer({ onEvent: (name, args) => monitor.onEvent(name, args) });
  monitor.setIndexer(indexer);
  const ledger = new Ledger(provider, { pool, zyt, mining });
  await indexer.syncOnce().catch((e) => logRun("indexer", "error", e.message));
  await ledger.rebuild();
  indexer.start();
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
