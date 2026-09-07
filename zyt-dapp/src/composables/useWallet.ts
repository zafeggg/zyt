import { ref, computed } from "vue";
import { BrowserProvider, Contract, formatUnits, type Signer } from "ethers";
import { currentChain } from "../config";
import { useWalletStore } from "../store/wallet";
import { setSigner } from "./useContracts";

const ERC20_MIN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
] as const;

/**
 * EIP-6963 钱包公告结构（多钱包发现协议）
 * 现代钱包（含 TokenPocket 新版内置浏览器）在页面加载后广播 announceProvider 事件
 */
interface EIP6963Provider {
  info: {
    uuid: string;
    name: string;
    icon: string;
    rdns: string; // 反域名标识，如 io.tokenpocket / io.metamask
  };
  provider: any;
}

const address = ref("");
const shortAddress = computed(() =>
  address.value ? `${address.value.slice(0, 6)}...${address.value.slice(-4)}` : ""
);

/** 已选中的钱包 provider（connect 后固化，保证签名与连接一致） */
let activeProvider: any = null;

// ===== EIP-6963 钱包发现（单例，页面级共享） =====
const eipProviders: EIP6963Provider[] = [];
let eipReady = false;

function isTP(rdns: string): boolean {
  return rdns.toLowerCase().includes("tokenpocket") || rdns.toLowerCase().includes("tp");
}

/** 发起 EIP-6963 钱包发现，返回收集到的钱包列表 */
function discoverEIP6963(): Promise<EIP6963Provider[]> {
  return new Promise((resolve) => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as EIP6963Provider;
      if (!detail?.info || !detail?.provider) return;
      // 去重：同 uuid 只保留一次
      if (!eipProviders.some((p) => p.info.uuid === detail.info.uuid)) {
        eipProviders.push(detail);
      }
    };
    window.addEventListener("eip6963:announceProvider", handler);
    // 请求已注入钱包广播自身
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // TP 内置浏览器广播存在延迟，等待收集窗口
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", handler);
      eipReady = true;
      resolve([...eipProviders]);
    }, 300);
  });
}

/**
 * 钱包来源识别
 * 优先级：EIP-6963 中 TokenPocket → window.ethereum.isTokenPocket → window.ethereum 其余 → 无
 * 返回 { provider, name, source }，name 用于 UI 标识
 */
async function resolveWallet(): Promise<{ provider: any; name: string; source: string }> {
  if (!eipReady) await discoverEIP6963();
  const w = (window as any).ethereum;

  // 1) EIP-6963 优先：内置浏览器 + 插件版都会广播，按 TP → 其他顺序取
  if (eipProviders.length > 0) {
    const tp = eipProviders.find((p) => isTP(p.info.rdns));
    const chosen = tp || eipProviders[0];
    return { provider: chosen.provider, name: chosen.info.name, source: "eip6963" };
  }

  // 2) 回退 window.ethereum：识别 TP 标识
  if (w) {
    if (w.isTokenPocket) return { provider: w, name: "TokenPocket", source: "ethereum" };
    if (w.isMetaMask) return { provider: w, name: "MetaMask", source: "ethereum" };
    // 未识别标识的注入（Trust/其他内置浏览器）
    return { provider: w, name: "Wallet", source: "ethereum" };
  }

  throw new Error("NO_WALLET");
}

/** 钱包选项（供选择弹窗展示） */
export interface WalletOption {
  provider: any;
  name: string;
  rdns: string;
  icon?: string;
  source: "eip6963" | "ethereum";
}

/**
 * 列举可选钱包（v12：多钱包选择）
 * - EIP-6963 发现的钱包全量列出（MetaMask / TokenPocket / 其他插件按安装顺序）
 * - 兜底 window.ethereum：若其标识(isMetaMask/isTokenPocket)未被 EIP-6963 覆盖则追加
 */
async function listWallets(): Promise<WalletOption[]> {
  if (!eipReady) await discoverEIP6963();
  const opts: WalletOption[] = eipProviders.map((p) => ({
    provider: p.provider,
    name: p.info.name,
    rdns: p.info.rdns,
    icon: p.info.icon,
    source: "eip6963" as const,
  }));
  // window.ethereum 兜底（插件版未广播 EIP-6963 或老版本）
  const w = (window as any).ethereum;
  if (w) {
    const legacyName = w.isTokenPocket ? "TokenPocket" : w.isMetaMask ? "MetaMask" : null;
    const dup = opts.some((o) => o.name.toLowerCase() === (legacyName || "unknown").toLowerCase());
    if (!dup) {
      opts.push({
        provider: w,
        name: legacyName || "Browser Wallet",
        rdns: "",
        source: "ethereum",
      });
    }
  }
  return opts;
}

async function switchChain(): Promise<boolean> {
  const chain = currentChain();
  // 本地 hardhat (31337) 不切链：钱包不支持该链时忽略
  if (chain.chainId === 31337) return true;
  try {
    const { provider } = await resolveWallet();
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x" + chain.chainId.toString(16) }],
    });
    return true;
  } catch (e: any) {
    if (e?.code === 4902) {
      try {
        const chainCfg = currentChain();
        const { provider } = await resolveWallet();
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x" + chainCfg.chainId.toString(16),
              chainName: chainCfg.name,
              rpcUrls: [chainCfg.rpc],
            },
          ],
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * v13：连接后网络强制校验。eth_chainId 与目标链不一致则自动 switch（网络不存在则 add 后 switch）。
 * 返回 false 表示钱包未切到目标链（用户拒绝或失败），调用方不得注入 signer。
 * @param w 指定 provider（connectWith 场景传选中钱包；缺省用 activeProvider / window.ethereum）
 */
async function ensureChain(w?: any): Promise<boolean> {
  const chain = currentChain();
  if (chain.chainId === 31337) return true; // 本地 hardhat 不校验
  try {
    const provider = w || activeProvider || (window as any).ethereum;
    if (!provider) return false;
    const hexId = "0x" + chain.chainId.toString(16);
    const cur = await provider.request({ method: "eth_chainId" });
    if (String(cur).toLowerCase() === hexId.toLowerCase()) return true;
    return switchChain();
  } catch {
    return false;
  }
}

/** 用指定钱包连接（用户在选择弹窗中点选后调用） */
async function connectWith(opt: WalletOption): Promise<void> {
  const accounts = await opt.provider.request({ method: "eth_requestAccounts" });
  if (!accounts || accounts.length === 0) {
    throw new Error("USER_REJECTED");
  }
  // v13：连接后强制校验目标链（FIBO 等错链下 eth_call 全返 0x，必须切到 BSC Testnet）
  if (!(await ensureChain(opt.provider))) {
    throw new Error("WRONG_CHAIN");
  }
  activeProvider = opt.provider;
  address.value = accounts[0];
  useWalletStore().setAddress(accounts[0]);
  // v12：同 connect()，立即注入 signer
  setSigner(await new BrowserProvider(opt.provider).getSigner());
}

export function useWallet() {
  const store = useWalletStore();

  async function connect(): Promise<void> {
    const { provider } = await resolveWallet();
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts || accounts.length === 0) {
      throw new Error("USER_REJECTED");
    }
    // v13：连接后强制校验目标链
    if (!(await ensureChain(provider))) {
      throw new Error("WRONG_CHAIN");
    }
    activeProvider = provider;
    address.value = accounts[0];
    store.setAddress(accounts[0]);
    // v12：连接成功后立即注入 signer（防 SwapPanel 等组件在 address 已非空时才挂载、watch 不触发导致 NOT_CONNECTED）
    setSigner(await new BrowserProvider(provider).getSigner());
  }

  function getProvider(): BrowserProvider {
    // 优先用 connect 固化的 provider（EIP-6963 选择结果），保证签名一致性
    const w = activeProvider || (window as any).ethereum;
    if (!w) throw new Error("NO_WALLET");
    return new BrowserProvider(w);
  }

  async function getSigner(): Promise<Signer> {
    return getProvider().getSigner();
  }

  /** 从钱包读取代币余额（小数形式） */
  async function tokenBalance(tokenAddress: string): Promise<string> {
    const signer = await getSigner();
    const erc20 = new Contract(tokenAddress, ERC20_MIN_ABI, signer);
    const bal = await erc20.balanceOf(await signer.getAddress());
    const dec = await erc20.decimals();
    return formatUnits(bal, dec);
  }

  /** 静默恢复已授权会话（TP/MetaMask 内置浏览器再次打开时不弹窗） */
  async function restoreSession(): Promise<void> {
    try {
      const { provider } = await resolveWallet();
      const accounts = await provider.request({ method: "eth_accounts" });
      if (accounts && accounts.length > 0) {
        // v13：静默恢复同样要求目标链，错链（如 FIBO 12306）不注入 signer，避免 eth_call 全返 0x
        if (!(await ensureChain(provider))) return;
        activeProvider = provider;
        address.value = accounts[0];
        store.setAddress(accounts[0]);
        // v12：静默恢复成功也注入 signer
        setSigner(await new BrowserProvider(provider).getSigner());
      }
    } catch {
      /* 未授权/无钱包，静默忽略 */
    }
  }

  function listenAccountChange(): void {
    const w = activeProvider || (window as any).ethereum;
    if (!w) return;
    // TP 老版本内置浏览器可能只暴露 request，无事件 API → 保护性检测
    if (typeof w.on !== "function") return;
    const onAccounts = (accounts: string[]) => {
      address.value = accounts[0] || "";
      store.setAddress(accounts[0] || "");
    };
    const onChain = () => window.location.reload();
    // 防重复绑定：先解绑再绑，restoreSession 后重挂不会叠加
    if (typeof w.removeListener === "function") {
      w.removeListener("accountsChanged", onAccounts);
      w.removeListener("chainChanged", onChain);
    }
    w.on("accountsChanged", onAccounts);
    w.on("chainChanged", onChain);
  }

  return {
    address,
    shortAddress,
    connect,
    connectWith,
    listWallets,
    switchChain,
    ensureChain,
    getProvider,
    getSigner,
    tokenBalance,
    restoreSession,
    listenAccountChange,
  };
}
