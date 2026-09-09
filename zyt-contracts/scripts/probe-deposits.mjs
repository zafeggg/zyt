import { JsonRpcProvider, Contract } from "ethers";
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const MINING = "0x1ffCec692Ef2c8287C1dE7248B0621bdAd135703";
const DEFLATION = "0x16E8A145D015D80892e5CFe8cE305F0717F229a9";
const p = new JsonRpcProvider(RPC, 97);
const m = new Contract(MINING, ["event Deposited(address indexed user, uint256 usdt, uint256 zytMinted, uint256 power, uint256 quota, address ref)"], p);
const d = new Contract(DEFLATION, ["function lastSnapshotDay() view returns (uint256)","function snapshotCount() view returns (uint256)"], p);
const [snapDay, snapCount] = await Promise.all([d.lastSnapshotDay(), d.snapshotCount()]);
console.log("lastSnapshotDay =", Number(snapDay), "| snapshotCount =", Number(snapCount));
const latest = await p.getBlockNumber();
const from = 128482000;
let logs = [];
for (let b = from; b <= latest; b += 1000) {
  const to = Math.min(b + 999, latest);
  try {
    const l = await p.getLogs({ address: MINING, topics: [m.filters.Deposited().topic0], fromBlock: b, toBlock: to });
    logs = logs.concat(l);
  } catch (e) { console.log("skip", b, e.shortMessage || e.message); }
}
console.log("Deposited events total =", logs.length, "(latest block", latest + ")");
for (const l of logs) {
  const ev = m.interface.parseLog({ topics: l.topics, data: l.data });
  const u = ev.args.user.toLowerCase();
  console.log(`#${l.blockNumber} user=${u} usdt=${Number(ev.args.usdt)/1e18}U zyt=${Number(ev.args.zytMinted)/1e18} power=${Number(ev.args.power)/1e18}`);
}
