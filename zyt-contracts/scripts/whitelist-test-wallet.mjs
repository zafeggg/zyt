// testnet 联调：owner 放行测试钱包买入白名单
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import "dotenv/config";
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const POOL = "0x701A4A0cF59a05ada702e9b8b572b46e50F70726";
const WALLET = "0x87C0aF08c0F974E86CAC508faA239bB1Cc2f2241"; // 用户测试钱包
const p = new JsonRpcProvider(RPC, 97);
const owner = new Wallet(process.env.PRIVATE_KEY, p);
console.log("owner:", owner.address);
const pool = new Contract(POOL, ["function setBuyWhitelist(address,bool)","function buyWhitelist(address) view returns (bool)"], owner);
// 先看当前状态
const before = await pool.buyWhitelist(WALLET);
console.log("白名单前:", before);
if (!before) {
  const tx = await pool.setBuyWhitelist(WALLET, true);
  await tx.wait();
  console.log("放行 tx:", tx.hash);
}
// 复核（公共 RPC 写后立即读可能旧值，轮询重读）
for (let i = 0; i < 5; i++) {
  const after = await pool.buyWhitelist(WALLET);
  if (after) { console.log("白名单已放行 ✓"); break; }
  await new Promise(r => setTimeout(r, 1500));
}
process.exit(0);
