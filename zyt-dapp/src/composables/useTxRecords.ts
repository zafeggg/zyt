import { ref } from "vue";

/**
 * 本地交易记录（v13：授权/加池/入金/卖出/领取等前端可观测交易的持久化）
 * - 按钱包地址分区存储于 localStorage（key: zyt_tx_records_<address>），刷新/重连后仍在
 * - 覆盖 pending（发起未确认）/ success / fail
 * - 链上历史（keeper /records 事件聚合）由 RecordsView 另行合并展示
 */

export type TxType =
  | "approve" // USDT/ZYT 授权
  | "addLiquidity" // 添加流动性（LP 1:1 配额）
  | "deposit" // 入金/质押
  | "sell" // 卖出 ZYT
  | "reward" // 日产出领取
  | "dividend" // 分红领取
  | "refReward" // 推荐奖励
  | "forceSell" // 强制卖出
  | "burn" // 强制销毁/通缩
  | "transfer"; // 转账

export type TxStatus = "pending" | "success" | "fail";

export interface TxRecord {
  id: string; // 唯一 id（time + 随机），状态更新按 id 覆盖
  type: TxType;
  status: TxStatus;
  spend?: string; // 支出（human），如 "100 USDT"
  receive?: string; // 获得（human），如 "947.8万 ZYT"
  detail?: string; // 附加说明（如 "营销分配 40 / 池分配 60"）
  hash?: string; // 交易哈希
  time: number; // epoch ms
}

const KEY_PREFIX = "zyt_tx_records_";

// v14：key 加合约代次（chainId + mining 地址）——换合约重新部署后旧记录自动隔离，
// 避免"新合约页面看到上个版本合约的交易记录"（用户 09-09 反馈的根因）
import { currentChain } from "../config";

function keyOf(addr: string): string {
  const c = currentChain();
  const gen = `${c.chainId}_${(c.contracts.mining || "").slice(-6).toLowerCase()}`;
  return `${KEY_PREFIX}${gen}_${addr.toLowerCase()}`;
}

function readAll(addr: string): TxRecord[] {
  try {
    const raw = localStorage.getItem(keyOf(addr));
    return raw ? (JSON.parse(raw) as TxRecord[]) : [];
  } catch {
    return [];
  }
}

const live = ref<TxRecord[]>([]);
let currentAddr = "";

export function useTxRecords() {
  /** 当前地址的记录（load 后填充；同地址 upsert 自动同步） */
  const list = live;

  /** 地址变化/重连时加载 */
  function load(addr: string): TxRecord[] {
    currentAddr = addr ? addr.toLowerCase() : "";
    live.value = currentAddr ? readAll(currentAddr) : [];
    return live.value;
  }

  /** 新增/按 id 覆盖一条（状态 pending→success/fail 更新用） */
  function upsert(addr: string, rec: TxRecord): void {
    const a = addr.toLowerCase();
    const all = readAll(a);
    const idx = all.findIndex((x) => x.id === rec.id);
    if (idx >= 0) all[idx] = rec;
    else all.unshift(rec);
    try {
      localStorage.setItem(keyOf(a), JSON.stringify(all.slice(0, 100)));
    } catch {
      /* 存储不可用（隐私模式）降级为内存态 */
    }
    if (a === currentAddr) live.value = all;
  }

  return { list, load, upsert };
}

/** 创建记录 id */
export function newTxId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
