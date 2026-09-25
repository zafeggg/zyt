import { ref } from "vue";
import { Contract } from "ethers";
import { currentChain } from "../config";
import { useWallet } from "./useWallet";

/**
 * 邀请制入口（v15）：钱包连接 + 链上注册判定 + 邀请码存储
 * - 存储 key 含合约代次（chainId + mining 后 6 位），换合约重部署自动失效
 * - URL ?ref=0x... 永远覆盖已存邀请码（跟随最新分享链接）
 * - 已注册判定：链上 referrerOf(钱包) ≠ 0 为强依据，localStorage 为本机弱依据
 * - 测试逃生：URL 带 skipInvite=1 跳过 gate（不对外宣传）
 */

/** ZYTReferral 最小 ABI：仅注册判定所需 */
const REFERRAL_MIN_ABI = ["function referrerOf(address) view returns (address)"] as const;

const KEY_PREFIX = "zyt_invite_";

function keyOf(): string {
  const c = currentChain();
  return `${KEY_PREFIX}${c.chainId}_${(c.contracts.mining || "").slice(-6).toLowerCase()}`;
}

/** 解析邀请码输入：支持完整推荐链接（提取 ref=）或 0x 地址，非法返回 "" */
export function parseInvite(input: string): string {
  if (!input) return "";
  const s = input.trim();
  const m = s.match(/ref=([0-9a-fA-Fx]{40,42})/);
  const cand = (m ? m[1] : s).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(cand) ? cand.toLowerCase() : "";
}

const inviteRef = ref<string>("");

function readSaved(): string {
  try {
    return localStorage.getItem(keyOf()) || "";
  } catch {
    return "";
  }
}

export function useInvite() {
  /** 已存邀请码（无则空串） */
  function getSaved(): string {
    return readSaved();
  }

  /** URL ?ref= 覆盖存储；返回是否命中 */
  function syncFromUrl(): boolean {
    const q = new URLSearchParams(location.hash.split("?")[1] || location.search.split("?")[1] || "");
    const r = parseInvite(q.get("ref") || "");
    if (r) {
      setInvite(r);
      return true;
    }
    return false;
  }

  function setInvite(r: string): void {
    inviteRef.value = r.toLowerCase();
    try {
      localStorage.setItem(keyOf(), inviteRef.value);
    } catch {
      /* 隐私模式降级内存态 */
    }
  }

  /** 是否放行：已存邀请码 或 测试逃生参数 */
  function hasInvite(): boolean {
    if (location.hash.includes("skipInvite=1") || location.search.includes("skipInvite=1")) return true;
    return getSaved() !== "";
  }

  return { getSaved, syncFromUrl, setInvite, hasInvite, inviteRef };
}

/**
 * v15：链上查询用户推荐上级（已注册强判定）
 * - 返回小写推荐人地址；未绑定返回 ""（referral.referrerOf 为零地址）
 * - 未连接钱包 / referral 合约地址为空 / RPC 异常均抛错，由调用方降级处理
 */
export async function fetchOnchainReferrer(wallet: string): Promise<string> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return "";
  const { getProvider } = useWallet();
  const provider = getProvider(); // 未连接时 throw NO_WALLET
  const chain = currentChain();
  if (!chain.contracts.referral) return "";
  const referral = new Contract(chain.contracts.referral, REFERRAL_MIN_ABI, provider);
  const r: string = await referral.referrerOf(wallet);
  // 全零地址 = 未绑定
  try {
    if (BigInt(r) === 0n) return "";
  } catch {
    return "";
  }
  return /^0x[0-9a-fA-F]{40}$/.test(r) ? r.toLowerCase() : "";
}

/** v15：读取当前链的根邀请码（营销地址，config 显式配置；空串表示未配置） */
export function getRootInvite(): string {
  return (currentChain().rootInvite || "").toLowerCase();
}

const REG_PREFIX = "zyt_reg_";

/** 本机注册标记 key（与邀请码同 keyOf 隔离：换合约重部署自动失效） */
function regKey(): string {
  return `${REG_PREFIX}${keyOf()}`;
}

/** v15：标记本机已完成注册（用户点击注册按钮后调用；刷新/重开凭此免重复注册） */
export function markRegistered(): void {
  try {
    localStorage.setItem(regKey(), "1");
  } catch {
    /* 隐私模式降级：仅内存态，下次需重新注册 */
  }
}

/** v15：本机是否已完成注册（链上未绑定时的放行依据） */
export function isRegistered(): boolean {
  try {
    return localStorage.getItem(regKey()) === "1";
  } catch {
    return false;
  }
}
