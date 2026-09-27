#!/usr/bin/env node
/**
 * v9.1 主网部署「中断恢复」脚本（2026-09-26）
 *
 * 背景
 *   deploy.js 于 2026-09-26 10:10 起在 BSC 主网执行，10 个合约全部部署成功，
 *   但在「12 项 ZYTConfig.setAddress」的第 11 项（referral）之前，
 *   因 RPC 请求头超时（undici HeadersTimeoutError，默认 5 分钟无响应）中断。
 *   中断点：scripts/deploy.js:196（setAddress("referral")）
 *
 * 已完成（链上实测，不可重复执行也无害）
 *   ZYTConfig.setAddress × 10：marketAddress / technicalAddress / blackHole / usdt /
 *     factory / zyt / pool / mining / deflation / forceSell
 *
 * 本脚本续做剩余全部步骤（幂等，可反复执行）
 *   A. ZYTConfig.setAddress × 3：referral / creator / keeperAddress
 *   B. ZYTToken 接线 × 6：setMinter / setLedger / setPool / setForceSell / setCreator / setConfig
 *   C. ZYTToken 白名单 × 6：creator / pool / mining / deflation / market / technical
 *   D. 依赖接线 × 7：pool.setLocker / pool.setMining / pool.setDeflation /
 *      referral.setMining / creator.setPoolManager / mining.setDeflation / forceSell.setKeeper
 *   E. approve 2.1 万 USDT → Creator，然后 createInitialPool（铸 21 亿 ZYT 建池，只能成功一次）
 *   F. pair 接线 × 4：config.setAddress("pair") / zyt.setPair / pool.setPair / zyt.setWhiteList(pair)
 *   G. 写部署记录 deployments/mainnet-<日期>.json
 *
 * 与 deploy.js 的差异（为什么另写脚本而不是重跑 deploy.js）
 *   1. 重跑 deploy.js 会重新部署 10 个合约，浪费已花的 gas 与已有的 2.1 万 USDT 授权
 *   2. 本脚本用纯 ethers（不经 hardhat），可显式设置单请求超时 + 分级重试，
 *      规避本次中断的根因
 *   3. 每项接线前先读链上现值，已是目标值则跳过，节省 gas
 *
 * 用法
 *   node scripts/resume-deploy-mainnet.js --dry-run     # 只读，检查当前进度（先跑这个）
 *   node scripts/resume-deploy-mainnet.js               # 正式执行
 *   node scripts/resume-deploy-mainnet.js --rpc <url>   # 指定 RPC（默认 publicnode）
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract, formatEther, getAddress } = require("ethers");

// ---------------- 参数解析 ----------------
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const rpcArg = argv.includes("--rpc") ? argv[argv.indexOf("--rpc") + 1] : null;
// RPC 选择（2026-09-26 实测，见 scripts/_probe-deploy-rpc.mjs）
//   ★ bsc-mainnet.public.blastapi.io  全项通过、响应 300-750ms（默认）
//   ★ bsc.blockrazor.xyz              全项通过、最快，但出现过单请求挂起（HeadersTimeout）
//   ★ 1rpc.io/bnb                     全项通过、偏慢（0.6-2.4s）
//   ✘ bsc-rpc.publicnode.com          等待交易确认时 403（Archive requests require a personal token）
//   ✘ bsc.drpc.org / rpc.ankr.com/bsc 公共端点限速 / 需认证
// 节点异常时用 --rpc 切换，例如：
//   node scripts/resume-deploy-mainnet.js --rpc https://bsc.blockrazor.xyz
const RPC_URL = rpcArg || process.env.BSC_RESUME_RPC || "https://bsc-mainnet.public.blastapi.io";

// ---------------- 已部署地址（来自 deploy.js 本次输出，已链上核实） ----------------
const ADDR = {
  ZYTConfig: "0x4FEFe79A90Bf7C9BD2699030Ee1ad0360f4B1B22",
  ZYTToken: "0xa64E6ab9A8a61f55eE9B1521312783AE033fd546",
  ZYTLiquidityCreator: "0x41799040658764d91C94AF16b8B461f2fc1A040F",
  ZYTPoolManager: "0x57d8Ec0D9Ef0822dFc5D08Db686D182351580028",
  ZYTReferral: "0x43018AF273296064991c018955c636fB45eB0dad",
  ZYTForceSell: "0xaE0EeD16e6f7ca4736294a6c2E4a5b87d02672C8",
  ZYTCompute: "0xf6Cc1617C480D1a412549c8a11618FF30c31f048",
  ZYTMining: "0x0119cf2eac935447f2Dd60C457190fAEa116fd22",
  ZYTDeflation: "0xF44fE232d26F4E845Be75960bc0a65aB12898D73",
  USDT: "0x55d398326f99059fF775485246999027B3197955",
  PancakeFactory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
};
const BLACK_HOLE = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";
const ZYT_MAX = 2_100_000_000n * 10n ** 18n; // 21 亿（全量一次铸出）
const SEED_USDT = 21_000n * 10n ** 18n; // 初始底池 2.1 万 USDT

// ---------------- 角色地址（来自 .env） ----------------
const MARKET = process.env.MARKET_ADDRESS;
const TECHNICAL = process.env.TECHNICAL_ADDRESS;
const KEEPER = process.env.KEEPER_ADDRESS;

// ---------------- ABI（只取本脚本需要的接口） ----------------
const ABI = {
  config: [
    "function setAddress(string calldata key, address value) external",
    "function marketAddress() view returns (address)",
    "function technicalAddress() view returns (address)",
    "function blackHole() view returns (address)",
    "function usdt() view returns (address)",
    "function factory() view returns (address)",
    "function zyt() view returns (address)",
    "function pool() view returns (address)",
    "function mining() view returns (address)",
    "function deflation() view returns (address)",
    "function forceSell() view returns (address)",
    "function referral() view returns (address)",
    "function creator() view returns (address)",
    "function keeperAddress() view returns (address)",
    "function pair() view returns (address)",
    "function owner() view returns (address)",
  ],
  zyt: [
    "function setMinter(address) external",
    "function setLedger(address) external",
    "function setPool(address) external",
    "function setForceSell(address) external",
    "function setCreator(address) external",
    "function setConfig(address) external",
    "function setPair(address) external",
    "function setWhiteList(address addr, bool enabled) external",
    "function minter() view returns (address)",
    "function ledger() view returns (address)",
    "function pool() view returns (address)",
    "function forceSell() view returns (address)",
    "function creator() view returns (address)",
    "function configAddr() view returns (address)",
    "function pairAddress() view returns (address)",
    "function isWhiteList(address) view returns (bool)",
    "function totalSupply() view returns (uint256)",
    "function owner() view returns (address)",
  ],
  creator: [
    "function createInitialPool(uint256 zytAmount, uint256 usdtAmount) external returns (address)",
    "function setPoolManager(address) external",
    "function poolManager() view returns (address)",
    "function pair() view returns (address)",
    "function initialized() view returns (bool)",
    "function lockedLiquidity() view returns (uint256)",
    "function totalZytSeeded() view returns (uint256)",
    "function totalUsdtSeeded() view returns (uint256)",
    "function owner() view returns (address)",
  ],
  pool: [
    "function setLocker(address) external",
    "function setMining(address) external",
    "function setDeflation(address) external",
    "function setPair(address) external",
    "function locker() view returns (address)",
    "function mining() view returns (address)",
    "function deflation() view returns (address)",
    "function pair() view returns (address)",
    "function owner() view returns (address)",
  ],
  referral: ["function setMining(address) external", "function mining() view returns (address)"],
  mining: ["function setDeflation(address) external", "function deflation() view returns (address)"],
  forceSell: ["function setKeeper(address) external", "function keeper() view returns (address)"],
  erc20: [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 统计 ----------------
const stat = { tx: 0, skipped: 0, failed: 0 };

/**
 * 发一笔交易并等待确认（分级重试）
 * 阶段一（广播）失败 → 可安全重试（交易未上链）
 * 阶段二（等待）失败 → 用已知 txHash 单独轮询，绝不重发，避免重复交易
 */
async function send(provider, label, fn, { tries = 3 } = {}) {
  if (DRY_RUN) {
    console.log(`  [dry-run] 将执行：${label}`);
    return null;
  }
  let tx = null;
  for (let i = 1; i <= tries && !tx; i++) {
    try {
      tx = await fn();
    } catch (e) {
      const msg = String(e.message).slice(0, 150).replace(/\s+/g, " ");
      console.log(`  ✘ ${label} 广播失败（第 ${i}/${tries} 次）：${msg}`);
      if (i === tries) {
        stat.failed++;
        throw e;
      }
      await sleep(2500 * i);
    }
  }
  console.log(`  → ${label} | tx ${tx.hash}`);
  for (let i = 1; i <= 6; i++) {
    try {
      const rc = await provider.waitForTransaction(tx.hash, 1, 90000);
      if (rc) {
        stat.tx++;
        console.log(`    ✔ 确认于块 ${rc.blockNumber}，gas ${rc.gasUsed}`);
        return rc;
      }
    } catch (e) {
      console.log(`    … 等待确认（第 ${i}/6 次）：${String(e.message).slice(0, 80)}`);
    }
    await sleep(3000);
  }
  stat.failed++;
  throw new Error(`${label} 已广播但未在预期时间内确认，txHash=${tx.hash}（请用该 hash 手工核查）`);
}

/** 读现值，已是目标则跳过 */
async function wire(provider, label, getter, target, setter) {
  let cur = null;
  if (getter) {
    try {
      cur = (await getter()).toLowerCase();
    } catch (e) {
      cur = null; // 无 getter 或读取失败 → 不跳过
    }
  }
  const expected = String(target).toLowerCase();
  if (cur === expected) {
    console.log(`  ⊘ ${label} 已是目标值，跳过`);
    stat.skipped++;
    return;
  }
  await send(provider, `${label}${cur ? `（${cur.slice(0, 10)}… → ${expected.slice(0, 10)}…）` : ""}`, setter);
}

/** 读布尔现值，已是 true 则跳过 */
async function wireBool(provider, label, getter, setter) {
  try {
    if (await getter()) {
      console.log(`  ⊘ ${label} 已为 true，跳过`);
      stat.skipped++;
      return;
    }
  } catch (e) {
    /* 读失败则继续执行 */
  }
  await send(provider, label, setter);
}

// ==================== 主流程 ====================
(async () => {
  console.log("═".repeat(74));
  console.log(`v9.1 主网部署中断恢复${DRY_RUN ? "（只读模式）" : ""}`);
  console.log("RPC:", RPC_URL);
  console.log("═".repeat(74));

  // ---------- 0. 连接与前置校验 ----------
  const pk = (process.env.PRIVATE_KEY || "").trim();
  if (!pk) throw new Error(".env 缺少 PRIVATE_KEY");
  const provider = new JsonRpcProvider(RPC_URL, 56, {
    staticNetwork: true,
    timeout: 20000, // 单请求 20 秒超时（本次中断的根因是默认 5 分钟挂起）
    batchMaxCount: 1, // 禁批处理，避免单点超时拖垮整批
  });
  // 注意：必须把 provider 传进 Wallet，否则以该 wallet 为 signer 构造的 Contract
  // 会报 "missing provider"，读接口也会全部失效
  const wallet = new Wallet(pk, provider);
  const net = await provider.getNetwork();
  if (net.chainId !== 56n) throw new Error(`chainId 异常：${net.chainId}，期望 56`);

  const bal = await provider.getBalance(wallet.address);
  console.log("\n【0】前置校验");
  console.log("  deployer :", wallet.address);
  console.log("  chainId  :", net.chainId.toString(), "✓");
  console.log("  BNB      :", formatEther(bal), Number(formatEther(bal)) > 0.01 ? "✓" : "⚠ 偏低");
  if (!MARKET || !TECHNICAL || !KEEPER) throw new Error(".env 缺少 MARKET_ADDRESS / TECHNICAL_ADDRESS / KEEPER_ADDRESS");

  // 合约代码存在性（防止误指向 EOA）
  for (const [name, a] of Object.entries(ADDR)) {
    if (name === "USDT" || name === "PancakeFactory") continue;
    const code = await provider.getCode(a);
    if (code === "0x") throw new Error(`${name} ${a} 无合约代码`);
  }
  console.log("  10 个合约代码存在性 ✓");

  const C = {
    cfg: new Contract(ADDR.ZYTConfig, ABI.config, wallet),
    zyt: new Contract(ADDR.ZYTToken, ABI.zyt, wallet),
    creator: new Contract(ADDR.ZYTLiquidityCreator, ABI.creator, wallet),
    pool: new Contract(ADDR.ZYTPoolManager, ABI.pool, wallet),
    referral: new Contract(ADDR.ZYTReferral, ABI.referral, wallet),
    mining: new Contract(ADDR.ZYTMining, ABI.mining, wallet),
    forceSell: new Contract(ADDR.ZYTForceSell, ABI.forceSell, wallet),
    usdt: new Contract(ADDR.USDT, ABI.erc20, wallet),
  };

  // owner 校验：deployer 必须是各合约 owner，否则接线会 revert
  const owners = [];
  for (const [name, c] of [["ZYTConfig", C.cfg], ["ZYTToken", C.zyt], ["Creator", C.creator], ["Pool", C.pool]]) {
    try {
      owners.push([name, (await c.owner()).toLowerCase()]);
    } catch (e) {
      owners.push([name, "(无 getter)"]);
    }
  }
  console.log("  owner 归属：");
  for (const [n, o] of owners) {
    const ok = o === wallet.address.toLowerCase();
    console.log(`    ${n.padEnd(10)} ${o} ${ok ? "✓" : "⚠"}`);
    if (!ok && o !== "(无 getter)") throw new Error(`${n} 的 owner 不是当前 deployer，接线会失败`);
  }

  // ---------- A. ZYTConfig.setAddress × 3 ----------
  console.log("\n【A】ZYTConfig 补接线（3 项）");
  await wire(provider, "setAddress(referral)", () => C.cfg.referral(), ADDR.ZYTReferral, () => C.cfg.setAddress("referral", ADDR.ZYTReferral));
  await wire(provider, "setAddress(creator)", () => C.cfg.creator(), ADDR.ZYTLiquidityCreator, () => C.cfg.setAddress("creator", ADDR.ZYTLiquidityCreator));
  await wire(provider, "setAddress(keeperAddress)", () => C.cfg.keeperAddress(), KEEPER, () => C.cfg.setAddress("keeperAddress", KEEPER));

  // ---------- B. ZYTToken 接线 × 6 ----------
  console.log("\n【B】ZYTToken 接线（6 项）：minter=Creator，ledger=Mining");
  await wire(provider, "setMinter(Creator)", () => C.zyt.minter(), ADDR.ZYTLiquidityCreator, () => C.zyt.setMinter(ADDR.ZYTLiquidityCreator));
  await wire(provider, "setLedger(Mining)", () => C.zyt.ledger(), ADDR.ZYTMining, () => C.zyt.setLedger(ADDR.ZYTMining));
  await wire(provider, "setPool(PoolManager)", () => C.zyt.pool(), ADDR.ZYTPoolManager, () => C.zyt.setPool(ADDR.ZYTPoolManager));
  await wire(provider, "setForceSell(ForceSell)", () => C.zyt.forceSell(), ADDR.ZYTForceSell, () => C.zyt.setForceSell(ADDR.ZYTForceSell));
  await wire(provider, "setCreator(Creator)", () => C.zyt.creator(), ADDR.ZYTLiquidityCreator, () => C.zyt.setCreator(ADDR.ZYTLiquidityCreator));
  await wire(provider, "setConfig(ZYTConfig)", () => C.zyt.configAddr(), ADDR.ZYTConfig, () => C.zyt.setConfig(ADDR.ZYTConfig));

  // ---------- C. 白名单 × 6 ----------
  console.log("\n【C】ZYTToken 白名单豁免（6 项）");
  const wl = [
    ["Creator", ADDR.ZYTLiquidityCreator],
    ["PoolManager", ADDR.ZYTPoolManager],
    ["Mining", ADDR.ZYTMining],
    ["Deflation", ADDR.ZYTDeflation],
    ["Market(营销 Safe)", MARKET],
    ["Technical(技术 Safe)", TECHNICAL],
  ];
  for (const [name, addr] of wl) {
    await wireBool(provider, `setWhiteList(${name})`, () => C.zyt.isWhiteList(addr), () => C.zyt.setWhiteList(addr, true));
  }

  // ---------- D. 依赖接线 × 7 ----------
  console.log("\n【D】跨合约依赖接线（7 项）");
  await wire(provider, "pool.setLocker(Creator)", () => C.pool.locker(), ADDR.ZYTLiquidityCreator, () => C.pool.setLocker(ADDR.ZYTLiquidityCreator));
  await wire(provider, "pool.setMining(Mining)", () => C.pool.mining(), ADDR.ZYTMining, () => C.pool.setMining(ADDR.ZYTMining));
  await wire(provider, "pool.setDeflation(Deflation)", () => C.pool.deflation(), ADDR.ZYTDeflation, () => C.pool.setDeflation(ADDR.ZYTDeflation));
  await wire(provider, "referral.setMining(Mining)", () => C.referral.mining(), ADDR.ZYTMining, () => C.referral.setMining(ADDR.ZYTMining));
  await wire(provider, "creator.setPoolManager(Pool)", () => C.creator.poolManager(), ADDR.ZYTPoolManager, () => C.creator.setPoolManager(ADDR.ZYTPoolManager));
  await wire(provider, "mining.setDeflation(Deflation)", () => C.mining.deflation(), ADDR.ZYTDeflation, () => C.mining.setDeflation(ADDR.ZYTDeflation));
  await wire(provider, "forceSell.setKeeper(Keeper)", () => C.forceSell.keeper(), KEEPER, () => C.forceSell.setKeeper(KEEPER));

  // ---------- E. 建池（只能成功一次，先做幂等保护） ----------
  console.log("\n【E】初始建池（2.1 万 USDT + 21 亿 ZYT）");
  const inited = await C.creator.initialized();
  let pairAddr;
  if (inited) {
    pairAddr = await C.creator.pair();
    console.log(`  ⊘ 建池已完成（initialized=true），pair = ${pairAddr}，跳过`);
    stat.skipped++;
  } else {
    // E1. USDT 余额与授权
    const [ub, al] = await Promise.all([C.usdt.balanceOf(wallet.address), C.usdt.allowance(wallet.address, ADDR.ZYTLiquidityCreator)]);
    console.log("  deployer USDT   :", formatEther(ub));
    console.log("  已有授权(→Creator):", formatEther(al));
    if (ub < SEED_USDT) throw new Error(`USDT 不足：${formatEther(ub)} < 21000`);
    if (al < SEED_USDT) {
      await send(provider, "approve USDT → Creator（21000）", () => C.usdt.approve(ADDR.ZYTLiquidityCreator, SEED_USDT));
      // BSC 公共 RPC 多节点最终一致性：approve 确认后 allowance 可能仍读到旧值
      // 只读模式不等待（未真正发交易，等也等不到）
      for (let i = 1; i <= 12 && !DRY_RUN; i++) {
        const now = await C.usdt.allowance(wallet.address, ADDR.ZYTLiquidityCreator);
        if (now >= SEED_USDT) {
          console.log("    授权已生效:", formatEther(now));
          break;
        }
        console.log(`    … 等待授权同步（${i}/12）：${formatEther(now)}`);
        await sleep(4000);
      }
    } else {
      console.log("  ⊘ 授权已足额，跳过 approve");
      stat.skipped++;
    }
    // E2. 建池（内部：mint 21 亿到 Creator → 建 pair → 两侧注入 → LP 铸给 Creator）
    await send(
      provider,
      "createInitialPool（铸 21 亿 ZYT + 注入 21000 USDT，不可重复）",
      () => C.creator.createInitialPool(ZYT_MAX, SEED_USDT),
      { tries: 1 } // 不可重复操作：只广播一次。若广播失败说明交易未上链，可人工确认后再跑
    );
    pairAddr = await C.creator.pair();
    console.log("  初始池 pair:", pairAddr);
    console.log("  ZYT seeded :", formatEther(await C.creator.totalZytSeeded()));
    console.log("  USDT seeded:", formatEther(await C.creator.totalUsdtSeeded()));
    console.log("  LP 锁仓量  :", formatEther(await C.creator.lockedLiquidity()));
  }

  // ---------- F. pair 接线 × 4 ----------
  if (pairAddr && pairAddr !== ZERO) {
    console.log("\n【F】pair 接线（4 项）");
    await wire(provider, "config.setAddress(pair)", () => C.cfg.pair(), pairAddr, () => C.cfg.setAddress("pair", pairAddr));
    await wire(provider, "zyt.setPair(pair)", () => C.zyt.pairAddress(), pairAddr, () => C.zyt.setPair(pairAddr));
    await wire(provider, "pool.setPair(pair)", () => C.pool.pair(), pairAddr, () => C.pool.setPair(pairAddr));
    await wireBool(provider, "zyt.setWhiteList(pair)", () => C.zyt.isWhiteList(pairAddr), () => C.zyt.setWhiteList(pairAddr, true));
  } else {
    console.log("\n【F】pair 地址为空，跳过 pair 接线（需人工排查）");
  }

  // ---------- G. 部署记录落盘 ----------
  const blockNow = await provider.getBlockNumber();
  const record = {
    version: "v9.1",
    network: "bsc",
    chainId: 56,
    deployedAt: new Date().toISOString(),
    deployBlock: blockNow,
    indexerStartBlock: blockNow - 500, // 保守往下留 500 块，确保不漏（部署刚发生）
    note: "由 resume-deploy-mainnet.js 补全（原 deploy.js 在 RPC 超时中断于 setAddress(referral) 之前）",
    usdtMock: false,
    factory: ADDR.PancakeFactory,
    contracts: {
      ZYTConfig: ADDR.ZYTConfig,
      ZYTToken: ADDR.ZYTToken,
      ZYTLiquidityCreator: ADDR.ZYTLiquidityCreator,
      ZYTPoolManager: ADDR.ZYTPoolManager,
      ZYTReferral: ADDR.ZYTReferral,
      ZYTForceSell: ADDR.ZYTForceSell,
      ZYTMining: ADDR.ZYTMining,
      ZYTDeflation: ADDR.ZYTDeflation,
      ZYTCompute: ADDR.ZYTCompute,
      USDT: ADDR.USDT,
      "Pair(ZYT/USDT)": pairAddr || ZERO,
    },
    roles: { deployer: wallet.address, market: MARKET, technical: TECHNICAL, keeper: KEEPER },
    constructorArgs: {
      ZYTCompute: [],
      ZYTConfig: [],
      ZYTToken: [BLACK_HOLE],
      ZYTReferral: [],
      ZYTForceSell: [ADDR.ZYTToken],
      ZYTPoolManager: [ADDR.ZYTConfig, ADDR.ZYTToken, ADDR.USDT],
      ZYTMining: [ADDR.ZYTConfig, ADDR.ZYTPoolManager, ADDR.ZYTReferral, ADDR.ZYTToken, ADDR.USDT],
      ZYTDeflation: [ADDR.ZYTConfig, ADDR.ZYTPoolManager, ADDR.ZYTMining],
      ZYTLiquidityCreator: [ADDR.ZYTToken, ADDR.USDT, ADDR.PancakeFactory, BLACK_HOLE],
    },
    libraries: { "contracts/ZYTCompute.sol:ZYTCompute": ADDR.ZYTCompute },
    seed: { zyt: formatEther(ZYT_MAX), usdt: formatEther(SEED_USDT) },
  };
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outFile = path.join(__dirname, "..", "deployments", `mainnet-${stamp}.json`);
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  }

  // ---------- H. 汇总 ----------
  console.log("\n" + "═".repeat(74));
  console.log(DRY_RUN ? "只读检查完成（未发任何交易）" : "续做完成");
  console.log("═".repeat(74));
  console.log(`  新发交易 ${stat.tx} 笔 | 跳过（已就绪）${stat.skipped} 项 | 失败 ${stat.failed} 项`);
  if (!DRY_RUN) console.log("  部署记录已写入:", path.relative(path.join(__dirname, ".."), outFile));
  console.log("\n----- DEPLOYMENT SUMMARY (v9.1 mainnet) -----");
  for (const [k, v] of Object.entries(record.contracts)) console.log(`  ${k.padEnd(20)}: ${v}`);
  console.log(`  ${"Market".padEnd(20)}: ${MARKET}`);
  console.log(`  ${"Technical".padEnd(20)}: ${TECHNICAL}`);
  console.log(`  ${"Keeper".padEnd(20)}: ${KEEPER}`);
  console.log("\n后续步骤：");
  console.log(`  1. node scripts/mainnet-preflight.mjs --addr deployments/mainnet-${stamp}.json`);
  console.log(`  2. node scripts/post-deploy-check-mainnet.mjs --addr deployments/mainnet-${stamp}.json`);
  console.log("  3. 把上面地址 + indexerStartBlock 填入 zyt-keeper/.env 与 zyt-dapp/src/config/index.ts");
  process.exit(stat.failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error("\n❌ 中断:", e.message);
  console.error("\n已完成部分已在链上生效，本脚本可安全重跑（幂等；建池有 initialized 保护）。");
  process.exit(1);
});
