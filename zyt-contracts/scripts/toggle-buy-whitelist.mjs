// 买入白名单全局开关（owner 可逆）：off=测试团队开放人人可买，on=恢复白名单
// 用法: node scripts/toggle-buy-whitelist.mjs off|on
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import "dotenv/config";
const p = new JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com", 97);
const CONFIG = "0x62a96b2880fD282BC0984db800057F1CDFe2873C";
const owner = new Wallet(process.env.PRIVATE_KEY, p);
const cfg = new Contract(CONFIG, ["function setBuyWhitelistEnabled(bool)","function buyWhitelistEnabled() view returns (bool)"], owner);
const target = process.argv[2] === "on";
const cur = await cfg.buyWhitelistEnabled();
console.log("owner:", owner.address, "| 当前 buyWhitelistEnabled:", cur, "| 目标:", target);
if (cur === target) { console.log("已是目标状态，无需操作"); process.exit(0); }
const tx = await cfg.setBuyWhitelistEnabled(target);
await tx.wait();
console.log("tx:", tx.hash);
for (let i = 0; i < 5; i++) {
  if ((await cfg.buyWhitelistEnabled()) === target) { console.log("已生效 ✓ buyWhitelistEnabled =", target); break; }
  await new Promise(r => setTimeout(r, 1500));
}
process.exit(0);
