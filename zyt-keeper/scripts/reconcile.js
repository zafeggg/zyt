// 每日对账任务：链上 pool 状态 vs 本地账本
// 用法：node scripts/reconcile.js
import { JsonRpcProvider, Contract } from "ethers";
import { CONFIG } from "../src/config.js";
import { Ledger } from "../src/ledger.js";

const provider = new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
const pool = new Contract(CONFIG.contracts.pool, [
  "function poolGST() view returns (uint256)",
  "function poolZYT() view returns (uint256)",
  "function poolUSDT() view returns (uint256)",
  "function snapshotPoolGST() view returns (uint256)",
  "function getPrice() view returns (uint256)",
  "function getStage() view returns (uint256)",
  "function getCurrentSlippage() view returns (uint256)",
], provider);

const ledger = new Ledger(provider, { pool });
const r = await ledger.reconcile();
console.log("on-chain:", r);
