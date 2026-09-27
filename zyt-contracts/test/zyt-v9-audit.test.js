/**
 * ZYT v9.1 漏洞检测（审计实证）
 * 目的：用可复现的用例证实静态审计结论，不改动生产代码。
 * 覆盖：
 *   AUDIT-1  withdrawLp 提空 LP → dailySnapshot 仍正常运行（修复后语义，通缩返回 0）
 *   AUDIT-2  365 天无交互 → claim 零额推进游标 → deposit 恢复（修复后语义）
 *   AUDIT-3  owner 可提高 totalSupplyCap 并更换 minter → 21 亿上限非代码强制
 *   AUDIT-4  用户直转 ZYT 给 pool：币滞留且转出折算被跳过（withdrawTotal 不增）
 *   AUDIT-5  拖到窗口 4 一次性转出 → 欠账全额烧毁（P1-14 修复后，免费免责堵死）
 *   P1-14    每期足额卖出的用户跨窗口转账不被烧（正常用户零影响）
 *   AUDIT-6  转账硬上限为余额 90.9%（10% 税另扣，转全部必失败）
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const E18 = 10n ** 18n;
const ZYT_MAX = 2_100_000_000n * E18;
const SEED_USDT = 21_000n * E18;
const DAY = 86400;
const U500 = 500n * E18;

async function latestTs() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

describe("ZYT v9.1 漏洞检测", function () {
  let usdt, zyt, config, creator, pool, referral, forceSell, mining, deflation, pair, factory;
  let deployer, keeper, alice, bob, carol, root;

  async function depositOf(signer, amount, ref) {
    await usdt.connect(signer).faucet(amount);
    await usdt.connect(signer).approve(await mining.getAddress(), amount);
    await mining.connect(signer).deposit(amount, ref);
  }

  beforeEach(async function () {
    [deployer, keeper, alice, bob, carol] = await ethers.getSigners();
    root = deployer;

    const Mock = await ethers.getContractFactory("MockERC20");
    usdt = await Mock.deploy("USDT", "USDT", 18);

    const Config = await ethers.getContractFactory("ZYTConfig");
    config = await Config.deploy();

    const ZYT = await ethers.getContractFactory("ZYTToken");
    zyt = await ZYT.deploy(DEAD);

    const Fac = await ethers.getContractFactory("MiniFactory");
    factory = await Fac.deploy();

    const Creator = await ethers.getContractFactory("ZYTLiquidityCreator");
    creator = await Creator.deploy(
      await zyt.getAddress(), await usdt.getAddress(), await factory.getAddress(), DEAD
    );

    const Pool = await ethers.getContractFactory("ZYTPoolManager");
    pool = await Pool.deploy(await config.getAddress(), await zyt.getAddress(), await usdt.getAddress());

    const Ref = await ethers.getContractFactory("ZYTReferral");
    referral = await Ref.deploy();

    const FS = await ethers.getContractFactory("ZYTForceSell");
    forceSell = await FS.deploy(await zyt.getAddress());

    const Lib = await ethers.getContractFactory("ZYTCompute");
    const zytCompute = await Lib.deploy();

    const Mining = await ethers.getContractFactory("ZYTMining", {
      libraries: { ZYTCompute: await zytCompute.getAddress() },
    });
    mining = await Mining.deploy(
      await config.getAddress(), await pool.getAddress(), await referral.getAddress(),
      await zyt.getAddress(), await usdt.getAddress()
    );

    const Defl = await ethers.getContractFactory("ZYTDeflation");
    deflation = await Defl.deploy(await config.getAddress(), await pool.getAddress(), await mining.getAddress());

    const cfgAddr = await config.getAddress();
    await config.setAddress("usdt", await usdt.getAddress());
    await config.setAddress("blackHole", DEAD);
    await config.setAddress("zyt", await zyt.getAddress());
    await config.setAddress("factory", await factory.getAddress());
    await config.setAddress("pool", await pool.getAddress());
    await config.setAddress("mining", await mining.getAddress());
    await config.setAddress("deflation", await deflation.getAddress());
    await config.setAddress("forceSell", await forceSell.getAddress());
    await config.setAddress("referral", await referral.getAddress());
    await config.setAddress("creator", await creator.getAddress());
    await config.setAddress("marketAddress", root.address);
    await config.setAddress("technicalAddress", carol.address);
    await config.setAddress("keeperAddress", keeper.address);

    await zyt.setMinter(await creator.getAddress());
    await zyt.setLedger(await mining.getAddress());
    await zyt.setPool(await pool.getAddress());
    await zyt.setForceSell(await forceSell.getAddress());
    await zyt.setCreator(await creator.getAddress());
    await zyt.setConfig(cfgAddr);
    await zyt.setWhiteList(await creator.getAddress(), true);
    await zyt.setWhiteList(await pool.getAddress(), true);
    await zyt.setWhiteList(await mining.getAddress(), true);
    await zyt.setWhiteList(await deflation.getAddress(), true);
    await zyt.setWhiteList(root.address, true);

    await pool.setLocker(await creator.getAddress());
    await pool.setMining(await mining.getAddress());
    await pool.setDeflation(await deflation.getAddress());
    await referral.setMining(await mining.getAddress());
    await creator.setPoolManager(await pool.getAddress());
    await mining.setDeflation(await deflation.getAddress());
    await forceSell.setKeeper(keeper.address);

    await usdt.faucet(SEED_USDT * 100n);
    await usdt.approve(await creator.getAddress(), SEED_USDT);
    await creator.createInitialPool(ZYT_MAX, SEED_USDT);
    pair = await creator.pair();
    await config.setAddress("pair", pair);
    await zyt.setPair(pair);
    await pool.setPair(pair);
    await zyt.setWhiteList(pair, true);
  });

  // ================= AUDIT-1（修复后） =================
  it("AUDIT-1-fix: withdrawLp 提空 LP 后 dailySnapshot 正常执行（通缩返回 0，快照链继续）", async function () {
    await depositOf(alice, U500, ethers.ZeroAddress);

    // 正常首日快照
    const t0 = await latestTs();
    await ethers.provider.send("evm_setNextBlockTimestamp", [t0 + DAY]);
    await deflation.connect(keeper).dailySnapshot(0);
    const dayBefore = await deflation.lastSnapshotDay();
    expect(dayBefore).to.be.gt(0n);

    // owner 提空全部 LP
    const lp = await creator.lockedLiquidity();
    await creator.withdrawLp(root.address, lp);
    expect(await creator.lockedLiquidity()).to.equal(0n);

    // 次日快照：修复后不 revert，lastSnapshotDay 正常推进
    const t1 = await latestTs();
    await ethers.provider.send("evm_setNextBlockTimestamp", [t1 + DAY]);
    await deflation.connect(keeper).dailySnapshot(0);
    expect(await deflation.lastSnapshotDay()).to.be.gt(dayBefore);
    // 分红记录为 0（无 LP 可报销），但记录本身已写入
    const day = await deflation.lastSnapshotDay();
    expect((await mining.dailyInfo(day)).dividendAmount).to.equal(0n);
    console.log("      [AUDIT-1-fix] 提空 LP 后快照链继续，lastSnapshotDay:",
                dayBefore.toString(), "→", day.toString());
  });

  // ================= AUDIT-2（修复后） =================
  it("AUDIT-2-fix: 365 天无交互 → claim 零额推进游标 → deposit 恢复", async function () {
    await depositOf(alice, U500, ethers.ZeroAddress);
    const t = await latestTs();
    await ethers.provider.send("evm_setNextBlockTimestamp", [t + 400 * DAY]);
    await ethers.provider.send("evm_mine", []);

    // deposit 仍被 strict 检查拦（设计保留：强制先结算分红）
    await usdt.connect(alice).faucet(U500);
    await usdt.connect(alice).approve(await mining.getAddress(), U500);
    await expect(
      mining.connect(alice).deposit(U500, ethers.ZeroAddress)
    ).to.be.revertedWith("Mining: settle dividend first");

    // 修复后：claim 零额成功（发 Claimed(user,0)），游标推进 365 天
    const dayBefore = (await mining.dividendOf(alice.address))[1];
    await mining.connect(alice).claimDividend();
    const dayAfter = (await mining.dividendOf(alice.address))[1];
    expect(dayAfter).to.be.gt(dayBefore);

    // deposit 恢复（toDay - from = 35 ≤ 365）
    await mining.connect(alice).deposit(U500, ethers.ZeroAddress);
    const info = await mining.userInfo(alice.address);
    expect(info.depositTotal).to.equal(U500 * 2n);
    console.log("      [AUDIT-2-fix] 游标", dayBefore.toString(), "→", dayAfter.toString(),
                "| deposit 恢复，累计入金", ethers.formatUnits(info.depositTotal, 18), "U");
  });

  // ================= AUDIT-3 =================
  it("AUDIT-3: owner 可提高 totalSupplyCap 并更换 minter 实现增发（21 亿非代码强制）", async function () {
    const supplyBefore = await zyt.totalSupply();
    expect(supplyBefore).to.equal(ZYT_MAX);

    // 1. 放宽上限（初始 cap == 21 亿，已铸满）
    await config.setUint("totalSupplyCap", 2_100_000_000_000n * E18); // 2.1 万亿

    // 2. 部署第二个 Creator（未被 initialized 锁定的新实例）并设为 minter
    const Creator = await ethers.getContractFactory("ZYTLiquidityCreator");
    const creator2 = await Creator.deploy(
      await zyt.getAddress(), await usdt.getAddress(), await factory.getAddress(), DEAD
    );
    await zyt.setMinter(await creator2.getAddress());
    // gate 放行条件为 `msg.sender == pool || msg.sender == creator`，需把新实例设为 creator
    await zyt.setCreator(await creator2.getAddress());

    // 3. 二次"建池"：铸出新的 10 亿枚（pair 已存在，直接复用 getPair 分支）
    const extra = 1_000_000_000n * E18;
    await usdt.approve(await creator2.getAddress(), 100n * E18);
    await creator2.createInitialPool(extra, 100n * E18);

    const supplyAfter = await zyt.totalSupply();
    expect(supplyAfter).to.equal(ZYT_MAX + extra);

    // 池内 ZYT 被瞬间增厚 → 价格被砸低
    const [zRes, uRes] = await pool.getReservesPublic();
    console.log("      [AUDIT-3] 供应 21亿 →", ethers.formatUnits(supplyAfter, 18),
                "| 池 ZYT:", ethers.formatUnits(zRes, 18),
                "| 价格:", ethers.formatUnits(uRes * E18 / zRes, 18));
  });

  // ================= AUDIT-4 =================
  it("AUDIT-4: 用户直转 ZYT 给 pool → 币滞留无出口，且不触发转出折算记账", async function () {
    // 降阶段 1 门槛，使 alice 可使用买额买币（获得 ZYT）
    await config.setUint("poolStage1USDT", 1_000n * E18);
    await depositOf(alice, U500, ethers.ZeroAddress);
    await usdt.connect(alice).faucet(1_000n * E18);
    await usdt.connect(alice).approve(await mining.getAddress(), 1_000n * E18);
    await mining.connect(alice).buy(100n * E18);

    const bal = await zyt.balanceOf(alice.address);
    expect(bal).to.be.gt(0n);

    const poolZytBefore = await zyt.balanceOf(await pool.getAddress());
    const divPoolBefore = await pool.dividendPoolZyt();

    // 直转 pool（pool 在白名单，走 isWhiteList[to] 分支）
    await zyt.connect(alice).transfer(await pool.getAddress(), bal);

    const poolZytAfter = await zyt.balanceOf(await pool.getAddress());
    expect(poolZytAfter - poolZytBefore).to.equal(bal);

    // 记账侧：withdrawTotal 未增加（recordTransferOut 被 `to != pool` 跳过）
    const info = await mining.userInfo(alice.address);
    expect(info.withdrawTotal).to.equal(0n);
    // 分红池记账也未增加（币不归入 dividendPoolZyt）
    expect(await pool.dividendPoolZyt()).to.equal(divPoolBefore);

    console.log("      [AUDIT-4] 滞留 pool 的 ZYT:", ethers.formatUnits(bal, 18),
                "| withdrawTotal:", info.withdrawTotal.toString());
  });

  // ================= AUDIT-5（修复后，P1-14） =================
  it("AUDIT-5-fix: 拖到窗口 4 一次性转出 → 欠账全额烧毁，免费免责路径堵死", async function () {
    await config.setUint("poolStage1USDT", 1_000n * E18);
    await depositOf(alice, U500, ethers.ZeroAddress);
    await usdt.connect(alice).faucet(1_000n * E18);
    await usdt.connect(alice).approve(await mining.getAddress(), 1_000n * E18);
    await mining.connect(alice).buy(400n * E18);
    const bal = await zyt.balanceOf(alice.address);

    const t = await latestTs();
    await ethers.provider.send("evm_setNextBlockTimestamp", [t + 61 * DAY]);
    await ethers.provider.send("evm_mine", []);
    expect(await forceSell.soldAmount(alice.address)).to.equal(0n);

    // 转 50%：soldAmount_before = 0，required = 0.5B → burned = min(0.5B, 0.5B) = 0.5B
    //   实扣 = 0.5B(转账) + 0.5B(烧) + 0.05B(税) = 1.05B > B → revert
    await expect(
      zyt.connect(alice).transfer(bob.address, bal / 2n)
    ).to.be.reverted;

    // 转 40%：burned = min(0.4B, 0.5B) = 0.4B；实扣 = 0.4(转账) + 0.4(烧) + 0.04(税) = 0.84B
    const amount = (bal * 40n) / 100n;
    const tax = (amount * 1000n) / 10000n;
    await zyt.connect(alice).transfer(bob.address, amount);
    const after = await zyt.balanceOf(alice.address);
    // 剩余 = B - 转账 - 烧(=转账额，欠账更大) - 税
    expect(after).to.equal(bal - amount - amount - tax);
    console.log("      [AUDIT-5-fix] 余额", ethers.formatUnits(bal, 18),
                "| 转 50% revert | 转 40% 通过，烧欠账后剩余", ethers.formatUnits(after, 18),
                "| soldAmount", ethers.formatUnits(await forceSell.soldAmount(alice.address), 18));
  });

  it("P1-14: 每期足额卖出的用户跨窗口转账不被烧（正常用户零影响）", async function () {
    await config.setUint("poolStage1USDT", 1_000n * E18);
    await depositOf(alice, U500, ethers.ZeroAddress);
    await usdt.connect(alice).faucet(1_000n * E18);
    await usdt.connect(alice).approve(await mining.getAddress(), 1_000n * E18);
    await mining.connect(alice).buy(400n * E18);
    const bal = await zyt.balanceOf(alice.address);

    // 窗口 1 内转出 20%（视同卖出，elapsed < 15 天 → 不触发结算）
    const t = await latestTs();
    await zyt.connect(alice).transfer(bob.address, (bal * 20n) / 100n);
    expect(await forceSell.soldAmount(alice.address)).to.equal((bal * 20n) / 100n);

    // 快进 20 天（窗口 2），alice 已完成窗口 1 的 20% 义务 → 跨窗口转账不被烧
    await ethers.provider.send("evm_setNextBlockTimestamp", [t + 20 * DAY]);
    await ethers.provider.send("evm_mine", []);
    const before = await zyt.balanceOf(alice.address);
    await zyt.connect(alice).transfer(carol.address, (bal * 10n) / 100n);
    const after = await zyt.balanceOf(alice.address);
    // 只扣转账 10% + 税 1%，无额外销毁
    expect(after).to.equal(before - (bal * 11n) / 100n);
    console.log("      [P1-14] 窗口1 卖 20% 后跨窗口转 10% → 无烧，实扣仅 11%");
  });

  // ================= AUDIT-6 =================
  it("AUDIT-6: 转账硬上限为余额 90.9%（10% 税另扣，转全部必失败）", async function () {
    // 降门槛到阶段 2，用买额买币（仅买入方启动强卖计时）
    await config.setUint("poolStage1USDT", 1_000n * E18);
    await depositOf(alice, U500, ethers.ZeroAddress);
    await usdt.connect(alice).faucet(1_000n * E18);
    await usdt.connect(alice).approve(await mining.getAddress(), 1_000n * E18);
    await mining.connect(alice).buy(400n * E18);

    const bal = await zyt.balanceOf(alice.address);

    // 转全部余额：税额从发送方额外扣，余额不足 → revert
    await expect(
      zyt.connect(alice).transfer(bob.address, bal)
    ).to.be.reverted;

    // 91% 亦不可行（91 × 1.1 = 100.1% > 100%）
    await expect(
      zyt.connect(alice).transfer(bob.address, (bal * 91n) / 100n)
    ).to.be.reverted;

    // 90% 可行
    await zyt.connect(alice).transfer(bob.address, (bal * 90n) / 100n);
    console.log("      [AUDIT-6] 余额", ethers.formatUnits(bal, 18),
                "| 转 100% revert | 转 91% revert | 转 90% 通过");
  });
});
