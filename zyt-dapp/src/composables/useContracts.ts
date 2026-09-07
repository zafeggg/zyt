import { Contract, JsonRpcProvider, type Signer, type Provider } from "ethers";
import { currentChain } from "../config";
import { MINING_ABI } from "../abis/mining";
import { POOL_ABI } from "../abis/pool";
import { CONFIG_ABI } from "../abis/config";
import { ZYT_ABI } from "../abis/zyt";
import { USDT_ABI } from "../abis/usdt";

let signer: Signer | null = null;
let provider: Provider | null = null;
// v13：无钱包时的公共只读通道（链上公开数据不依赖钱包，绕开未连接/错链导致的全 0）
let readProvider: Provider | null = null;

export function setSigner(s: Signer | null) {
  signer = s;
}
export function setProvider(p: Provider | null) {
  provider = p;
}
export function clearSigner() {
  signer = null;
}

/** 公共只读 provider（JsonRpcProvider，走 currentChain().rpc） */
export function getReadProvider(): Provider {
  if (!readProvider) readProvider = new JsonRpcProvider(currentChain().rpc);
  return readProvider;
}

/**
 * 取连接态。v13 语义：
 * - rw=true（写操作）必须有 signer，否则抛 NOT_CONNECTED
 * - rw=false（公共读）优先 signer -> 显式 provider -> 只读 RPC 兜底，不再因未连钱包失败
 */
function conn(rw: boolean): { signer: Signer | null; provider: Provider } {
  if (signer) return { signer, provider: signer.provider! };
  if (!rw && provider) return { signer: null, provider };
  if (!rw) return { signer: null, provider: getReadProvider() };
  throw new Error("NOT_CONNECTED");
}

export function getContracts(rw = false) {
  const c = currentChain().contracts;
  const { signer: s, provider: p } = conn(rw);
  return {
    mining: new Contract(c.mining, MINING_ABI, rw ? s! : p),
    pool: new Contract(c.pool, POOL_ABI, rw ? s! : p),
    config: new Contract(c.config, CONFIG_ABI, rw ? s! : p),
    zyt: new Contract(c.zyt, ZYT_ABI, rw ? s! : p),
    usdt: new Contract(c.usdt, USDT_ABI, rw ? s! : p),
  };
}
