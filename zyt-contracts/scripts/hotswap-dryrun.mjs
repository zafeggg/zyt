// 热切换预演（只读）：在主网真实状态上逐笔估算 gas，不发任何交易
//
// 用途：替代 fork 演练中"会不会 revert"这一层保障。
//   - 5 个合约的部署交易：本地构造 + estimateGas（能暴露库链接缺失、构造参数错误、字节码超限）
//   - 6 笔旧合约授权/切换：对真实状态 estimateGas（能暴露 owner 不符、目标地址非法、状态不满足）
//   - 预测新合约地址（按 nonce 推导），并汇总所需 BNB
//
// 用法：
//   node scripts/hotswap-dryrun.mjs            # 读 .env
//   RPC_URL=... PRIVATE_KEY=... node scripts/hotswap-dryrun.mjs
import "dotenv/config";
import { JsonRpcProvider, Wallet, Contract, ContractFactory, formatEther, getCreateAddress } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART = path.join(ROOT, "artifacts", "contracts");
const env = process.env;
const RPC = env.RPC_URL || env.BSC_MAINNET_RPC || "http://127.0.0.1:8545";
const CHAIN_ID = Number(env.CHAIN_ID || 56);

const OLD = {
  token: env.OLD_TOKEN || "",
  pool: env.OLD_POOL || "",
  mining: env.OLD_MINING || "",
  forceSell: env.OLD_FORCESELL || "",
  config: env.OLD_CONFIG || "",
  referral: env.OLD_REFERRAL || "",
  creator: env.OLD_CREATOR || "",
  pair: env.OLD_PAIR || "",
  usdt: env.USDT || "",
  compute: env.COMPUTE_LIB || "",
};
const KEEPER = env.KEEPER || "";

const die = (m) => {
  console.error("✗", m);
  process.exit(1);
};
for (const [k, v] of Object.entries(OLD)) if (!v && k !== "compute") die(`缺少环境变量：${k}`);
if (!KEEPER) die("缺少 KEEPER");

const art = (name) => {
  const p = path.join(ART, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) die(`找不到 artifact：${p}（先 npx hardhat compile）`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
};
const linkLib = (b, a) => b.replace(/__\$[0-9a-f]{34}\$__/g, a.slice(2).toLowerCase());

const rows = [];
let totalGas = 0n;
const record = (step, gas, note = "") => {
  rows.push({ step, gas, note });
  if (gas) totalGas += gas;
  console.log(`${gas ? "✓" : "✗"} ${step.padEnd(34)} ${gas ? String(gas).padStart(9) + " gas" : ""} ${note}`);
};

async function main() {
  const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  console.log(`RPC: ${RPC}  chainId: ${CHAIN_ID}`);

  // ---------- 0. 旧状态核对（只读） ----------
  console.log("=== 0. 旧状态核对 ===");
  const token = new Contract(
    OLD.token,
    [
      "function owner() view returns (address)",
      "function pool() view returns (address)",
      "function forceSell() view returns (address)",
      "function ledger() view returns (address)",
      "function configAddr() view returns (address)",
      "function totalSupply() view returns (uint256)",
      "function setPool(address)",
      "function setForceSell(address)",
      "function setLedger(address)",
      "function setConfig(address)",
    ],
    provider
  );
  const owner = await token.owner();
  // estimateGas 只需要 from 地址，不需要私钥；默认用真实 owner，可被 DRYRUN_FROM 覆盖
  const from = (env.DRYRUN_FROM || owner).trim();
  if (from.toLowerCase() !== owner.toLowerCase()) {
    console.log(`⚠ from(${from}) 不是代币 owner(${owner})，owner-only 步骤预计会失败（仅部署估价仍有效）`);
  }
  console.log(`模拟 from（无需私钥）: ${from}`);
  console.log(`该地址余额: ${formatEther(await provider.getBalance(from))} BNB\n`);
  for (const [n, cur, exp] of [
    ["pool", await token.pool(), OLD.pool],
    ["forceSell", await token.forceSell(), OLD.forceSell],
    ["ledger", await token.ledger(), OLD.mining],
    ["config", await token.configAddr(), OLD.config],
  ]) {
    if (String(cur).toLowerCase() !== String(exp).toLowerCase()) die(`代币 ${n} 指向 ${cur}，与预期不符`);
  }
  console.log(`✓ owner 一致；四点仍指向旧合约`);

  const oldMining = new Contract(OLD.mining, ["function launchDay() view returns (uint64)"], provider);
  let launchDay = 0n;
  try {
    launchDay = await oldMining.launchDay();
    console.log(`✓ 旧 launchDay 可读：${launchDay}`);
  } catch {
    die("旧 Mining 的 launchDay() 不可读 —— 继承步骤会失败，禁止继续");
  }
  const pair = new Contract(OLD.pair, ["function getReserves() view returns (uint112,uint112,uint32)"], provider);
  const [r0, r1] = await pair.getReserves();
  console.log(`✓ 池储备：${r0} / ${r1}（基线口径，切换后应逐 wei 不变）\n`);

  // ---------- 1. 部署交易估价 ----------
  console.log("=== 1. 部署交易 estimateGas ===");
  const nonce = await provider.getTransactionCount(from, "pending");
  const plan = [];
  const addDeploy = (name, args = [], libs = {}) => plan.push({ name, args, libs });

  addDeploy("ZYTConfig");
  addDeploy("ZYTPoolManager", ["__CONFIG__", OLD.token, OLD.usdt]);
  addDeploy("ZYTMining", ["__CONFIG__", "__POOL__", OLD.referral, OLD.token, OLD.usdt], OLD.compute ? { ZYTCompute: OLD.compute } : {});
  addDeploy("ZYTForceSell", [OLD.token]);
  addDeploy("ZYTDeflation", ["__CONFIG__", "__POOL__", "__MINING__"]);

  // 先按 nonce 推导 5 个地址（部署顺序即 nonce 顺序）
  const predicted = {};
  plan.forEach((p, i) => {
    predicted[p.name] = getCreateAddress({ from, nonce: nonce + i });
  });
  console.log(`  预测地址：`);
  for (const [n, a] of Object.entries(predicted)) console.log(`    ${n.padEnd(16)} ${a}`);
  console.log("");

  for (const p of plan) {
    const a = art(p.name);
    let bytecode = a.bytecode;
    for (const [lib, addr] of Object.entries(p.libs)) bytecode = linkLib(bytecode, addr);
    if (bytecode.includes("__$")) {
      record(`${p.name} 部署`, 0n, "未链接的库占位符（检查 COMPUTE_LIB）");
      continue;
    }
    const PH = { __CONFIG__: "ZYTConfig", __POOL__: "ZYTPoolManager", __MINING__: "ZYTMining" };
    const args = p.args.map((x) => (typeof x === "string" && PH[x] ? predicted[PH[x]] : x));
    try {
      const f = new ContractFactory(a.abi, bytecode); // 不需要 signer，只构造部署交易
      const tx = await f.getDeployTransaction(...args);
      const gas = await provider.estimateGas({ ...tx, from });
      record(`${p.name} 部署`, gas);
    } catch (e) {
      record(`${p.name} 部署`, 0n, e.shortMessage || String(e.message).slice(0, 60));
    }
  }

  // ---------- 2. 旧合约授权 / 代币四点估价 ----------
  console.log("\n=== 2. 旧合约授权与四点切换 estimateGas ===");
  const REF = new Contract(OLD.referral, ["function setMining(address)"], provider);
  const CRE = new Contract(OLD.creator, ["function setPoolManager(address)"], provider);
  const TOK = new Contract(
    OLD.token,
    ["function setPool(address)", "function setForceSell(address)", "function setLedger(address)", "function setConfig(address)"],
    provider
  );

  const est = async (label, contract, method, arg) => {
    try {
      const tx = await contract[method].populateTransaction(arg);
      const gas = await provider.estimateGas({ ...tx, from });
      record(label, gas);
    } catch (e) {
      record(label, 0n, e.shortMessage || String(e.message).slice(0, 60));
    }
  };

  // 白名单（5.5 步）：只对当前还不是白名单的地址估价，已设定则跳过
  const tokenWL = new Contract(
    OLD.token,
    ["function isWhiteList(address) view returns (bool)", "function setWhiteList(address,bool)"],
    provider
  );
  const WL = [
    ["新池管", predicted.ZYTPoolManager],
    ["blackHole", env.BLACK_HOLE || "0x000000000000000000000000000000000000dEaD"],
    ["keeper", KEEPER],
    ["owner", from],
    ...(env.WHITELIST_ADDRS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((a, i) => [`额外${i + 1}`, a]),
  ];
  for (const [n, a] of WL) {
    if (!a) continue;
    let already = false;
    try {
      already = await tokenWL.isWhiteList(a);
    } catch {
      /* 读不到就当未设定，继续估价 */
    }
    if (already) {
      console.log(`= ${`setWhiteList(${n})`.padEnd(34)} 已在白名单，跳过`);
      rows.push({ step: `setWhiteList(${n})`, gas: 0n, skipped: true });
      continue;
    }
    try {
      const tx = await tokenWL.setWhiteList.populateTransaction(a, true);
      const gas = await provider.estimateGas({ ...tx, from });
      record(`setWhiteList(${n})`, gas);
    } catch (e) {
      record(`setWhiteList(${n})`, 0n, e.shortMessage || String(e.message).slice(0, 50));
    }
  }

  await est("referral.setMining(新)", REF, "setMining", predicted.ZYTMining);
  await est("creator.setPoolManager(新)", CRE, "setPoolManager", predicted.ZYTPoolManager);
  await est("token.setPool(新)", TOK, "setPool", predicted.ZYTPoolManager);
  await est("token.setForceSell(新)", TOK, "setForceSell", predicted.ZYTForceSell);
  await est("token.setLedger(新)", TOK, "setLedger", predicted.ZYTMining);
  await est("token.setConfig(新)", TOK, "setConfig", predicted.ZYTConfig);

  // ---------- 3. 汇总 ----------
  const fee = await provider.getFeeData();
  const gp = fee.gasPrice || 0n;
  const cost = totalGas * gp;
  const bal = await provider.getBalance(from);
  console.log("\n=== 3. 汇总 ===");
  console.log(`估算总 gas（部署 + 授权/切换，不含 setUserData）: ${totalGas}`);
  console.log(`当前 gasPrice: ${Number(gp) / 1e9} gwei → 预计花费: ${formatEther(cost)} BNB`);
  console.log(`账户余额: ${formatEther(bal)} BNB ${bal >= cost ? "✓ 足够" : "⚠ 不足，需先充值"}`);
  console.log(`注意：setUserData（75 户 ≈ 2 批）+ seedDividend 未计入，建议额外预留 30% 余量`);

  const failed = rows.filter((r) => !r.gas && !r.skipped);
  const skipped = rows.filter((r) => r.skipped).length;
  const execCount = rows.filter((r) => r.gas > 0n).length;
  console.log(`\n结果：${execCount} 笔将执行 / ${skipped} 笔已在白名单跳过 / ${failed.length} 笔会失败`);
  if (failed.length) process.exit(1);
}

main().catch((e) => die(e.shortMessage || e.stack || e.message));
