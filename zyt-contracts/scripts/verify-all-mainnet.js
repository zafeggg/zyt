/* global ethers hre */
/**
 * @title bscscan 批量源码验证（v9.1，主网/测试网通用）
 * @notice 读取部署记录 JSON（deploy.js 自动生成），按依赖顺序验证全部合约；
 *         真实 USDT 已由币安 verify，脚本自动跳过。
 * @usage  npx hardhat run scripts/verify-all-mainnet.js --network bsc
 *         npx hardhat run scripts/verify-all-mainnet.js --network bscTestnet   # 测试网同理
 * @args   VERIFY_FILE=deployments/xxx.json（可选，缺省自动取最新匹配记录）
 * @note   顺序要求：库 → 无依赖 → 单依赖 → 多依赖（bscscan 需先有依赖源码）
 *         代理：国内直连 api.etherscan.io 不稳定，VERIFY_PROXY 默认走本机 7890，设 off 跳过
 */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");

// ===== 网络代理注入 =====
const PROXY = process.env.VERIFY_PROXY !== undefined ? process.env.VERIFY_PROXY : "http://127.0.0.1:7890";
if (PROXY && PROXY !== "off") {
  const { ProxyAgent, setGlobalDispatcher } = require("undici");
  setGlobalDispatcher(new ProxyAgent(PROXY));
  console.log(`[proxy] fetch dispatcher -> ${PROXY}`);
}

const BLACK_HOLE = "0x000000000000000000000000000000000000dEaD";
/** 真实 USDT（币安已 verify，无需重复） */
const REAL_USDT = "0x55d398326f99059fF775485246999027B3197955";

/** 自动选择部署记录：优先 VERIFY_FILE，其次按网络取最新 */
function pickRecordFile(network) {
  const dir = path.join(__dirname, "..", "deployments");
  if (process.env.VERIFY_FILE) return path.join(__dirname, "..", process.env.VERIFY_FILE);
  const prefix = network === "bsc" ? "mainnet" : network;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort();
  if (!files.length) throw new Error(`deployments/ 下没有 ${prefix}-*.json 部署记录`);
  return path.join(dir, files[files.length - 1]);
}

async function main() {
  if (!process.env.BSCSCAN_API_KEY) {
    console.error("❌ 缺少 BSCSCAN_API_KEY（.env 中为空），请先配置");
    process.exit(1);
  }
  const network = hre.network.name;
  const file = pickRecordFile(network);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  const C = rec.contracts || {};
  const A = rec.constructorArgs || {};
  console.log(`部署记录: ${path.relative(path.join(__dirname, ".."), file)}（${rec.deployedAt}，块 ${rec.deployBlock}）\n`);

  // ===== 按依赖顺序构造验证清单（v9.1）=====
  const TASKS = [
    // 1. 库（必须先验证，供 ZYTMining 引用）
    { name: "ZYTCompute", addr: C.ZYTCompute, args: A.ZYTCompute || [] },
    // 2. 无依赖
    { name: "ZYTConfig", addr: C.ZYTConfig, args: A.ZYTConfig || [] },
    { name: "ZYTToken", addr: C.ZYTToken, args: A.ZYTToken || [BLACK_HOLE] },
    { name: "ZYTReferral", addr: C.ZYTReferral, args: A.ZYTReferral || [] },
    // 3. 单依赖
    { name: "ZYTForceSell", addr: C.ZYTForceSell, args: A.ZYTForceSell || [C.ZYTToken] },
    { name: "ZYTPoolManager", addr: C.ZYTPoolManager, args: A.ZYTPoolManager || [C.ZYTConfig, C.ZYTToken, C.USDT] },
    { name: "ZYTLiquidityCreator", addr: C.ZYTLiquidityCreator, args: A.ZYTLiquidityCreator || [C.ZYTToken, C.USDT, rec.factory, BLACK_HOLE] },
    // 4. 多依赖 + 库链接（全限定名必须含文件路径）
    {
      name: "ZYTMining",
      addr: C.ZYTMining,
      args: A.ZYTMining || [C.ZYTConfig, C.ZYTPoolManager, C.ZYTReferral, C.ZYTToken, C.USDT],
      libraries: rec.libraries || { "contracts/ZYTCompute.sol:ZYTCompute": C.ZYTCompute },
    },
    { name: "ZYTDeflation", addr: C.ZYTDeflation, args: A.ZYTDeflation || [C.ZYTConfig, C.ZYTPoolManager, C.ZYTMining] },
  ];
  if (rec.usdtMock) {
    TASKS.push({ name: "contracts/mocks/MockERC20.sol:MockERC20", addr: C.USDT, args: ["Mock USDT", "USDT", 18] });
  } else {
    console.log(`跳过 USDT 验证（真实 USDT ${REAL_USDT} 已由币安 verify）\n`);
  }

  let ok = 0;
  let fail = 0;
  for (const t of TASKS) {
    if (!t.addr) {
      console.log(`跳过 ${t.name}（记录中无地址）`);
      continue;
    }
    process.stdout.write(`验证 ${t.name} @ ${t.addr} ... `);
    try {
      await hre.run("verify:verify", {
        address: t.addr,
        constructorArguments: t.args,
        libraries: t.libraries || {},
      });
      console.log("✅");
      ok++;
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("Already Verified")) {
        console.log("✅（已验证过）");
        ok++;
      } else {
        console.log("❌ " + msg.slice(0, 200));
        fail++;
      }
    }
    // bscscan 免费 API 限速：请求间隔 2s
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`\n=== 验证完成：成功 ${ok} / 失败 ${fail}（共 ${TASKS.length}）===`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ERROR:", String(e.message || e).slice(0, 400));
  process.exit(1);
});
