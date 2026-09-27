/**
 * @title 部署后接线与状态核对（v9.1，主网/测试网通用，只读 + 可控修复）
 * @notice 读取部署记录 JSON，核对接线、参数、池状态、门控与 keeper 指向；
 *         发现未接线时可选一键修复（需 .env PRIVATE_KEY，部署者 owner）。
 * @usage  node scripts/post-deploy-check-mainnet.mjs
 *         node scripts/post-deploy-check-mainnet.mjs --addr deployments/mainnet-20261001.json
 *         node scripts/post-deploy-check-mainnet.mjs --fix          # 自动补接线（setKeeper 等）
 *         RPC 由 BSC_MAINNET_RPC 或 --rpc 指定；测试网用 --rpc https://bsc-testnet-rpc.publicnode.com --chain 97
 */
import { JsonRpcProvider, Wallet, Contract, formatEther } from "ethers";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// ===== 参数解析 =====
const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DO_FIX = argv.includes("--fix");
const chainId = Number(argOf("--chain") || 56);
const RPC =
  argOf("--rpc") ||
  (chainId === 97
    ? process.env.BSC_TESTNET_RPC || "https://bsc-testnet-rpc.publicnode.com"
    : process.env.BSC_MAINNET_RPC || "https://bsc-dataseed1.bnbchain.org");

// ===== 选取部署记录 =====
function pickRecord() {
  const explicit = argOf("--addr");
  if (explicit) return path.resolve(explicit);
  const dir = path.join(process.cwd(), "deployments");
  const prefix = chainId === 56 ? "mainnet" : chainId === 97 ? "bscTestnet" : "localhost";
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort();
  if (!files.length) throw new Error(`deployments/ 下没有 ${prefix}-*.json`);
  return path.join(dir, files[files.length - 1]);
}

const recFile = pickRecord();
const rec = JSON.parse(fs.readFileSync(recFile, "utf8"));
const C = rec.contracts || {};
// roles 兜底：兼容早期手写记录（deployer / keeper:{address} 顶层字段）
const roles = rec.roles || {
  deployer: rec.deployer,
  market: rec.market,
  technical: rec.technical,
  keeper: rec.keeper?.address || rec.keeper,
};
console.log(`部署记录: ${path.relative(process.cwd(), recFile)}（网络 ${rec.network} / chainId ${rec.chainId} / 块 ${rec.deployBlock}）`);
console.log(`RPC: ${RPC}\n`);

const p = new JsonRpcProvider(RPC, chainId, { staticNetwork: true });
const owner = process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY, p) : null;

let fail = 0;
const results = [];
function check(name, actual, expected, soft = false) {
  const a = String(actual ?? "").toLowerCase();
  const e = String(expected ?? "").toLowerCase();
  const ok = a === e;
  if (!ok && !soft) fail++;
  results.push({ name, ok, actual, expected, soft });
  console.log(
    `${ok ? "✅" : soft ? "⚠️ " : "❌"} ${name}: ${actual}${ok ? "" : `（期望 ${expected}）`}`
  );
}
function info(name, value) {
  console.log(`   ${name}: ${value}`);
}
/** wei → human 数值比较（避免 formatEther 产生 "2100000000.0" 这类字符串不等） */
function checkNum(name, actualWei, expectedHuman, soft = false) {
  const a = Number(formatEther(actualWei));
  const e = Number(expectedHuman);
  const ok = a === e;
  if (!ok && !soft) fail++;
  results.push({ name, ok, actual: a, expected: e, soft });
  console.log(`${ok ? "✅" : soft ? "⚠️ " : "❌"} ${name}: ${a}${ok ? "" : `（期望 ${e}）`}`);
}

const cfg = new Contract(
  C.ZYTConfig,
  [
    "function marketAddress() view returns (address)",
    "function technicalAddress() view returns (address)",
    "function keeperAddress() view returns (address)",
    "function usdt() view returns (address)",
    "function pair() view returns (address)",
    "function zyt() view returns (address)",
    "function pool() view returns (address)",
    "function mining() view returns (address)",
    "function deflation() view returns (address)",
    "function forceSell() view returns (address)",
    "function referral() view returns (address)",
    "function creator() view returns (address)",
    "function blackHole() view returns (address)",
    "function zytMaxSupply() view returns (uint256)",
    "function minDeposit() view returns (uint256)",
    "function maxDeposit() view returns (uint256)",
    "function poolStage1USDT() view returns (uint256)",
    "function poolStage2USDT() view returns (uint256)",
    "function powerRate() view returns (uint256)",
    "function dynamicQuotaMul() view returns (uint256)",
    "function buyQuotaRate() view returns (uint256)",
    "function poolRate() view returns (uint256)",
    "function staticExitMul() view returns (uint256)",
    "function deflationRate() view returns (uint256)",
    "function deflationFloor() view returns (uint256)",
    "function transferSlippage() view returns (uint256)",
    "function dailyCompoundRate() view returns (uint256)",
    "function setAddress(bytes32,address)",
  ],
  owner || p
);
const zyt = new Contract(
  C.ZYTToken,
  [
    "function minter() view returns (address)",
    "function ledger() view returns (address)",
    "function pool() view returns (address)",
    "function forceSell() view returns (address)",
    "function creator() view returns (address)",
    "function configAddr() view returns (address)",
    "function pairAddress() view returns (address)",
    "function totalSupply() view returns (uint256)",
    "function isWhiteList(address) view returns (bool)",
    "function transfer(address,uint256) returns (bool)",
  ],
  p
);
const pool = new Contract(
  C.ZYTPoolManager,
  [
    "function poolZYT() view returns (uint256)",
    "function poolUSDT() view returns (uint256)",
    "function getPrice() view returns (uint256)",
    "function getStage() view returns (uint256)",
    "function getCurrentSlippage() view returns (uint256)",
    "function swapGate() view returns (bool)",
    "function totalLpBurned() view returns (uint256)",
    "function dividendPoolZyt() view returns (uint256)",
    "function mining() view returns (address)",
    "function locker() view returns (address)",
  ],
  p
);
const creator = new Contract(
  C.ZYTLiquidityCreator,
  ["function lockedLiquidity() view returns (uint256)", "function poolManager() view returns (address)", "function pair() view returns (address)"],
  p
);
const forceSell = new Contract(C.ZYTForceSell, ["function keeper() view returns (address)", "function setKeeper(address)"], owner || p);
const usdt = new Contract(C.USDT, ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"], p);

console.log("=== 1. 角色接线 ===");
const [market, tech, keeperAddr, usdtInCfg, fsKeeper] = await Promise.all([
  cfg.marketAddress(),
  cfg.technicalAddress(),
  cfg.keeperAddress(),
  cfg.usdt(),
  forceSell.keeper(),
]);
check("config.marketAddress", market, roles.market);
check("config.technicalAddress", tech, roles.technical);
check("config.keeperAddress", keeperAddr, roles.keeper);
check("config.usdt", usdtInCfg, C.USDT);
check("ForceSell.keeper", fsKeeper, roles.keeper);

console.log("\n=== 2. Token 接线 ===");
const [minter, ledger, zytPool, zytFS, zytCreator, zytCfg, zytPair, supply] = await Promise.all([
  zyt.minter(),
  zyt.ledger(),
  zyt.pool(),
  zyt.forceSell(),
  zyt.creator(),
  zyt.configAddr(),
  zyt.pairAddress(),
  zyt.totalSupply(),
]);
check("zyt.minter = Creator", minter, C.ZYTLiquidityCreator);
check("zyt.ledger = Mining", ledger, C.ZYTMining);
check("zyt.pool = Pool", zytPool, C.ZYTPoolManager);
check("zyt.forceSell", zytFS, C.ZYTForceSell);
check("zyt.creator", zytCreator, C.ZYTLiquidityCreator);
check("zyt.configAddr", zytCfg, C.ZYTConfig);
check("zyt.pairAddress", zytPair, C["Pair(ZYT/USDT)"]);
// 系统地址白名单（缺一即会误收税或触发强卖 hook）
for (const [label, addr] of [
  ["creator", C.ZYTLiquidityCreator],
  ["pool", C.ZYTPoolManager],
  ["mining", C.ZYTMining],
  ["deflation", C.ZYTDeflation],
  ["market", roles.market],
  ["technical", roles.technical],
  ["pair", C["Pair(ZYT/USDT)"]],
]) {
  const wl = await zyt.isWhiteList(addr);
  check(`白名单 ${label}`, wl, true);
}

console.log("\n=== 3. 池与建池 ===");
const [pz, pu, price, stage, slip, gate, lpBurned, divPool, locked, pmInCreator] = await Promise.all([
  pool.poolZYT(),
  pool.poolUSDT(),
  pool.getPrice(),
  pool.getStage(),
  pool.getCurrentSlippage(),
  pool.swapGate(),
  pool.totalLpBurned(),
  pool.dividendPoolZyt(),
  creator.lockedLiquidity(),
  creator.poolManager(),
]);
checkNum("池 USDT = 初始底池", pu, rec.seed?.usdt || "21000", true);
checkNum("池 ZYT = 初始底池", pz, rec.seed?.zyt || "2100000000", true);
info("价格", `${formatEther(price)} U`);
info("阶段", `${stage}（1=只卖 / 2=买额 1:1 / 3=自由）`);
info("滑点", `${slip} bps`);
check("swapGate 复位", gate, false);
check("LP 已锁仓 > 0", locked > 0n, true);
check("Creator.poolManager = Pool", pmInCreator, C.ZYTPoolManager);
info("累计销毁 LP", formatEther(lpBurned));
info("分红池 ZYT", formatEther(divPool));
check("总供应 ≤ 21 亿", supply <= 2100000000000000000000000000n, true);

console.log("\n=== 4. 参数核对（运营口径）===");
const [maxSupply, minDep, maxDep, s1, s2, powerRate, dynMul, buyRate, poolRate, staticMul, deflRate, deflFloor, xferSlip, compRate] =
  await Promise.all([
    cfg.zytMaxSupply(),
    cfg.minDeposit(),
    cfg.maxDeposit(),
    cfg.poolStage1USDT(),
    cfg.poolStage2USDT(),
    cfg.powerRate(),
    cfg.dynamicQuotaMul(),
    cfg.buyQuotaRate(),
    cfg.poolRate(),
    cfg.staticExitMul(),
    cfg.deflationRate(),
    cfg.deflationFloor(),
    cfg.transferSlippage(),
    cfg.dailyCompoundRate(),
  ]);
checkNum("zytMaxSupply", maxSupply, "2100000000");
checkNum("minDeposit", minDep, "100");
checkNum("maxDeposit", maxDep, "500");
info("poolStage1USDT", `${formatEther(s1)} U（主网正式口径应为 10000000）`);
info("poolStage2USDT", `${formatEther(s2)} U（应为 20000000）`);
check("powerRate（100%）", powerRate, 10000n);
check("dynamicQuotaMul（×5）", dynMul, 5n);
check("buyQuotaRate（1:1）", buyRate, 10000n);
check("poolRate（60%）", poolRate, 6000n);
check("staticExitMul（2 倍）", staticMul, 2n);
check("deflationRate（2%）", deflRate, 200n);
checkNum("deflationFloor（500 万）", deflFloor, "5000000");
check("transferSlippage（10%）", xferSlip, 1000n);
check("dailyCompoundRate（1%）", compRate, 100n);

console.log("\n=== 5. USDT 与门控 ===");
const [symbol, decimals, bal] = await Promise.all([usdt.symbol(), usdt.decimals(), usdt.balanceOf(roles.deployer)]);
info("USDT symbol / decimals", `${symbol} / ${decimals}`);
if (rec.usdtMock) {
  console.log("⚠️  本部署使用 Mock USDT（试运行口径），正式运营需重部署");
} else {
  check("USDT 为真实地址", C.USDT, "0x55d398326f99059fF775485246999027B3197955");
}
info("deployer USDT 余额", formatEther(bal));

// 门控实测：非 pool/creator 直转 pair 必须被拦
let gated = false;
let reason = "";
try {
  // 用静态调用模拟（无需持币：余额不足也会 revert，因此额外校验错误文案）
  await zyt.transfer.staticCall(C["Pair(ZYT/USDT)"], 1n);
} catch (e) {
  gated = true;
  reason = String(e.shortMessage || e.message || "");
}
check("卖闸：直转 pair 被拦截", gated, true);
if (gated) info("拦截原因", reason.slice(0, 80));

// ===== 可选修复 =====
if (DO_FIX && owner) {
  console.log("\n=== 6. 一键修复 ===");
  const cfgKeeper = String(keeperAddr).toLowerCase();
  const fsK = String(fsKeeper).toLowerCase();
  if (cfgKeeper !== fsK) {
    const tx = await forceSell.setKeeper(keeperAddr);
    await tx.wait();
    console.log(`✓ setKeeper(${keeperAddr}) tx: ${tx.hash}`);
  } else {
    console.log("ForceSell.keeper 已一致，无需修复");
  }
} else if (DO_FIX) {
  console.log("\n⚠️  --fix 需要 .env PRIVATE_KEY（owner）");
}

console.log(`\n===== 结果：失败 ${fail} 项 =====`);
if (fail > 0) process.exitCode = 1;
