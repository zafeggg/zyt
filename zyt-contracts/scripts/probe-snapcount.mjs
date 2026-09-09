import { JsonRpcProvider, Contract } from "ethers";
const p = new JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com", 97);
const d = new Contract("0x16E8A145D015D80892e5CFe8cE305F0717F229a9", ["function lastSnapshotDay() view returns (uint256)","function snapshotCount() view returns (uint256)"], p);
console.log("lastSnapshotDay =", Number(await d.lastSnapshotDay()), "| snapshotCount =", Number(await d.snapshotCount()));
process.exit(0);
