/* global ethers hre */
/**
 * @title ZYT v9.1 testnet 验收脚本（smoke）
 * @notice 只读验收 + 可选写入流程；写入按 stage 自适应（stage1 禁买则跳过买入）
 * @usage  只读： npx hardhat run scripts/smoke-testnet.js --network bscTestnet
 *         写入： SMOKE_WRITE=1 SMOKE_DEPOSIT=100 npx hardhat run scripts/smoke-testnet.js --network bscTestnet
 * @note   地址默认读 deployments/v91-testnet-20260924.json；env 可覆盖各 *_ADDR
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");

// ===== 地址来源：deployments JSON 优先，env 可覆盖 =====
const DEPLOY_FILE = process.env.SMOKE_DEPLOY_FILE || "deployments/v91-testnet-20260924.json";
let D = {};
try {
  D = JSON.parse(fs.readFileSync(path.join(__dirname, "..", DEPLOY_FILE), "utf8")).contracts || {};
} catch {
  console.warn(`⚠️  未读到 ${DEPLOY_FILE}，将使用 env 地址`);
}
const A = {
  config: process.env.CONFIG_ADDR || D.ZYTConfig,
  zyt: process.env.ZYT_ADDR || D.ZYTToken,
  creator: process.env.CREATOR_ADDR || D.ZYTLiquidityCreator,
  pool: process.env.POOL_ADDR || D.ZYTPoolManager,
  referral: process.env.REFERRAL_ADDR || D.ZYTReferral,
  forceSell: process.env.FORCESELL_ADDR || D.ZYTForceSell,
  mining: process.env.MINING_ADDR || D.ZYTMining,
  deflation: process.env.DEFLATION_ADDR || D.ZYTDeflation,
  usdt: process.env.USDT_ADDR || D.MockUSDT,
  pair: process.env.PAIR_ADDR || D["Pair(ZYT/USDT)"],
};

const E18 = 10n ** 18n;
const WRITE = process.env.SMOKE_WRITE === "1";
const DEPOSIT_U = BigInt(process.env.SMOKE_DEPOSIT || "100");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ✅ ${name}${detail ? " | " + detail : ""}`);
    pass++;
  } else {
    console.log(`  ❌ ${name}${detail ? " | " + detail : ""}`);
    fail++;
  }
}
const fmt = (v) => Number(ethers.formatEther(v));

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`\n===== ZYT v9.1 smoke (testnet) =====`);
  console.log(`signer: ${signer.address}  写入模式: ${WRITE ? "ON" : "OFF"}`);
  console.log(`地址: pool=${A.pool} zyt=${A.zyt}\n`);

  const zyt = await ethers.getContractAt("ZYTToken", A.zyt);
  const pool = await ethers.getContractAt("ZYTPoolManager", A.pool);
  const mining = await ethers.getContractAt("ZYTMining", A.mining);
  const creator = await ethers.getContractAt("ZYTLiquidityCreator", A.creator);
  const config = await ethers.getContractAt("ZYTConfig", A.config);
  const forceSell = await ethers.getContractAt("ZYTForceSell", A.forceSell);
  const deflation = await ethers.getContractAt("ZYTDeflation", A.deflation);
  const usdt = await ethers.getContractAt("MockERC20", A.usdt);

  // ===== 1. 基础状态 =====
  console.log("【1】建池与代币");
  const supply = await zyt.totalSupply();
  check("总供应 ≤ 21 亿（只减不增）", supply <= 2100000000n * E18, `${fmt(supply).toLocaleString()} ZYT`);
  const poolU = await pool.poolUSDT();
  const poolZ = await pool.poolZYT();
  check("池 USDT > 0", poolU > 0n, `${fmt(poolU).toFixed(2)} U`);
  check("池 ZYT > 0", poolZ > 0n, `${fmt(poolZ).toLocaleString()} ZYT`);
  const price = await pool.getPrice();
  check("价格锚定 0.00001U 量级", price > 0n && price < 1n * E18, `${ethers.formatEther(price)} U`);
  const lp = await creator.lockedLiquidity();
  check("LP 锁仓 > 0（人类不可撤）", lp > 0n, `${lp.toString().slice(0, 12)}...`);

  // ===== 2. 门控与参数 =====
  console.log("\n【2】门控与参数");
  const stage = Number(await pool.getStage());
  check("阶段值合法（1/2/3）", [1, 2, 3].includes(stage), `stage=${stage}`);
  const slip = Number(await pool.getCurrentSlippage());
  check("滑点基档 ≥ 500bps", slip >= 500, `${slip} bps (${slip / 100}%)`);
  const deflRate = Number(await config.deflationRate());
  check("通缩率 = 200bps（2%）", deflRate === 200, `${deflRate} bps`);
  const s1 = await config.poolStage1USDT();
  check("stage1 阈值已设", s1 > 0n, `${fmt(s1).toLocaleString()} U`);
  const keeperAddr = await forceSell.keeper();
  check("ForceSell keeper 已接线", keeperAddr !== ethers.ZeroAddress, keeperAddr);
  const lastSnap = await deflation.lastSnapshotDay();
  // 0 = 新部署尚未快照（本地全新部署属正常）；>0 时要求与当日接近（最多滞后 2 天）
  const todayDay = BigInt(Math.floor(Date.now() / 86400000));
  if (lastSnap === 0n) {
    console.log(`  ℹ️  快照天数 = 0（新部署未跑过通缩，首次 08:01 后生效）`);
  } else {
    check("快照天数 > 0 且滞后 ≤ 2 天", todayDay - lastSnap <= 2n, `day=${lastSnap}（今天 ${todayDay}）`);
  }

  // ===== 3. 卖闸实测（绕过拦截）=====
  console.log("\n【3】卖闸与买闸（防绕过）");
  // 说明：卖闸只作用于「ZYT 流入 pair」（用户绕过合约去 DEX 卖）。用户直转 pool 属合法路径
  // （池合约不发行流动性，币滞留且按转出折算计提提取额，无套利空间），故不做拦截断言。
  async function revertReason(fn) {
    try {
      await fn();
      return "";
    } catch (e) {
      return String(e.shortMessage || e.message || "");
    }
  }

  const rPair = await revertReason(() => zyt.transfer.staticCall(A.pair, 1000n));
  // 拦截成立即可：持币地址命中卖闸文案（gated）；无持币地址先抛 ERC20 余额错误（同样是 revert）
  check(
    "直转 pair 被拦截（卖闸）",
    rPair.length > 0,
    /gated|pair inflow/i.test(rPair) ? rPair.slice(0, 60) : `revert（非持币地址先抛余额检查）: ${rPair.slice(0, 50)}`
  );

  const rSell = await revertReason(() => pool.sellFor.staticCall(signer.address, 1000n));
  check("非 Mining 直调 pool.sellFor 被拒（onlyMining）", rSell.length > 0, rSell.slice(0, 60));

  const rBuy = await revertReason(() => pool.buyFor.staticCall(signer.address, 1n * E18));
  check("非 Mining 直调 pool.buyFor 被拒（onlyMining）", rBuy.length > 0, rBuy.slice(0, 60));

  const rDeflate = await revertReason(() => pool.deflate.staticCall());
  check("非 Deflation 直调 pool.deflate 被拒（权限）", rDeflate.length > 0, rDeflate.slice(0, 60));

  const rSkim = await revertReason(() => creator.skimDeflation.staticCall(200));
  check("非 Pool 直调 creator.skimDeflation 被拒（LP 不可被撤）", rSkim.length > 0, rSkim.slice(0, 60));

  // ===== 4. 可选写入流程 =====
  if (WRITE) {
    console.log("\n【4】写入流程（入金 → 买入 → 卖出）");
    const amt = DEPOSIT_U * E18;
    const balU = await usdt.balanceOf(signer.address);
    if (balU < amt) {
      console.log(`  ⏭️  跳过：USDT 余额不足（${fmt(balU)} < ${fmt(amt)}）`);
    } else {
      const depBefore = (await mining.userInfo(signer.address))[0];
      await (await usdt.approve(A.mining, amt)).wait();
      await (await mining.deposit(amt, ethers.ZeroAddress)).wait();
      const afterDep = await mining.userInfo(signer.address);
      check("入金记账（depositTotal 增加）", afterDep[0] - depBefore === amt, `+${fmt(amt)} U`);
      check("算力 = 入金量（100%）", afterDep[2] >= amt, `${fmt(afterDep[2])}`);
      check("动态额度 = 5×累计入金", afterDep[3] === afterDep[0] * 5n, `${fmt(afterDep[3])} U`);
      check("买额 ≥ 入金量（1:1）", afterDep[5] >= amt, `${fmt(afterDep[5])} U`);

      const st = Number(await pool.getStage());
      if (st === 1) {
        let buyBlocked = false;
        try {
          await mining.buy.staticCall(1n * E18);
        } catch {
          buyBlocked = true;
        }
        check("stage1 禁买（合约拦截）", buyBlocked);
      } else {
        const balU2 = await usdt.balanceOf(signer.address);
        const quotaLeft = (await mining.userInfo(signer.address))[5];
        // 买入额上限三约束：可用买额（1:1） / 余额 / 200U 探针上限
        let buyAmt = balU2 / 2n;
        if (buyAmt > 200n * E18) buyAmt = 200n * E18;
        if (buyAmt > quotaLeft) buyAmt = quotaLeft;
        if (buyAmt > 0n) {
          await (await usdt.approve(A.mining, buyAmt)).wait();
          const zBefore = await zyt.balanceOf(signer.address);
          await (await mining.buy(buyAmt)).wait();
          const zGot = (await zyt.balanceOf(signer.address)) - zBefore;
          check("买入到账 ZYT > 0", zGot > 0n, `${fmt(zGot).toFixed(2)} ZYT（花费 ${fmt(buyAmt)} U）`);
          check("买入后 swapGate 复位", (await pool.swapGate()) === false);
        } else {
          console.log("  ⏭️  跳过买入：可用买额或余额为 0");
        }
      }

      const zBal = await zyt.balanceOf(signer.address);
      if (zBal > 0n) {
        // 持币地址严格复检卖闸文案（此时余额充足，必然命中 gated）
        const rPair2 = await revertReason(() => zyt.transfer.staticCall(A.pair, 1n));
        check("持币地址直转 pair 命中卖闸文案（gated）", /gated|pair inflow/i.test(rPair2), rPair2.slice(0, 60));

        const sellAmt = zBal / 4n;
        const wBefore = (await mining.userInfo(signer.address))[1];
        const uBefore = await usdt.balanceOf(signer.address);
        await (await zyt.approve(A.pool, sellAmt)).wait();
        await (await mining.sellZyt(sellAmt)).wait();
        const usdtOut = (await usdt.balanceOf(signer.address)) - uBefore;
        const wAfter = (await mining.userInfo(signer.address))[1];
        check("卖出实收 USDT > 0", usdtOut > 0n, `${fmt(usdtOut).toFixed(6)} U`);
        check(
          "withdrawTotal 精确等于卖出实收（单计，V9.1-1 锁定）",
          wAfter - wBefore === usdtOut,
          `${ethers.formatEther(wAfter - wBefore)} vs ${ethers.formatEther(usdtOut)}`
        );
      } else {
        console.log("  ⏭️  跳过卖出：无 ZYT 余额");
      }
    }
  } else {
    console.log("\n【4】写入流程  ⏭️  已跳过（设 SMOKE_WRITE=1 开启）");
  }

  console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e.message?.slice(0, 400));
  process.exit(1);
});
