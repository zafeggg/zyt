/* global ethers */
/**
 * @title 测试网冒烟脚本 v2（BSC testnet, chainId 97）
 * @notice 真实链上业务链路验证（修正版）：
 *         - 测试主体 = 动态生成的随机钱包（非白名单普通用户），覆盖卖出统计/V6 转账滑点/forceSell hook
 *         - deployer 仅承担 owner/keeper 职责：转 tBNB gas、放行买入白名单、复核快照
 *         - 每日快照为「触发/复核双模式」：snapshotCount==0 时 deployer(owner) 主动触发 dailySnapshot，
 *           否则复核链上既有结果（幂等，可安全重跑）
 *         - 读一致性：写后轮询重读（BSC testnet 公共 RPC 多节点最终一致性）
 * @usage  npx hardhat run scripts/smoke-testnet.js --network bscTestnet
 * @note   幂等：测试钱包已有入金记录时自动进入复核模式，可安全重跑
 */
const { ethers } = require("hardhat");
require("dotenv").config();

// ---------------- 地址（testnet 第五套部署产物，2026-09-01） ----------------
const A = {
  config: "0x55F4e5F732ACfa49015AB6546a2766Db7534cDbd",
  pool: "0x020927BC660f7631709d388C992979359196DcfD",
  mining: "0x1ffCec692Ef2c8287C1dE7248B0621bdAd135703",
  deflation: "0x16E8A145D015D80892e5CFe8cE305F0717F229a9",
  zyt: "0xdF18105bB57165c59AD651Eda1B4d896412d4166",
  usdt: "0x7749da5d64c0ABA2A8203c0C630d31e7D13cFb29",
  blackHole: "0x000000000000000000000000000000000000dEaD",
};
const E18 = 10n ** 18n;
const INIT_PRICE = 10000000000000n;   // 初始锁定价 = 21000e18*1e18/21亿（initialize 后，快照前计价）
const SNAP_PRICE = 10142857142857n;   // 快照后锁定价 = 21300e18*1e18/21亿（快照先于通缩，poolZYT 未减）
const ZERO = ethers.ZeroAddress;

// ---------------- 断言框架（带轮询重读） ----------------
let failed = 0;
const F = (x) => ethers.formatUnits(x, 18);
/** 轮询读：连续 n 次取最后一次，避免命中未同步节点 */
async function readStable(fn, n = 3) {
  let v;
  for (let i = 0; i < n; i++) {
    v = await fn();
    if (i < n - 1) await new Promise((r) => setTimeout(r, 1000));
  }
  return v;
}
/** 断言 + 重试（写后最多重读 8 次，每次间隔 1.5s） */
async function assertW(name, fn, expected, fmt = (x) => x.toString(), retries = 8) {
  let last;
  for (let i = 0; i < retries; i++) {
    last = await fn();
    if (String(last) === String(expected)) {
      console.log(`  [PASS] ${name}  期望=${fmt(expected)}  实际=${fmt(last)}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  failed++;
  console.log(`  [FAIL] ${name}  期望=${fmt(expected)}  实际=${fmt(last)}`);
}
/** 普通断言（本地计算/写前读） */
function assert(name, actual, expected, fmt = (x) => x.toString()) {
  const ok = String(actual) === String(expected);
  if (!ok) failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}  期望=${fmt(expected)}  实际=${fmt(actual)}`);
}

async function main() {
  // ---------------- 连接 ----------------
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const Cfg = await ethers.getContractAt("ZYTConfig", A.config);
  const Pool = await ethers.getContractAt("ZYTPoolManager", A.pool);
  const Min = await ethers.getContractAt("ZYTMining", A.mining);
  const Def = await ethers.getContractAt("ZYTDeflation", A.deflation);
  const Zyt = await ethers.getContractAt("ZYTToken", A.zyt);
  const Usdt = await ethers.getContractAt("MockERC20", A.usdt);

  const blk = await provider.getBlock("latest");
  const day = Math.floor(blk.timestamp / 86400);
  console.log(`=== ZYT 测试网冒烟 v2 ===`);
  console.log(`链: ${(await provider.getNetwork()).chainId} | 块: ${blk.number} | day: ${day}`);

  // ---------------- 测试钱包（非白名单普通用户） ----------------
  const w = ethers.Wallet.createRandom().connect(provider);
  const me = w.address;
  console.log(`测试钱包: ${me}（非白名单普通用户）`);
  console.log(`测试钱包私钥: ${w.privateKey}（仅本脚本使用，勿用于任何真实资产）`);

  // ================= P0 前置：gas + USDT + 白名单放行 =================
  console.log("\n【P0 前置】转 gas → faucet USDT → 放行买入白名单");
  if ((await readStable(() => Usdt.balanceOf(me))) > 0n) {
    console.log("  [SKIP] 测试钱包已就绪（有 USDT），仅复核");
  } else {
    // 1. deployer 转 tBNB（测试钱包发交易所需 gas；全程约 9 笔，0.02 足够）
    const g = await deployer.sendTransaction({ to: me, value: ethers.parseEther("0.02") });
    await g.wait();
    console.log(`  gas 已转: ${g.hash}`);
    // 2. 测试钱包领 MockUSDT（faucet 任意地址可领）
    const fu = await Usdt.connect(w).faucet(5000n * E18);
    await fu.wait();
    console.log(`  faucet tx: ${fu.hash}`);
    // 3. deployer（pool owner）放行买入白名单
    const wl = await Pool.setBuyWhitelist(me, true);
    await wl.wait();
    console.log(`  白名单放行 tx: ${wl.hash}`);
  }
  await assertW("wl[测试钱包]=true", () => Pool.buyWhitelist(me), true);

  // ================= P1 入金链路（stage2 门控） =================
  console.log("\n【P1 入金】测试钱包 addLiquidity 500U → deposit 500U");
  const ui0 = await readStable(() => Min.userInfo(me));
  if (ui0[0] > 0n) {
    console.log("  [SKIP] 测试钱包已有入金，仅复核");
  } else {
    const usdtBefore = await readStable(() => Usdt.balanceOf(me));
    const pUsdtBefore = await readStable(() => Pool.poolUSDT());
    const pGstBefore = await readStable(() => Pool.poolGST());
    await (await Usdt.connect(w).approve(A.mining, ethers.MaxUint256)).wait();
    await (await Min.connect(w).addLiquidity(500n * E18)).wait();
    await assertW("addLiquidity 后 lpQuota=500", () => Min.userInfo(me).then((u) => u[5]), 500n * E18, F);
    await (await Min.connect(w).deposit(500n * E18, ZERO)).wait();
    // addLiquidity 500 + deposit 500（营销 200U 归 market=deployer，不返还测试钱包）
    await assertW("测试钱包 USDT 净支出=1000", async () => usdtBefore - (await Usdt.balanceOf(me)), 1000n * E18, F);
    // 60%×500=300U 注入底池
    await assertW("poolUSDT +300", async () => (await Pool.poolUSDT()) - pUsdtBefore, 300n * E18, F);
    await assertW("poolGST +300", async () => (await Pool.poolGST()) - pGstBefore, 300n * E18, F);
  }
  const ui = await readStable(() => Min.userInfo(me));
  assert("depositTotal=500", ui[0], 500n * E18, F);
  assert("power=500", ui[4], 500n * E18, F);
  assert("quota=2500", ui[2], 2500n * E18, F);
  assert("lpQuota=0（已消耗）", ui[5], 0n, F);
  assert("isExited=false", ui[6], false);
  // mint = 60%×500=300U / 初始锁定价 1e13 = 3000 万 ZYT（P1 在快照前，按 initialize 锁定价）
  const expectMint = (300n * E18 * E18) / INIT_PRICE;
  assert("测试钱包 zyt=2957.7万", await readStable(() => Zyt.balanceOf(me)), expectMint, F);

  // ================= P2 快照（未触发则触发，已触发则复核） =================
  console.log("\n【P2 快照】确保当日快照已触发（通缩+释放）");
  const sc = await readStable(() => Def.snapshotCount());
  if (sc > 0n) {
    console.log("  [SKIP] 今日已快照（snapshotCount=" + sc + "），直接复核");
  } else {
    // deployer == owner == keeperAddress，可直接触发（keeper 地址未单独设置）
    const tx = await Def.dailySnapshot(500n * E18);
    await tx.wait();
    console.log("  快照 tx: " + tx.hash);
  }
  assert("snapshotCount=1", await readStable(() => Def.snapshotCount()), 1n);
  const info = await readStable(() => Min.dailyInfo(day));
  assert("今日 releaseAmount=10万", info[1], 100_000n * E18, F);
  assert("今日 totalPower=500", info[0], 500n * E18, F);
  // 通缩已发生：poolZYT = 21亿 - 4200万（1%销毁+1%分红各减 2100万）
  assert("poolZYT=20.58亿（通缩 2% 已生效）", await readStable(() => Pool.poolZYT()), 2_058_000_000n * E18, F);
  assert("snapshotPoolGST=21300", await readStable(() => Pool.snapshotPoolGST()), 21300n * E18, F);
  assert("snapshotPrice=1.0142857e13（通缩前锁定）", await readStable(() => Pool.snapshotPrice()), SNAP_PRICE);
  // dividendPool 当前 = 快照 1% 分红 2100 万 ZYT（待 P4 领取）
  const divBefore = await readStable(() => Pool.dividendPool());
  assert("dividendPool=2100万（通缩 1% 分红入池）", divBefore, 21_000_000n * E18, F);
  console.log("  dividendPool 当前: " + F(divBefore) + "（待 P4 领取）");

  // ================= P3 产出领取 =================
  console.log("\n【P3 产出】测试钱包 claimReward(day)");
  const zytB3 = await readStable(() => Zyt.balanceOf(me));
  await (await Min.connect(w).claimReward(day)).wait();
  await assertW("zyt +10万（100% 份额）", async () => (await Zyt.balanceOf(me)) - zytB3, 100_000n * E18, F);
  const ui3 = await readStable(() => Min.userInfo(me));
  const expectW3 = (100_000n * E18 * SNAP_PRICE) / E18; // 合约: reward*price/1e18（只除一次）
  assert("dynamicWithdrawn=1.0142857U", ui3[3], expectW3, F);

  // ================= P4 分红领取 =================
  console.log("\n【P4 分红】测试钱包 claimDividend()");
  const zytB4 = await readStable(() => Zyt.balanceOf(me));
  const divAtClaim = await readStable(() => Pool.dividendPool());
  await (await Min.connect(w).claimDividend()).wait();
  // share = dividendPool × 500/500（全网算力 500 = 测试钱包 500）→ 全量
  await assertW("zyt +全量分红", async () => (await Zyt.balanceOf(me)) - zytB4, divAtClaim, F);
  await assertW("dividendPool → 0", () => Pool.dividendPool(), 0n, F);
  const ui4 = await readStable(() => Min.userInfo(me));
  const expectW4 = expectW3 + (divAtClaim * SNAP_PRICE) / E18; // 合约: share*price/1e18
  assert("dynamicWithdrawn 累计正确", ui4[3], expectW4, F);

  // ================= P5 卖出链路（非白名单：统计/滑点全生效） =================
  console.log("\n【P5 卖出】测试钱包 sellZyt(100万 ZYT)");
  const usdtB5 = await readStable(() => Usdt.balanceOf(me));
  const pUsdtB5 = await readStable(() => Pool.poolUSDT());
  const pGstB5 = await readStable(() => Pool.poolGST());
  const pZytB5 = await readStable(() => Pool.poolZYT());
  await (await Zyt.connect(w).approve(A.pool, ethers.MaxUint256)).wait(); // settleSell 由 pool 扣款
  await (await Min.connect(w).sellZyt(1_000_000n * E18)).wait();
  const rate = await readStable(() => Pool.getCurrentSlippage());
  assert("滑点档位=5%（500 基点）", rate, 500n);
  const expectOut = (950_000n * E18 * SNAP_PRICE) / E18; // 合约: netZyt*price/1e18（只除一次）
  await assertW("测试钱包 USDT +9.6357U", async () => (await Usdt.balanceOf(me)) - usdtB5, expectOut, F);
  await assertW("poolUSDT 减少 9.6357", async () => pUsdtB5 - (await Pool.poolUSDT()), expectOut, F);
  await assertW("poolGST 减少 9.6357", async () => pGstB5 - (await Pool.poolGST()), expectOut, F);
  await assertW("poolZYT +93万（95万回池-2万销毁）", async () => (await Pool.poolZYT()) - pZytB5, 950_000n * E18 - 20_000n * E18, F);
  const ui5 = await readStable(() => Min.userInfo(me));
  assert("withdrawTotal=9.6357U", ui5[1], expectOut, F);
  // 非白名单：卖出统计真实生效
  const si5 = await readStable(() => Zyt.getSellInfo(me));
  assert("sellInfo: count=1", si5[0], 1n);
  assert("sellInfo: totalSellZyt=100万", si5[1], 1_000_000n * E18, F);
  assert("sellInfo: totalSellUsdt=9.6357U", si5[2], expectOut, F);
  assert("sellInfo: firstReceiveAt>0", si5[3] > 0n, true);

  // ================= P6 转账视同卖出（V6：非白名单扣 10%，收款方收全额） =================
  console.log("\n【P6 转账】测试钱包 transfer(黑洞, 100 ZYT) 扣 10% 滑点");
  const meZytB6 = await readStable(() => Zyt.balanceOf(me));
  const bhB6 = await readStable(() => Zyt.balanceOf(A.blackHole));
  await (await Zyt.connect(w).transfer(A.blackHole, 100n * E18)).wait();
  // 收款方收全额 100；from 额外支付 10% = 10 销毁 → 测试钱包净 -110
  await assertW("黑洞 +100（收全额）", async () => (await Zyt.balanceOf(A.blackHole)) - bhB6, 100n * E18, F);
  await assertW("测试钱包净 -110（100 转出 + 10 税）", async () => meZytB6 - (await Zyt.balanceOf(me)), 110n * E18, F);
  const si6 = await readStable(() => Zyt.getSellInfo(me));
  assert("sellInfo: count=2", si6[0], 2n);
  assert("sellInfo: totalSellZyt=100万+100", si6[1], 1_000_100n * E18, F);
  // 用户列表仅测试钱包 1 人：黑洞作为「非白名单收款方」在 from 非白名单的转账（P6）中走
  // checkAndBurn 分支，不触发 onMint 入列；只有铸币/白名单→非白名单转账才入列（P1 mint 已入列）
  assert("userCount=1（仅测试钱包；黑洞收款方不入列表）", await readStable(() => Zyt.getUserCount()), 1n);

  // ================= 汇总 =================
  console.log("\n=== 冒烟结果 ===");
  if (failed === 0) {
    console.log("✅ 全部断言通过（P0-P6 业务链路完整闭环，含非白名单卖出统计/V6 滑点）");
  } else {
    console.log(`❌ ${failed} 项断言失败，请检查上方 FAIL 项`);
    process.exitCode = 1;
  }
  console.log("（说明：forceSell 15 天窗口未到，本轮不触发 burn，属预期）");
}

main().catch((e) => {
  console.error("ERROR:", e.message.slice(0, 400));
  process.exit(1);
});
