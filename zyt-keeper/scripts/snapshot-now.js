// 手动触发一次每日快照（补快照用）
// 用法：node scripts/snapshot-now.js
import { Keeper } from "../src/keeper.js";

const keeper = new Keeper();
await keeper.runSnapshot({ force: true });
console.log("done");
