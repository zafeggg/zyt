import { ethers } from "ethers";
const ZYT = "0x18F532982192ED4b935f9c61F57f58d47E06b749";
const p = new ethers.JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com");
const latest = await p.getBlockNumber();
let lo = latest - 4000, hi = latest;
const hasCode = async (b) => (await p.getCode(ZYT, b)) !== "0x";
if (await hasCode(lo)) { console.log("NOT_FOUND in range", lo, hi); process.exit(1); }
while (lo + 1 < hi) {
  const mid = (lo + hi) >> 1;
  (await hasCode(mid)) ? (hi = mid) : (lo = mid);
}
const blk = await p.getBlock(hi);
console.log("ZYT created at block:", hi, "ts:", new Date(blk.timestamp * 1000).toISOString());
console.log("latest:", latest);
