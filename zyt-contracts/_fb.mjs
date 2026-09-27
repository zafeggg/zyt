import { ethers } from "ethers";
const ZYT = "0x9D434F75564410d6e41664716defEd92d95985C1";
const p = new ethers.JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com");
const latest = await p.getBlockNumber();
let lo = latest - 500, hi = latest;
const hasCode = async (b) => (await p.getCode(ZYT, b)) !== "0x";
while (lo + 1 < hi) { const m = (lo + hi) >> 1; (await hasCode(m)) ? (hi = m) : (lo = m); }
console.log("block:", hi, "latest:", latest);
