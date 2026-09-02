import { JsonRpcProvider, Contract } from "ethers";
const p = new JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com", 97);
const d = new Contract("0xED866239D6Fcd7164C54b3431f745850fACc60c1", ["function lastSnapshotDay() view returns (uint256)","function snapshotCount() view returns (uint256)"], p);
console.log("lastSnapshotDay =", Number(await d.lastSnapshotDay()), "| snapshotCount =", Number(await d.snapshotCount()));
process.exit(0);
