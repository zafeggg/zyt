// 临时：手动触发一次 ForceSellTracker 同步（验证清表后从链上 userList 重建）
import { JsonRpcProvider } from "ethers";
import { CONFIG } from "../src/config.js";
import { ForceSellTracker } from "../src/forcesell.js";
const t = new ForceSellTracker({ provider: new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true }) });
await t.syncOnce();
console.log("sync done");
process.exit(0);
