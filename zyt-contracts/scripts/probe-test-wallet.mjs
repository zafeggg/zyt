// 查测试钱包链上状态（userInfo 全字段 + 代币余额 + 白名单 + 阶段）
import { JsonRpcProvider, Contract, formatEther } from "ethers";
const p = new JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com", 97);
const A = {
  mining: "0x1ffCec692Ef2c8287C1dE7248B0621bdAd135703",
  pool: "0x020927BC660f7631709d388C992979359196DcfD",
  zyt: "0xdF18105bB57165c59AD651Eda1B4d896412d4166",
  usdt: "0x7749da5d64c0ABA2A8203c0C630d31e7D13cFb29",
};
const W = process.argv[2] || "0x87C0aF08c0F974E86CAC508faA239bB1Cc2f2241";
console.log("钱包:", W);
const mining = new Contract(A.mining, ["function userInfo(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool)","function getUserCount() view returns (uint256)"], p);
const pool = new Contract(A.pool, ["function getStage() view returns (uint256)","function buyWhitelist(address) view returns (bool)"], p);
const zyt = new Contract(A.zyt, ["function balanceOf(address) view returns (uint256)"], p);
const usdt = new Contract(A.usdt, ["function balanceOf(address) view returns (uint256)"], p);
const u = await mining.userInfo(W);
console.log("depositTotal(入金总额):", formatEther(u[0]), "U");
console.log("withdrawTotal(已出金):", formatEther(u[1]), "U");
console.log("dynamicQuota(动态额度):", formatEther(u[2]), "U");
console.log("dynamicWithdrawn(已用动态):", formatEther(u[3]), "U");
console.log("power(算力):", formatEther(u[4]));
console.log("lpQuota(LP配额):", formatEther(u[5]), "U");
console.log("isExited(静态出局):", u[6]);
console.log("ZYT 余额:", formatEther(await zyt.balanceOf(W)));
console.log("USDT 余额:", formatEther(await usdt.balanceOf(W)));
console.log("stage:", Number(await pool.getStage()), "| 白名单:", await pool.buyWhitelist(W));
console.log("链上用户数:", Number(await mining.getUserCount()));
process.exit(0);
