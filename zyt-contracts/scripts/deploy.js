// SPDX-License-Identifier: MIT
/* global ethers hre */
const { ethers } = require("hardhat");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

/**
 * @notice 众赢币 ZYT 部署脚本（v9，2026-09-24）
 *
 * v9 范式：弃 GST，USDT↔ZYT 单币直换，真实 PancakeSwap V2 pair 为唯一底池。
 *
 * 流程：USDT → ZYTConfig → ZYTToken → ZYTLiquidityCreator → ZYTPoolManager
 *       → ZYTReferral → ZYTForceSell → ZYTMining(+ZYTCompute lib) → ZYTDeflation
 *       → 接线 → createInitialPool（2.1 万 USDT + 21 亿 ZYT 组池，LP 锁仓）
 *       → setPair ×3 → pair 白名单
 *
 * 用法：
 *   npx hardhat run scripts/deploy.js                 # 本地 hardhat（Mock USDT）
 *   npx hardhat run scripts/deploy.js --network bscTestnet
 *   npx hardhat run scripts/deploy.js --network bsc   # 主网（.env PRIVATE_KEY，交互确认）
 *
 * 私钥约定（2026-09-14 决策）：
 *   - 部署/owner 私钥 = .env PRIVATE_KEY，仅存本地/部署机，严禁上传服务器、严禁提交 Git
 *   - keeper 签名私钥 = 服务器 .env KEEPER_PRIVATE_KEY（权限 600，仅触发快照无资金权限）
 *   - 主网部署需交互输入 yes 确认（脚本化场景设 CONFIRM_MAINNET=1）
 *
 * 主网前置（部署清单）：
 *   - deployer 持有 ≥ 2.1 万 USDT（初始底池）+ BNB（gas）
 *   - MARKET_ADDRESS / TECHNICAL_ADDRESS / KEEPER_ADDRESS 填 Safe 多签或 EOA
 */

const ZYT_MAX = 2_100_000_000n * 10n ** 18n;    // 21 亿（全量一次铸出）
const SEED_USDT = 21_000n * 10n ** 18n;         // 初始底池 2.1 万 USDT
const BLACK_HOLE = "0x000000000000000000000000000000000000dEaD";

/** 主网部署确认（防误操作）：打印网络与 deployer，要求输入 yes；CONFIRM_MAINNET=1 跳过 */
async function confirmMainnet(deployerAddress) {
  if (process.env.CONFIRM_MAINNET === "1") return;
  console.log("\n⚠️  即将在 BSC 主网（chainId 56）执行部署，deployer:", deployerAddress);
  console.log("   主网交易不可逆。确认网络与地址无误后输入 yes 继续:");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const answer = await new Promise((resolve) =>
    rl.question("", (v) => {
      rl.close();
      resolve(v.trim().toLowerCase());
    })
  );
  if (answer !== "yes") {
    console.error("未确认，已取消部署");
    process.exit(1);
  }
}

/**
 * @notice 等待链上授权到位（BSC 公共 RPC 多节点最终一致性：
 *         approve 交易确认后，estimateGas 可能打到未同步节点读到 allowance=0 → revert）。
 */
async function waitAllowance(token, owner, spender, min, label, retries = 15) {
  for (let i = 0; i < retries; i++) {
    const a = await token.allowance(owner, spender);
    if (a >= min) {
      console.log(`allowance ${label} 已同步: ${ethers.formatUnits(a, 18)}`);
      return;
    }
    console.log(`allowance ${label} 未同步(${ethers.formatUnits(a, 18)})，2s 后重试 ${i + 1}/${retries}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`allowance ${label} 同步超时（>${retries * 2}s）`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error(`网络 ${hre.network.name} 无可用 signer（检查 .env PRIVATE_KEY）`);
  console.log("Deployer:", deployer.address);
  if (hre.network.name === "bsc") await confirmMainnet(deployer.address);

  const network = hre.network.name;
  const isLocal = network === "hardhat" || network === "localhost";
  const isBscMainnet = network === "bsc";

  // 统一 factory 入口：显式绑定 deployer signer（各网络行为一致）
  const factory = (name, opts = {}) =>
    ethers.getContractFactory(name, { signer: deployer, ...opts });

  // ---------- 1. USDT ----------
  const useMockUsdt = isLocal || process.env.USDT_MOCK === "1";
  if (useMockUsdt && !isLocal) {
    console.log("\n⚠️  ===============================================");
    console.log("⚠️  主网 TestUSDT 试运行模式（USDT_MOCK=1）");
    console.log("⚠️  本部署使用 TestUSDT（MockERC20），非真实 USDT");
    console.log("⚠️  仅用于主网试运行；正式运营必须重部署正式版（真实 USDT）");
    console.log("⚠️  ===============================================\n");
  }
  let usdt;
  if (useMockUsdt) {
    const Mock = await factory("MockERC20");
    usdt = await Mock.deploy("Mock USDT", "USDT", 18);
    await usdt.waitForDeployment();
    // 测试水龙头：给部署者 5 万 USDT（覆盖初始底池 2.1 万 + 测试入金）
    await (await usdt.faucet(50_000n * 10n ** 18n)).wait();
    console.log("MockUSDT:", await usdt.getAddress());
  } else {
    usdt = await ethers.getContractAt(
      "MockERC20",
      process.env.USDT_MAINNET || "0x55d398326f99059fF775485246999027B3197955",
      deployer
    );
  }
  const usdtAddr = await usdt.getAddress();

  // ---------- 2. ZYTConfig ----------
  const config = await (await factory("ZYTConfig")).deploy();
  await config.waitForDeployment();
  const configAddr = await config.getAddress();
  console.log("ZYTConfig:", configAddr);

  // ---------- 3. ZYTToken ----------
  const zyt = await (await factory("ZYTToken")).deploy(BLACK_HOLE);
  await zyt.waitForDeployment();
  const zytAddr = await zyt.getAddress();
  console.log("ZYTToken:", zytAddr);

  // ---------- 4. ZYTLiquidityCreator（初始建池 + LP 锁仓） ----------
  // factory 按 network 分流（PancakeSwap V2），env 可覆盖；本地 hardhat 部署 MiniFactory
  let factoryAddr;
  if (isLocal) {
    const mini = await (await factory("MiniFactory")).deploy();
    await mini.waitForDeployment();
    factoryAddr = await mini.getAddress();
    console.log("MiniFactory(local):", factoryAddr);
  } else {
    factoryAddr = isBscMainnet
      ? (process.env.FACTORY_MAINNET || "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73")
      : (process.env.FACTORY_TESTNET || "0xB7926C0430Afb07AA7DEfDE6DA862aE0Bde767bc");
    console.log("PancakeFactory:", factoryAddr);
  }
  const creator = await (await factory("ZYTLiquidityCreator")).deploy(
    zytAddr, usdtAddr, factoryAddr, BLACK_HOLE
  );
  await creator.waitForDeployment();
  const creatorAddr = await creator.getAddress();
  console.log("ZYTLiquidityCreator:", creatorAddr);

  // ---------- 5. ZYTPoolManager ----------
  const pool = await (await factory("ZYTPoolManager")).deploy(configAddr, zytAddr, usdtAddr);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("ZYTPoolManager:", poolAddr);

  // ---------- 6. ZYTReferral ----------
  const referral = await (await factory("ZYTReferral")).deploy();
  await referral.waitForDeployment();
  const referralAddr = await referral.getAddress();
  console.log("ZYTReferral:", referralAddr);

  // ---------- 7. ZYTForceSell ----------
  const forceSell = await (await factory("ZYTForceSell")).deploy(zytAddr);
  await forceSell.waitForDeployment();
  const forceSellAddr = await forceSell.getAddress();
  console.log("ZYTForceSell:", forceSellAddr);

  // ---------- 8. ZYTMining（含 ZYTCompute 库） ----------
  const compute = await (await factory("ZYTCompute")).deploy();
  await compute.waitForDeployment();
  const computeAddr = await compute.getAddress();
  console.log("ZYTCompute(lib):", computeAddr);

  const mining = await (await factory("ZYTMining", {
    libraries: { ZYTCompute: computeAddr },
  })).deploy(configAddr, poolAddr, referralAddr, zytAddr, usdtAddr);
  await mining.waitForDeployment();
  const miningAddr = await mining.getAddress();
  console.log("ZYTMining:", miningAddr);

  // ---------- 9. ZYTDeflation ----------
  const deflation = await (await factory("ZYTDeflation")).deploy(configAddr, poolAddr, miningAddr);
  await deflation.waitForDeployment();
  const deflationAddr = await deflation.getAddress();
  console.log("ZYTDeflation:", deflationAddr);

  // ---------- 10. 接线 ----------
  const market = process.env.MARKET_ADDRESS || deployer.address;
  const technical = process.env.TECHNICAL_ADDRESS || deployer.address;

  await config.setAddress("marketAddress", market);
  await config.setAddress("technicalAddress", technical);
  await config.setAddress("blackHole", BLACK_HOLE);
  await config.setAddress("usdt", usdtAddr);
  await config.setAddress("factory", factoryAddr);
  await config.setAddress("zyt", zytAddr);
  await config.setAddress("pool", poolAddr);
  await config.setAddress("mining", miningAddr);
  await config.setAddress("deflation", deflationAddr);
  await config.setAddress("forceSell", forceSellAddr);
  await config.setAddress("referral", referralAddr);
  await config.setAddress("creator", creatorAddr);
  await config.setAddress("keeperAddress", process.env.KEEPER_ADDRESS || deployer.address);
  console.log("Config wired.");

  // ZYTToken：minter=Creator（建池铸 21 亿一次）；ledger=Mining（P1-7 双向记账）
  await zyt.setMinter(creatorAddr);
  await zyt.setLedger(miningAddr);
  await zyt.setPool(poolAddr);
  await zyt.setForceSell(forceSellAddr);
  await zyt.setCreator(creatorAddr);
  await zyt.setConfig(configAddr);
  // 系统豁免（跳过转账税/强卖 hook/记账）：白名单双方
  await zyt.setWhiteList(creatorAddr, true);
  await zyt.setWhiteList(poolAddr, true);
  await zyt.setWhiteList(miningAddr, true);
  await zyt.setWhiteList(deflationAddr, true);
  // 营销/技术地址豁免强制卖出（收到的滑点分成 ZYT 不受 4 期强卖约束）
  await zyt.setWhiteList(market, true);
  await zyt.setWhiteList(technical, true);
  console.log("ZYTToken wired.");

  // Pool：locker=Creator（锁仓 + 通缩报销唯一入口）
  await pool.setLocker(creatorAddr);
  await pool.setMining(miningAddr);
  await pool.setDeflation(deflationAddr);
  await referral.setMining(miningAddr);
  await creator.setPoolManager(poolAddr);
  await mining.setDeflation(deflationAddr);
  await forceSell.setKeeper(process.env.KEEPER_ADDRESS || deployer.address);
  console.log("Deps wired.");

  // ---------- 11. 初始建池（2.1 万 USDT + 21 亿 ZYT，LP 锁仓） ----------
  if (useMockUsdt) {
    await usdt.approve(creatorAddr, SEED_USDT);
  } else {
    const bal = await usdt.balanceOf(deployer.address);
    if (bal < SEED_USDT) {
      throw new Error(
        `USDT 余额不足：${ethers.formatUnits(bal, 18)} < 21000。主网部署需先持有 2.1 万 USDT（见部署清单）`
      );
    }
    const allowance = await usdt.allowance(deployer.address, creatorAddr);
    if (allowance < SEED_USDT) {
      await (await usdt.approve(creatorAddr, SEED_USDT)).wait();
    }
  }
  await waitAllowance(usdt, deployer.address, creatorAddr, SEED_USDT, "USDT→Creator");
  await (await creator.createInitialPool(ZYT_MAX, SEED_USDT)).wait();
  const pairAddr = await creator.pair();
  console.log("Initial pool created:", pairAddr);
  console.log("  ZYT seeded:", ethers.formatUnits(ZYT_MAX, 18), "USDT seeded:", ethers.formatUnits(SEED_USDT, 18));

  // ---------- 12. pair 接线（三处：config / zyt / pool）+ 白名单 ----------
  await config.setAddress("pair", pairAddr);
  await zyt.setPair(pairAddr);
  await pool.setPair(pairAddr);
  await zyt.setWhiteList(pairAddr, true);
  console.log("Pair wired (config + token gate + pool).");

  // ---------- 13. 摘要 ----------
  const locked = await creator.lockedLiquidity();
  console.log("\n===== DEPLOYMENT SUMMARY (v9) =====");
  console.log("ZYTConfig          :", configAddr);
  console.log("ZYTToken           :", zytAddr);
  console.log("ZYTLiquidityCreator:", creatorAddr, "（LP 锁仓:", locked.toString(), "）");
  console.log("ZYTPoolManager     :", poolAddr);
  console.log("ZYTReferral        :", referralAddr);
  console.log("ZYTForceSell       :", forceSellAddr);
  console.log("ZYTMining          :", miningAddr);
  console.log("ZYTDeflation       :", deflationAddr);
  console.log("ZYTCompute(lib)    :", computeAddr);
  console.log("USDT               :", usdtAddr, useMockUsdt && !isLocal ? "（⚠️ TestUSDT 试运行版——正式版需重部署）" : "");
  console.log("PancakeFactory     :", factoryAddr);
  console.log("Pair (ZYT/USDT)    :", pairAddr);
  console.log("Market             :", market);
  console.log("Technical          :", technical);
  console.log("Keeper             :", process.env.KEEPER_ADDRESS || deployer.address);

  // ---------- 14. 部署记录落盘（2026-09-26 新增） ----------
  // 为什么：verify / post-deploy-check / smoke / keeper 部署都依赖这份记录。
  // 手抄地址易错（曾发生「链上实现落后于修复」的事故），统一由此文件作为唯一事实源。
  const deployBlock = await ethers.provider.getBlockNumber();
  const record = {
    version: "v9.1",
    network: hre.network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deployBlock,
    indexerStartBlock: deployBlock - 6, // 索引起点（部署块前 6 块，留重组余量）
    usdtMock: useMockUsdt,
    factory: factoryAddr,
    contracts: {
      ZYTConfig: configAddr,
      ZYTToken: zytAddr,
      ZYTLiquidityCreator: creatorAddr,
      ZYTPoolManager: poolAddr,
      ZYTReferral: referralAddr,
      ZYTForceSell: forceSellAddr,
      ZYTMining: miningAddr,
      ZYTDeflation: deflationAddr,
      ZYTCompute: computeAddr,
      USDT: usdtAddr,
      "Pair(ZYT/USDT)": pairAddr,
    },
    roles: { deployer: deployer.address, market, technical, keeper: process.env.KEEPER_ADDRESS || deployer.address },
    // verify 用构造参数（与上面部署语句一一对应，改部署语句时同步改这里）
    constructorArgs: {
      ZYTCompute: [],
      ZYTConfig: [],
      ZYTToken: [BLACK_HOLE],
      ZYTReferral: [],
      ZYTForceSell: [zytAddr],
      ZYTPoolManager: [configAddr, zytAddr, usdtAddr],
      ZYTMining: [configAddr, poolAddr, referralAddr, zytAddr, usdtAddr],
      ZYTDeflation: [configAddr, poolAddr, miningAddr],
      ZYTLiquidityCreator: [zytAddr, usdtAddr, factoryAddr, BLACK_HOLE],
    },
    libraries: { "contracts/ZYTCompute.sol:ZYTCompute": computeAddr },
    seed: { zyt: ethers.formatUnits(ZYT_MAX, 18), usdt: ethers.formatUnits(SEED_USDT, 18), lpLocked: locked.toString() },
  };
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outFile = path.join(outDir, `${hre.network.name === "bsc" ? "mainnet" : hre.network.name}-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log("\n部署记录已写入:", path.relative(path.join(__dirname, ".."), outFile));
  console.log("后续脚本用法：");
  console.log("  node scripts/mainnet-preflight.mjs --addr", path.relative(path.join(__dirname, ".."), outFile));
  console.log("  npx hardhat run scripts/verify-all-mainnet.js --network bsc   # 自动读最新主网记录");
  console.log("  node scripts/post-deploy-check-mainnet.mjs --addr", path.relative(path.join(__dirname, ".."), outFile));

  console.log("\n⚠️ 生产环境：请将各合约 owner 转移至 Gnosis Safe 多签（营销/技术 Safe 见《上线钱包准备清单_方案A》）");
  console.log("⚠️ keeper 侧：把上面地址与 indexerStartBlock 填进 zyt-keeper/.env（每日 08:01 cron 触发 dailySnapshot）");
  console.log("⚠️ 前端侧：把上面地址填进 zyt-dapp/src/config/index.ts 对应链段");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
