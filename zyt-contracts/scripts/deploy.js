// SPDX-License-Identifier: MIT
/* global ethers hre */
const { ethers } = require("hardhat");

/**
 * @notice 众赢币 ZYT 部署脚本（按方案 v6 部署流程）
 *
 * 流程：ZYTConfig → GSTToken → ZYTToken → ZYTForceSell → ZYTPoolManager
 *       → ZYTReferral → ZYTMining → ZYTDeflation → 接线 → 底池初始化
 *
 * 用法：
 *   npx hardhat run scripts/deploy.js                 # 本地 hardhat（Mock USDT）
 *   npx hardhat run scripts/deploy.js --network bscTestnet
 */

const GST_MAX = 333_000_000n * 10n ** 18n;      // 3.33 亿
const GST_POOL = 21_000n * 10n ** 18n;          // 底池 2.1 万枚
const ZYT_MAX = 2_100_000_000n * 10n ** 18n;    // 21 亿
const BLACK_HOLE = "0x000000000000000000000000000000000000dEaD";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const network = hre.network.name;
  const isLocal = network === "hardhat" || network === "localhost";

  // ---------- 1. USDT ----------
  // USDT_MOCK=1：testnet 用 MockERC20（可 faucet），主网用真实 USDT（默认）
  const useMockUsdt = isLocal || process.env.USDT_MOCK === "1";
  let usdt;
  if (useMockUsdt) {
    const Mock = await ethers.getContractFactory("MockERC20");
    usdt = await Mock.deploy("Mock USDT", "USDT", 18);
    await usdt.waitForDeployment();
    // 测试网水龙头：给部署者 5 万 USDT（覆盖 initialize 2.1 万 + 测试入金）
    await (await usdt.faucet(50_000n * 10n ** 18n)).wait();
    console.log("MockUSDT:", await usdt.getAddress());
  } else {
    // 真实 USDT：包装为合约对象（allowance/approve 统一接口）
    usdt = await ethers.getContractAt(
      "MockERC20",
      process.env.USDT_MAINNET || "0x55d398326f99059fF775485246999027B3197955"
    );
  }
  const usdtAddr = await usdt.getAddress();

  // ---------- 2. ZYTConfig ----------
  const Config = await ethers.getContractFactory("ZYTConfig");
  const config = await Config.deploy();
  await config.waitForDeployment();
  const configAddr = await config.getAddress();
  console.log("ZYTConfig:", configAddr);

  // ---------- 3. GSTToken ----------
  const GST = await ethers.getContractFactory("GSTToken");
  const gst = await GST.deploy(BLACK_HOLE);
  await gst.waitForDeployment();
  const gstAddr = await gst.getAddress();
  console.log("GSTToken:", gstAddr);

  // ---------- 4. ZYTToken ----------
  const ZYT = await ethers.getContractFactory("ZYTToken");
  const zyt = await ZYT.deploy(BLACK_HOLE);
  await zyt.waitForDeployment();
  const zytAddr = await zyt.getAddress();
  console.log("ZYTToken:", zytAddr);

  // ---------- 5. ZYTForceSell ----------
  const ForceSell = await ethers.getContractFactory("ZYTForceSell");
  const forceSell = await ForceSell.deploy(zytAddr);
  await forceSell.waitForDeployment();
  const forceSellAddr = await forceSell.getAddress();
  console.log("ZYTForceSell:", forceSellAddr);

  // ---------- 6. ZYTPoolManager ----------
  const Pool = await ethers.getContractFactory("ZYTPoolManager");
  const pool = await Pool.deploy(configAddr, zytAddr, usdtAddr, gstAddr);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("ZYTPoolManager:", poolAddr);

  // ---------- 7. ZYTReferral ----------
  const Referral = await ethers.getContractFactory("ZYTReferral");
  const referral = await Referral.deploy();
  await referral.waitForDeployment();
  const referralAddr = await referral.getAddress();
  console.log("ZYTReferral:", referralAddr);

  // ---------- 8. ZYTMining ----------
  const Compute = await ethers.getContractFactory("ZYTCompute");
  const compute = await Compute.deploy();
  await compute.waitForDeployment();
  const computeAddr = await compute.getAddress();
  console.log("ZYTCompute(lib):", computeAddr);

  const Mining = await ethers.getContractFactory("ZYTMining", {
    libraries: { ZYTCompute: computeAddr },
  });
  const mining = await Mining.deploy(configAddr, poolAddr, referralAddr, zytAddr, usdtAddr);
  await mining.waitForDeployment();
  const miningAddr = await mining.getAddress();
  console.log("ZYTMining:", miningAddr);

  // ---------- 9. ZYTDeflation ----------
  const Deflation = await ethers.getContractFactory("ZYTDeflation");
  const deflation = await Deflation.deploy(configAddr, poolAddr, miningAddr);
  await deflation.waitForDeployment();
  const deflationAddr = await deflation.getAddress();
  console.log("ZYTDeflation:", deflationAddr);

  // ---------- 10. 接线 ----------
  const market = process.env.MARKET_ADDRESS || deployer.address;
  const technical = process.env.TECHNICAL_ADDRESS || deployer.address;
  const router = process.env.ROUTER_MAINNET || "0x10ED43C718714eb63d5aA57B78B54704E256024E";

  await config.setAddress("marketAddress", market);
  await config.setAddress("technicalAddress", technical);
  await config.setAddress("blackHole", BLACK_HOLE);
  await config.setAddress("router", router);
  await config.setAddress("usdt", usdtAddr);
  await config.setAddress("gst", gstAddr);
  await config.setAddress("zyt", zytAddr);
  await config.setAddress("pool", poolAddr);
  await config.setAddress("mining", miningAddr);
  await config.setAddress("deflation", deflationAddr);
  await config.setAddress("forceSell", forceSellAddr);
  await config.setAddress("referral", referralAddr);
  // P2-3 修复：接入 Keeper 触发地址（快照/通缩；生产用 KEEPER_ADDRESS 环境变量，默认 deployer=owner 兜底）
  // 漏设会导致 owner 转多签后 dailySnapshot 无人可触发（仅多签 owner 可调，链路断裂）
  await config.setAddress("keeperAddress", process.env.KEEPER_ADDRESS || deployer.address);
  console.log("Config wired.");

  await zyt.setMinter(miningAddr);
  await zyt.setPool(poolAddr);
  await zyt.setForceSell(forceSellAddr);
  // P0-1 修复：接入 ZYTConfig（V6 转账滑点率 + V7 totalSupplyCap 保险丝）
  // 漏设会导致 configAddr=0 → 转账 10% 税跳过、mint 增发上限失效（生产安全机制静默关闭）
  await zyt.setConfig(configAddr);
  await zyt.setWhiteList(poolAddr, true);
  await zyt.setWhiteList(miningAddr, true);
  await zyt.setWhiteList(deflationAddr, true);
  // P2-2 白名单保护：营销/技术地址豁免强制卖出初始化（收到的营销/技术 ZYT 不受 60 天强制卖出约束）
  await zyt.setWhiteList(market, true);
  await zyt.setWhiteList(technical, true);
  console.log("ZYTToken wired.");

  await pool.setMining(miningAddr);
  await pool.setDeflation(deflationAddr);
  await referral.setMining(miningAddr);
  await mining.setDeflation(deflationAddr);
  console.log("Deps wired.");

  // ---------- 11. 底池初始化 ----------
  // 部署者授权 GST + USDT 给池合约（V5：initialize 真实转入 2.1 万 USDT 消除账面缺口）
  await gst.approve(poolAddr, GST_POOL);
  if (useMockUsdt) {
    // mock：直接 approve（deployer 已 faucet 5 万）
    await usdt.approve(poolAddr, GST_POOL);
  } else {
    // 真实 USDT：deployer 需先持有 2.1 万并 approve（主网部署清单必做）
    const allowance = await usdt.allowance(deployer.address, poolAddr);
    if (allowance < GST_POOL) {
      throw new Error(
        "USDT allowance < 21000. 主网部署需先持有 2.1 万 USDT 并 approve 给 pool（见部署清单）"
      );
    }
  }
  await pool.initialize(GST_POOL, ZYT_MAX);
  console.log("Pool initialized: GST=%s ZYT=%s", GST_POOL.toString(), ZYT_MAX.toString());

  // 其余 GST 永久锁定（转黑洞）
  await gst.lockRemaining();
  console.log("GST remaining supply locked to blackhole.");

  // ---------- 12. 启动阶段门控（P0-2 决策：推荐 A） ----------
  // 初始 poolUSDT=2.1万 < 默认门槛 1000万 → 若保持默认会永远 stage1（deposit/addLiquidity 全拒，系统锁死）。
  // 决策 A：跳过「<1000万只卖不买」阶段，初始直接 stage2（LP 额度 1:1）启动；
  // poolStage2USDT 保持 2000 万 → poolUSDT 达标后自动进 stage3（白名单内自由买卖）。
  await config.setUint("poolStage1USDT", 0);

  // ---------- 13. 首批买入白名单（P2-4：v7 买入白名单全程启用，需运营放行用户） ----------
  // 用法：WHITELIST="0xaddr1,0xaddr2" npx hardhat run scripts/deploy.js --network bscTestnet
  // 默认空：运营后续通过多签 setBuyWhitelist/setBuyWhitelistBatch 添加（多签转移前由 deployer 执行）
  const whitelist = (process.env.WHITELIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (whitelist.length > 0) {
    await pool.setBuyWhitelistBatch(whitelist, true);
    console.log(`Buy whitelist added: ${whitelist.length} addrs`);
  }

  // ---------- 14. 摘要 ----------
  console.log("\n===== DEPLOYMENT SUMMARY =====");
  console.log("ZYTConfig     :", configAddr);
  console.log("GSTToken      :", gstAddr);
  console.log("ZYTToken      :", zytAddr);
  console.log("ZYTForceSell  :", forceSellAddr);
  console.log("ZYTPoolManager:", poolAddr);
  console.log("ZYTReferral   :", referralAddr);
  console.log("ZYTMining     :", miningAddr);
  console.log("ZYTDeflation  :", deflationAddr);
  console.log("USDT          :", usdtAddr);
  console.log("Router        :", router);
  console.log("Market        :", market);
  console.log("Technical     :", technical);
  console.log("\n⚠️ 生产环境：请将 config.owner 转移至 Gnosis Safe 多签");
  console.log("⚠️ 生产环境：GST/USDT 池与 ZYT 底池的 DEX 流动性操作需人工确认");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
