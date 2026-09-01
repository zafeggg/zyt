import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  chainId: Number(process.env.CHAIN_ID || 31337),
  rpc: process.env.RPC_URL || "http://127.0.0.1:8545",
  contracts: {
    mining: process.env.MINING_ADDR || "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
    pool: process.env.POOL_ADDR || "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
    deflation: process.env.DEFLATION_ADDR || "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
    config: process.env.CONFIG_ADDR || "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    zyt: process.env.ZYT_ADDR || "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    forceSell: process.env.FORCESELL_ADDR || "",
  },
  keeper: {
    // v7：每日 08:00 北京时间 = UTC 0 点（cron 按 UTC 写，不依赖服务器时区）
    // 触发后由 retryTimes/retryDelayMs 覆盖 08:00-08:10 重试窗口
    snapshotCron: process.env.SNAPSHOT_CRON || "0 0 * * *",
    retryTimes: Number(process.env.RETRY_TIMES || 3),
    retryDelayMs: Number(process.env.RETRY_DELAY_MS || 30000),
    // 签名钱包私钥：用于触发每日快照等写交易（dailySnapshot）
    // 安全：该地址仅作为「定时触发器」，合约不向其授权任何资金操作；私钥不落入日志
    privateKey: process.env.KEEPER_PRIVATE_KEY || "",
    // 双实例互斥锁：跨进程防重复触发（方案 §6.3）
    // 生产配 REDIS_URL（SETNX 原子锁）；未配置时降级为本地文件锁（单机场景）
    lockTtlMs: Number(process.env.KEEPER_LOCK_TTL_MS || 600000), // 10 分钟，覆盖 08:00-08:10 重试窗
  },
  lock: {
    redisUrl: process.env.REDIS_URL || "", // 生产 Redis（如 redis://user:pass@host:6379）
  },
  indexer: {
    pollIntervalMs: Number(process.env.INDEXER_POLL_MS || 30000),
    startBlock: Number(process.env.START_BLOCK || 0),
    blockRange: Number(process.env.BLOCK_RANGE || 1000),
  },
  // 强制卖出窗口链下追踪（生产缺口 #7）：
  // 遍历链上 userList 读 firstReceiveTime/soldAmount/balance，按合约同款公式
  // 计算 4×15 天窗口应卖量/风险状态，未卖足预警
  forceSell: {
    enabled: process.env.FORCESELL_ENABLED !== "false",
    syncIntervalMs: Number(process.env.FORCESELL_SYNC_MS || 600000), // 10min 同步一次
    alertCooldownMs: Number(process.env.FORCESELL_ALERT_COOLDOWN_MS || 3600000), // 每用户预警冷却 1h
  },
  api: {
    port: Number(process.env.API_PORT || 8080),
    // 管理端点（/reconcile）鉴权 token：留空 = 端点禁用（403），生产必须配置
    adminToken: process.env.API_ADMIN_TOKEN || "",
    // 全局限流：每 IP 每分钟请求数（/health 豁免，供监控探活）
    rateLimitPerMin: Number(process.env.API_RATE_LIMIT || 100),
    // CORS 允许来源：* = 全放行（默认，前端同域部署）；生产可配具体域名（逗号分隔多域名）
    corsOrigin: process.env.CORS_ORIGIN || "*",
  },
  alert: { webhookUrl: process.env.ALERT_WEBHOOK_URL || "" },
  // 监控规则引擎（生产缺口 #4）：
  // 5 类规则独立冷却（cooldownMs）防告警风暴
  monitor: {
    enabled: process.env.MONITOR_ENABLED !== "false",
    intervalMs: Number(process.env.MONITOR_INTERVAL_MS || 30000), // 周期检查间隔
    poolDropPct: Number(process.env.MONITOR_POOL_DROP_PCT || 10), // R1 底池突变阈值 %
    bigSellPct: Number(process.env.MONITOR_BIG_SELL_PCT || 5), // R2 大额卖出阈值 %
    indexLagBlocks: Number(process.env.MONITOR_INDEX_LAG_BLOCKS || 120), // R4 索引延迟块数
    errorRatePct: Number(process.env.MONITOR_ERROR_RATE_PCT || 30), // R5 失败率阈值 %
    errorWindowSec: Number(process.env.MONITOR_ERROR_WINDOW_SEC || 600), // R5 统计窗口 10min
    cooldownMs: Number(process.env.MONITOR_COOLDOWN_MS || 600000), // 规则冷却 10min
  },
  // 存储层（v8）：
  // - :memory:            内存 SQLite（默认，本地联调；启动时从链上全量重同步，重启幂等）
  // - mysql://user:pass@host:port/db  MySQL 持久化（生产/testnet）
  dbPath: process.env.DB_URL || ":memory:",
};
