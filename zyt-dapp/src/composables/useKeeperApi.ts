import { currentChain } from "../config";

/**
 * 链下服务 API（keeper）客户端（#8 前端接入）
 * - 所有接口失败返回 null → 调用方降级到合约直连
 * - 4s 超时（AbortController），避免 API 挂起阻塞页面
 * - 与 keeper src/api.js 端点对应：/stats /user/:addr /power/:addr /records/:addr /force-sell/:addr
 */

const TIMEOUT_MS = 4000;

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
  } | null;
  lastSnapshot?: unknown;
  // v14：统计指标扩展（wei 字符串；DataDashboard 真值，占位 -- 替换）
  burned?: string;
  todayDeposit?: string;
  networkPower?: string;
}

export interface KeeperUser {
  address: string;
  deposit_total?: string;
  withdraw_total?: string;
  dynamic_quota?: string;
  dynamic_withdrawn?: string;
  power?: string;
  is_exited?: number;
  updated_at?: number;
}

export interface KeeperForceSell {
  address: string;
  status: string;
  firstReceiveAt: number;
  currentWindow: number;
  cumTargetPct: number;
  requiredSell: string;
  soldAmount: string;
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
  hash?: string; // v14：tx hash（events 表已存，前端用于 BscScan 外链）
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
  /** API 是否已配置（未配置时全部接口直接返回 null） */
  const enabled = () => !!currentChain().apiBase;

  return { stats, user, power, records, forceSell, enabled };
}
