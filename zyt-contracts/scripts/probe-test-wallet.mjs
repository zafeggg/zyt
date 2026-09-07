// 查测试钱包链上状态（userInfo 全字段 + 代币余额 + 白名单 + 阶段）
import { JsonRpcProvider, Contract, formatEther } from "ethers";
const p = new JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com", 97);
const A = {
  mining: "0x3A7B648752D3557C9770a56Fd3B471dB6ee8FE69",
  pool: "0x701A4A0cF59a05ada702e9b8b572b46e50F70726",
  zyt: "0x9bd8CD99e61BE9c1FbB35282345111017a80F107",
  usdt: "0xe6d5879149078B7082567AF70319a16b7952CA8C",
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
