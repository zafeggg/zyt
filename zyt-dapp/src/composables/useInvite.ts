import { ref } from "vue";
import { currentChain } from "../config";

/**
 * 邀请制入口（v14）：必须持有邀请码（推荐人地址）才能进入主页面
 * - 存储 key 含合约代次（chainId + mining 后 6 位），换合约重部署自动失效
 * - URL ?ref=0x... 永远覆盖已存邀请码（跟随最新分享链接）
 * - 测试逃生：URL 带 skipInvite=1 跳过 gate（不对外宣传）
 */

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
