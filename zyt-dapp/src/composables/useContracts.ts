import { Contract, type Signer, type Provider } from "ethers";
import { currentChain } from "../config";
import { MINING_ABI } from "../abis/mining";
import { POOL_ABI } from "../abis/pool";
import { CONFIG_ABI } from "../abis/config";
import { ZYT_ABI } from "../abis/zyt";
import { USDT_ABI } from "../abis/usdt";

let signer: Signer | null = null;
let provider: Provider | null = null;

export function setSigner(s: Signer | null) {
  signer = s;
}
export function setProvider(p: Provider | null) {
  provider = p;
}

function conn(): { signer: Signer; provider: Provider } {
  if (signer) return { signer, provider: signer.provider! };
  if (provider) return { signer: null as any, provider };
  throw new Error("NOT_CONNECTED");
}

export function getContracts(rw = false) {
  const c = currentChain().contracts;
  const s = rw ? conn().signer : undefined;
  return {
    mining: new Contract(c.mining, MINING_ABI, s || conn().provider),
    pool: new Contract(c.pool, POOL_ABI, s || conn().provider),
    config: new Contract(c.config, CONFIG_ABI, s || conn().provider),
    zyt: new Contract(c.zyt, ZYT_ABI, s || conn().provider),
    usdt: new Contract(c.usdt, USDT_ABI, s || conn().provider),
  };
}
