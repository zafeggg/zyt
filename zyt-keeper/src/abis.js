import { Interface } from "ethers";

/**
 * v9 事件接口（与 2026-09-24 v9 合约事件签名一一对应）：
 * - 弃 GST：Pool 事件全换真池口径（LiquidityInjected / Bought / Sold / Deflated）
 * - Mining：Deposited 新签名（usdt/power/quota/ref）；新增 Bought；Converted/BasePoolFunded 删除
 * - Creator：初始建池 + LP 锁仓 + 每日通缩报销（InitialPoolCreated / DeflationSkimmed）
 */

/** Mining 事件（v9） */
export const MINING_IFACE = new Interface([
  "event Deposited(address indexed user, uint256 usdt, uint256 power, uint256 quota, address ref)",
  "event Bought(address indexed user, uint256 usdtIn, uint256 zytOut)",
  "event Sold(address indexed user, uint256 zytIn, uint256 usdtOut, uint256 rate)",
  "event StaticExited(address indexed user)",
  "event DynamicExited(address indexed user)", // v9 加速释放：动态额度耗尽
  "event DailyReleased(uint256 day, uint256 totalPower)",
  "event DividendSettled(address indexed user, uint256 amount, uint256 fromDay, uint256 toDay)",
  "event Claimed(address indexed user, uint256 amount)",
  "event TransferLedger(address indexed user, uint256 zytAmount, uint256 usdtValue, bool isOut)",
  "event RefPaid(address indexed receiver, uint256 usdtAmount, uint256 level)",
]);

/** Pool 事件（v9 真池） */
export const POOL_IFACE = new Interface([
  "event LiquidityInjected(address indexed user, uint256 usdtIn, uint256 lpBurned)",
  "event Bought(address indexed user, uint256 usdtIn, uint256 zytOut)",
  "event Sold(address indexed seller, uint256 zytGross, uint256 slip, uint256 usdtOut)",
  "event SnapshotUpdated(uint256 price, uint256 poolUSDT, uint256 time)",
  "event Deflated(uint256 burned, uint256 dividend, uint256 usdtResynced)",
  "event SlippageCollected(uint256 rate, uint256 toMarket, uint256 toDividend, uint256 toBurn)",
  "event DividendAccrued(uint256 amount)",
]);

/** Deflation 事件（v9） */
export const DEFLATION_IFACE = new Interface([
  "event DailySnapshot(uint256 day, uint256 burned, uint256 dividend, uint256 snapshotPrice, uint256 snapshotPoolUSDT)",
  "event DeflationFloorHit(uint256 day)",
]);

/** ForceSell 事件（沿用 v8） */
export const FORCESELL_IFACE = new Interface([
  "event FirstReceive(address indexed user, uint256 time)",
  "event ForceSellBurned(address indexed user, uint256 amount, uint256 window)",
  "event WindowSettled(address indexed user, uint256 window)",
]);

/** Creator 事件（v9：初始建池 + LP 持有 + 通缩报销；v9.1 增 owner 提取） */
export const CREATOR_IFACE = new Interface([
  "event InitialPoolCreated(address indexed pair, uint256 zytIn, uint256 usdtIn, uint256 liquidity)",
  "event PoolManagerChanged(address indexed poolManager)",
  "event DeflationSkimmed(uint256 lpBurned, uint256 zytAmt, uint256 usdtAmt)",
  "event LpWithdrawn(address indexed to, uint256 amount)",
]);

/** Referral 事件（2026-09-24 补订阅：绑定关系入 events 供记录页展示） */
export const REFERRAL_IFACE = new Interface([
  "event Bound(address indexed user, address indexed ref)",
]);

/** 合约地址 → 解析接口 */
export const SUBSCRIBED = [
  { key: "mining", addrKey: "mining", iface: MINING_IFACE },
  { key: "pool", addrKey: "pool", iface: POOL_IFACE },
  { key: "deflation", addrKey: "deflation", iface: DEFLATION_IFACE },
  { key: "forceSell", addrKey: "forceSell", iface: FORCESELL_IFACE },
  { key: "creator", addrKey: "creator", iface: CREATOR_IFACE },
  { key: "referral", addrKey: "referral", iface: REFERRAL_IFACE },
];

/** Pool 只读视图 ABI（v9 真池口径；pair 储备为唯一数据源） */
export const POOL_VIEW_ABI = [
  "function poolZYT() view returns (uint256)",
  "function poolUSDT() view returns (uint256)",
  "function getReservesPublic() view returns (uint256,uint256)",
  "function snapshotPrice() view returns (uint256)",
  "function snapshotPoolUSDT() view returns (uint256)",
  "function peakPoolUSDT() view returns (uint256)",
  "function getPrice() view returns (uint256)",
  "function getTradePrice() view returns (uint256)",
  "function getStage() view returns (uint256)",
  "function getCurrentSlippage() view returns (uint256)",
  "function dividendPoolZyt() view returns (uint256)",
  "function totalLpBurned() view returns (uint256)",
  "function swapGate() view returns (bool)",
];

/** Creator 只读视图 ABI（v9：LP 持有量 + 通缩报销累计；v9.1 增 owner 提取累计） */
export const CREATOR_VIEW_ABI = [
  "function lockedLiquidity() view returns (uint256)",
  "function totalZytSeeded() view returns (uint256)",
  "function totalUsdtSeeded() view returns (uint256)",
  "function totalDeflationZytOut() view returns (uint256)",
  "function totalDeflationUsdtOut() view returns (uint256)",
  "function totalLpWithdrawn() view returns (uint256)",
  "function pair() view returns (address)",
  "function initialized() view returns (bool)",
];

/** Mining 视图补充（v9：userInfo 为 8 元组，powerOf 单查） */
export const MINING_VIEW_EXTRA_ABI = [
  "function powerOf(address user) view returns (uint256)",
];

/** Mining userInfo v9 ABI（8 元组：keeper/api/index 三处共用，防签名漂移） */
export const MINING_USERINFO_ABI = [
  "function userInfo(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)",
  "function transferValueOf(address) view returns (uint256,uint256)",
  // 2026-09-25：分红预估接口用（dailyInfo 结构体仅 2 字段：[0]=totalPower, [1]=dividendAmount）
  "function dailyInfo(uint256) view returns (uint256,uint256)",
  "function dividendOf(address) view returns (uint256,uint256)",
  // 2026-09-26：全网算力统计用（链上权威值，含日复利；勿用 DB 账本口径，事件缺失时恒为 0）
  "function powerOf(address) view returns (uint256)",
  // 2026-09-28：v16 全网算力复利基准日（ledger 对齐合约 _powerOf 用）
  "function launchDay() view returns (uint64)",
];
