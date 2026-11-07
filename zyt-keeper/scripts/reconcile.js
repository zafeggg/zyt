// 每日对账任务：链上 pool 状态 + 逐用户账本 vs 链上
// 用法：node scripts/reconcile.js
//
// 2026-11-07 修复：原实现只传 { pool }，reconcile 内 `zyt ? getUserCount() : 0`
//   直接短路成 total=0，循环跳过，每次往 reconcile_results 写一条 status='ok' 的假记录。
//   表现为对账"永远通过"，实际一个用户都没比对过。现补齐 zyt / mining / config 三个合约。
import { FetchRequest, JsonRpcProvider, Contract } from "ethers";
import { CONFIG } from "../src/config.js";
import { Ledger } from "../src/ledger.js";
import { POOL_VIEW_ABI, MINING_USERINFO_ABI } from "../src/abis.js";

// 与 src/index.js 完全一致的 provider 配置（20 秒超时 + 禁用批量请求），保证脚本与线上同口径
const req = new FetchRequest(CONFIG.rpc);
req.timeout = 20000;
const provider = new JsonRpcProvider(req, CONFIG.chainId, {
  staticNetwork: true,
  batchMaxCount: 1,
});

const pool = new Contract(CONFIG.contracts.pool, POOL_VIEW_ABI, provider);
const zyt = new Contract(
  CONFIG.contracts.zyt,
  ["function getUserCount() view returns (uint256)", "function getUserAt(uint256) view returns (address)"],
  provider
);
const mining = new Contract(CONFIG.contracts.mining, MINING_USERINFO_ABI, provider);
const configC = CONFIG.contracts.config
  ? new Contract(CONFIG.contracts.config, ["function staticExitMul() view returns (uint256)"], provider)
  : null;

const ledger = new Ledger(provider, { pool, zyt, mining, config: configC });

const t0 = Date.now();
// 先打印分母，total=0 时能立刻看出是合约没传还是链上真没人
console.log("starting reconcile, chain users =", (await zyt.getUserCount()).toString());
const r = await ledger.reconcile();
console.log("elapsed", ((Date.now() - t0) / 1000).toFixed(1) + "s");
console.log("on-chain:", r);
