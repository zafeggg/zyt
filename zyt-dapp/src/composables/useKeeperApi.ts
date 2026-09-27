import { currentChain } from "../config";

/**
 * 链下服务 API（keeper）客户端（#8 前端接入）
 * - 所有接口失败返回 null → 调用方降级到合约直连
 * - 4s 超时（AbortController），避免 API 挂起阻塞页面
 * - 与 keeper src/api.js 端点对应：/stats /user/:addr /power/:addr /records/:addr /force-sell/:addr
 */

const TIMEOUT_MS = 4000;

/** v17：底池创建合约累计数据（keeper /stats 从链上读取） */
export interface KeeperCreator {
  // v9：Creator 持有口径
  lockedLiquidity?: string;
  totalZytSeeded?: string;
  totalUsdtSeeded?: string;
  totalDeflationZytOut?: string;
  totalDeflationUsdtOut?: string;
  // v9.1：owner 提取累计（用于区分每日通缩报销与 owner 主动提取）
  totalLpWithdrawn?: string;
}

export interface KeeperStats {
  pool?: {
    pool_gst: string;
    pool_zyt: string;
    pool_usdt: string;
    snapshot_gst: string;
    price: string;
    slippage_pct: number;
    stage: number;
    updated_at: number;
    // P1-10：滑点判定新口径（当日卖出量 / USDT 快照）
    day_sold_gst?: string;
    snapshot_pool_usdt?: string;
  } | null;
  lastSnapshot?: unknown;
  // v14：统计指标扩展（wei 字符串；DataDashboard 真值，占位 -- 替换）
  burned?: string;
  todayDeposit?: string;
  networkPower?: string;
  /** v9.1：累计销毁 LP 凭证（pool.totalLpBurned 链上直读，wei 字符串） */
  lpBurned?: string;
  // v17：底池创建累计（Creator 未接线时为 null）
  creator?: KeeperCreator | null;
}

export interface KeeperUser {
  address: string;
  deposit_total?: string;
  withdraw_total?: string;
  /** @deprecated v17：动态额度机制已废弃，恒为 0 */
  dynamic_quota?: string;
  /** @deprecated v17：同上 */
  dynamic_withdrawn?: string;
  /** v17：算力兑换累计消耗的 USDT 等值（已计入 withdraw_total） */
  converted_total?: string;
  power?: string;
  is_exited?: number;
  updated_at?: number;
  /** v9.1：买入额度（userInfo[5] = buyQuota - buyUsed，wei 字符串；keeper /user 补充链上读） */
  buy_quota_left?: string;
  /** v9.1：静态出局线（transferValueOf[1] = depositTotal×2 + 受赠，wei 字符串） */
  withdraw_cap?: string;
}

export interface KeeperDividend {
  address: string;
  /** 已结算未提取（链上 pendingDividend，wei 字符串） */
  claimable: string;
  /** 游标至昨日之间未结算份额（点击提取即入账，wei 字符串） */
  settleable: string;
  /** 今日份额（合约按日隔离，次日之后才可结算，wei 字符串） */
  todayAccrual: string;
  /** 三者合计（wei 字符串） */
  total: string;
  cursorDay: number;
  today: number;
}

export interface KeeperForceSell {
  address: string;
  status: string;
  firstReceiveAt: number;
  currentWindow: number;
  cumTargetPct: number;
  requiredSell: string;  soldAmount: string;
  balance: string;
  sellCount: number;
  atRisk: boolean;
  progressPct: number;
  deadlineSec: number;
  updatedAt: number;
}

export interface KeeperRecord {
  name: string;
  from_addr: string;
  to_addr: string;
  amount: string;
  extra: string;
  block: number;
  hash?: string; // v14：tx hash（2026-09-24 keeper 端 tx_hash AS hash 对齐，去重依赖此字段）
  created_at?: number; // v9：事件入库 unix 秒，行时间兜底（链上事件多无 args.time）
}

async function get<T>(path: string): Promise<T | null> {
  const base = currentChain().apiBase;
  if (!base) return null; // 未配置 API → 降级
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(base + path, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // 网络/超时失败 → 降级
  }
}

export function useKeeperApi() {
  /** 池状态 + 最近快照 */
  const stats = () => get<KeeperStats>("/stats");
  /** 用户账本（含算力） */
  const user = (addr: string) => get<KeeperUser>(`/user/${addr.toLowerCase()}`);
  /** 用户当前算力 */
  const power = (addr: string) => get<{ address: string; power: string }>(`/power/${addr.toLowerCase()}`);
  /** 用户事件记录 */
  const records = (addr: string) => get<KeeperRecord[]>(`/records/${addr.toLowerCase()}`);
  /** 强制卖出窗口状态 */
  const forceSell = (addr: string) => get<KeeperForceSell>(`/force-sell/${addr.toLowerCase()}`);
  /** v9.1：分红预估（可提取 / 可结算 / 今日待次日到账） */
  const dividend = (addr: string) => get<KeeperDividend>(`/dividend/${addr.toLowerCase()}`);
  /** API 是否已配置（未配置时全部接口直接返回 null） */
  const enabled = () => !!currentChain().apiBase;

  return { stats, user, power, records, forceSell, dividend, enabled };
}
