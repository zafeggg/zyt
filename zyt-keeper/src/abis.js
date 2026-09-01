import { Interface } from "ethers";

/** 索引所需的最小事件接口（与合约事件签名一致） */
export const MINING_IFACE = new Interface([
  "event Deposited(address indexed user, uint256 usdt, uint256 zytMinted, uint256 power, uint256 quota, address ref)",
  "event Sold(address indexed user, uint256 zytIn, uint256 usdtOut, uint256 rate)", // V17：+滑点档位
  "event Claimed(address indexed user, uint256 reward, uint256 day, uint256 usdt)", // v8：新增 usdt 等值
  "event RefReward(address indexed receiver, uint256 reward, uint256 level, uint256 usdt)", // v8：新增 usdt 等值
  "event DailyReleased(uint256 day, uint256 totalPower, uint256 releaseAmount)",
]);

export const POOL_IFACE = new Interface([
  "event SlippageCollected(uint256 rate, uint256 toMarket, uint256 toDividend, uint256 toBurn)",
  "event SnapshotUpdated(uint256 snapshotGST, uint256 snapshotPrice, uint256 time)", // v7：快照价一并锁定
  "event PoolBurned(uint256 amount)",
]);

export const DEFLATION_IFACE = new Interface([
  "event DailySnapshot(uint256 day, uint256 burned, uint256 dividend, uint256 released, uint256 snapshotGST)",
]);

export const FORCESELL_IFACE = new Interface([
  "event FirstReceive(address indexed user, uint256 time)",
  "event ForceSellBurned(address indexed user, uint256 amount, uint256 window)",
]);

/** 合约地址 → 解析接口 */
export const SUBSCRIBED = [
  { key: "mining", addrKey: "mining", iface: MINING_IFACE },
  { key: "pool", addrKey: "pool", iface: POOL_IFACE },
  { key: "deflation", addrKey: "deflation", iface: DEFLATION_IFACE },
  { key: "forceSell", addrKey: "forceSell", iface: FORCESELL_IFACE },
];

/** Pool 只读视图 ABI（对账/API 共用；v7 含快照锁定价） */
export const POOL_VIEW_ABI = [
  "function poolGST() view returns (uint256)",
  "function poolZYT() view returns (uint256)",
  "function poolUSDT() view returns (uint256)",
  "function snapshotPoolGST() view returns (uint256)",
  "function snapshotPrice() view returns (uint256)",
  "function getPrice() view returns (uint256)",
  "function getTradePrice() view returns (uint256)",
  "function getStage() view returns (uint256)",
  "function getCurrentSlippage() view returns (uint256)",
  "function dividendPool() view returns (uint256)",
];
