/**
 * ZYT v9.1 漏洞检测（审计实证）
 * 目的：用可复现的用例证实静态审计结论，不改动生产代码。
 * 覆盖：
 *   AUDIT-1  withdrawLp 提空 LP → dailySnapshot 仍正常运行（修复后语义，通缩返回 0）
 *   AUDIT-2  365 天无交互 → claim 零额推进游标 → deposit 恢复（修复后语义）
 *   AUDIT-3  owner 可提高 totalSupplyCap 并更换 minter → 21 亿上限非代码强制
 *   AUDIT-4  用户直转 ZYT 给 pool：币滞留且转出折算被跳过（withdrawTotal 不增）
 *   AUDIT-5  窗口内超额卖出被拒；无「拖到期末一次性转出免责」路径
 *   P1-14    窗口内卖足额度的用户结算零销毁；次期自动降为常规 10% 档
 *   AUDIT-6  转账硬上限为余额 90.9%（10% 税另扣，转全部必失败）
 *
 * v9.2（2026-10-14）：卖出仅限每月 14/28 日历窗（北京时间）；旧「首收后 4×15 天窗口 +
 *   转账即时烧欠账」模型已作废，改为「当期额度 + 次日凌晨 keeper 结算销毁」。
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const E18 = 10n ** 18n;
const TOTAL_ZYT = 33_000_000_000n * E18;   // v9.2 全量：21 亿组池 + 12 亿 Treasury
const POOL_ZYT = 2_100_000_000n * E18;
const SEED_USDT = 21_000n * E18;
const DAY = 86400;
const U500 = 500n * E18;

async function latestTs() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

/**
 * v9.2 卖币窗口（北京时间 14/28 日全天，UTC+8）：
 * 把链上时钟推进到「下一个卖币日」的 00:00，返回 { ts, id, dom }。
 * 相对推进而非固定绝对时刻：Hardhat 链上时钟跨用例单调递增且跨文件保持。
 */
async function gotoWindow(opts = {}) {
  const want = opts.dom || null;
  const now = await latestTs();
  for (let d = 1; d <= 70; d++) {
    const t = now + d * DAY;
    const bj = new Date((t + 8 * 3600) * 1000);
    const dom = bj.getUTCDate();
    if ((dom !== 14 && dom !== 28) || (want && dom !== want)) continue;
    const dayStart = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - 1, 16, 0, 0) / 1000;
    const target = dayStart + (opts.offsetDays || 0) * DAY;
    await setTime(target);
    return {
      ts: target,
      id: BigInt(bj.getUTCFullYear() * 10000 + (bj.getUTCMonth() + 1) * 100 + dom),
      dom,
    };
  }
  throw new Error("gotoWindow: 70 天内未找到卖币日");
}

async function setTime(t) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [t]);
  await ethers.provider.send("evm_mine", []);
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
    await forceSell.setMining(await mining.getAddress()); // v9.2：窗口复位授权（复投 / 迁移）

    await creator.setTreasury(root.address); // 模拟 W3 营销 Safe（上方已白名单，红线第 1 条）
    await usdt.faucet(SEED_USDT * 100n);
    await usdt.approve(await creator.getAddress(), SEED_USDT);
    await creator.createInitialPool(TOTAL_ZYT, POOL_ZYT, SEED_USDT);
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
    // v9.2 单钱包累计入金上限 500U：本用例按 200U 构造（两次入金合计 400U）
    const U200 = 200n * E18;
    await depositOf(alice, U200, ethers.ZeroAddress);
    const t = await latestTs();
    await ethers.provider.send("evm_setNextBlockTimestamp", [t + 400 * DAY]);
    await ethers.provider.send("evm_mine", []);

    // deposit 仍被 strict 检查拦（设计保留：强制先结算分红）
    await usdt.connect(alice).faucet(U200);
    await usdt.connect(alice).approve(await mining.getAddress(), U200);
    await expect(
      mining.connect(alice).deposit(U200, ethers.ZeroAddress)
    ).to.be.revertedWith("Mining: settle dividend first");

    // 修复后：claim 零额成功（发 Claimed(user,0)），游标推进 365 天
    const dayBefore = (await mining.dividendOf(alice.address))[1];
    await mining.connect(alice).claimDividend();
    const dayAfter = (await mining.dividendOf(alice.address))[1];
    expect(dayAfter).to.be.gt(dayBefore);

    // deposit 恢复（toDay - from = 35 ≤ 365）
    await mining.connect(alice).deposit(U200, ethers.ZeroAddress);
    const info = await mining.userInfo(alice.address);
    expect(info.depositTotal).to.equal(U200 * 2n);
    console.log("      [AUDIT-2-fix] 游标", dayBefore.toString(), "→", dayAfter.toString(),
                "| deposit 恢复，累计入金", ethers.formatUnits(info.depositTotal, 18), "U");
  });

  // ================= AUDIT-3 =================
  it("AUDIT-3: owner 可提高 totalSupplyCap 并更换 minter 实现增发（33 亿非代码强制）", async function () {
    const supplyBefore = await zyt.totalSupply();
    expect(supplyBefore).to.equal(TOTAL_ZYT);

    // 1. 放宽上限（初始 cap == 33 亿，已铸满）
    await config.setUint("totalSupplyCap", 2_100_000_000_000n * E18); // 2.1 万亿

    // 2. 部署第二个 Creator（未被 initialized 锁定的新实例）并设为 minter
    const Creator = await ethers.getContractFactory("ZYTLiquidityCreator");
    const creator2 = await Creator.deploy(
      await zyt.getAddress(), await usdt.getAddress(), await factory.getAddress(), DEAD
    );
    await zyt.setMinter(await creator2.getAddress());
    // gate 放行条件为 `msg.sender == pool || msg.sender == creator`，需把新实例设为 creator
    await zyt.setCreator(await creator2.getAddress());

    // 3. 二次"建池"：再铸 10 亿（5 亿组池 + 5 亿转 treasury；pair 已存在，直接复用 getPair 分支）
    const extra = 1_000_000_000n * E18;
    await creator2.setTreasury(root.address); // root 已在白名单，满足红线守护
    await usdt.approve(await creator2.getAddress(), 100n * E18);
    await creator2.createInitialPool(extra, extra / 2n, 100n * E18);

    const supplyAfter = await zyt.totalSupply();
    expect(supplyAfter).to.equal(TOTAL_ZYT + extra);

    // 池内 ZYT 被瞬间增厚 → 价格被砸低
    const [zRes, uRes] = await pool.getReservesPublic();
    console.log("      [AUDIT-3] 供应 21亿 →", ethers.formatUnits(supplyAfter, 18),
                "| 池 ZYT:", ethers.formatUnits(zRes, 18),
                "| 价格:", ethers.formatUnits(uRes * E18 / zRes, 18));
  });

  // ================= AUDIT-4 =================
  it("AUDIT-4: 用户直转 ZYT 给 pool → 币滞留无出口，且不触发转出折算记账", async function () {
    await gotoWindow(); // v9.2：转入 pool 视同卖出，受卖币窗口约束
    // 降阶段 1 门槛，使 alice 可使用买额买币（获得 ZYT）
    await config.setUint("poolStage1USDT", 1_000n * E18);
    await depositOf(alice, U500, ethers.ZeroAddress);
    await usdt.connect(alice).faucet(1_000n * E18);
    await usdt.connect(alice).approve(await mining.getAddress(), 1_000n * E18);
    await mining.connect(alice).buy(100n * E18);

    const bal = await zyt.balanceOf(alice.address);
    expect(bal).to.be.gt(0n);

    // v9.2：直转 pool 视同卖出，受当期额度（首期 20%）约束 → 全额转出被拒
    await expect(zyt.connect(alice).transfer(await pool.getAddress(), bal))
      .to.be.revertedWith("FS: over quota");

    const move = bal * 2000n / 10000n;
    const poolZytBefore = await zyt.balanceOf(await pool.getAddress());
    const divPoolBefore = await pool.dividendPoolZyt();

    // 直转 pool（pool 在白名单，走 isWhiteList[to] 分支）
    await zyt.connect(alice).transfer(await pool.getAddress(), move);

    const poolZytAfter = await zyt.balanceOf(await pool.getAddress());
    expect(poolZytAfter - poolZytBefore).to.equal(move);

    // 记账侧：withdrawTotal 未增加（recordTransferOut 被 `to != pool` 跳过）
    const info = await mining.userInfo(alice.address);
    expect(info.withdrawTotal).to.equal(0n);
    // 分红池记账也未增加（币不归入 dividendPoolZyt）
    expect(await pool.dividendPoolZyt()).to.equal(divPoolBefore);

    console.log("      [AUDIT-4] 滞留 pool 的 ZYT:", ethers.formatUnits(move, 18),
                "| withdrawTotal:", info.withdrawTotal.toString());
  });

  // ================= AUDIT-5（修复后，P1-14） =================
  it("AUDIT-5-fix: 窗口内超额卖出被拒；无「拖到期末一次性转出免责」路径", async function () {
    const g = await gotoWindow();
    await config.setUint("poolStage1USDT", 1_000n * E18);
    await depositOf(alice, U500, ethers.ZeroAddress);
    await usdt.connect(alice).faucet(1_000n * E18);
    await usdt.connect(alice).approve(await mining.getAddress(), 1_000n * E18);
    await mining.connect(alice).buy(400n * E18);
    const bal = await zyt.balanceOf(alice.address);

    // 1) 窗口内超额卖出（首期额度 = 余额 × 20%）→ 直接 revert，无「一次性卖出」通道
    await zyt.connect(alice).approve(await pool.getAddress(), bal);
    await expect(mining.connect(alice).sellZyt(bal)).to.be.revertedWith("FS: over quota");
    await expect(mining.connect(alice).sellZyt(bal * 2000n / 10000n + 1n))
      .to.be.revertedWith("FS: over quota");

    // 2) 转账视同卖出：能抵充当期额度，但成本 = 10% 税 + 币转出（非免费免责）
    const move = bal * 2000n / 10000n;
    const supplyBefore = await zyt.totalSupply();
    await zyt.connect(alice).transfer(bob.address, move);
    const w = await forceSell.windows(alice.address);
    expect(w[0]).to.equal(g.id);
    expect(w[1]).to.equal(move); // 额度 = 转账前余额 × 20%
    expect(w[2]).to.equal(move); // 已卖进度含转出量
    expect(await zyt.totalSupply()).to.be.lt(supplyBefore); // 转账税 40% 进入销毁

    // 3) 窗口外转账：不阻断、不销毁欠账、不计入当期额度
    await setTime(g.ts + DAY + 1800); // 15/29 日（窗口已结束）
    const bal2 = await zyt.balanceOf(alice.address);
    await zyt.connect(alice).transfer(carol.address, bal2 / 10n);
    const w2 = await forceSell.windows(alice.address);
    expect(w2[2]).to.equal(w[2]); // 窗口外转出不改变当期已卖进度
    console.log("      [AUDIT-5-fix] 超额卖出 revert | 转出抵充额度", ethers.formatUnits(move, 18),
                "| 窗口外转出不占当期额度");
  });

  it("P1-14: 窗口内卖足额度的用户结算零销毁；次期自动降为常规 10% 档", async function () {
    const g = await gotoWindow({ dom: 14 });
    await config.setUint("poolStage1USDT", 1_000n * E18);
    await depositOf(alice, U500, ethers.ZeroAddress);
    await usdt.connect(alice).faucet(1_000n * E18);
    await usdt.connect(alice).approve(await mining.getAddress(), 1_000n * E18);
    await mining.connect(alice).buy(400n * E18);
    const bal = await zyt.balanceOf(alice.address);

    // 首期窗口（14 日）：卖足 20%
    await zyt.connect(alice).approve(await pool.getAddress(), bal);
    await mining.connect(alice).sellZyt(bal * 2000n / 10000n);
    await setTime(g.ts + DAY + 1800);
    const after1 = await zyt.balanceOf(alice.address);
    await forceSell.connect(keeper).settleExpired(alice.address);
    expect(await zyt.balanceOf(alice.address)).to.equal(after1); // 卖足 → 结算零销毁

    // 下一个窗口（28 日）：首期已结束，档位降为常规 10%
    const g2 = await gotoWindow({ dom: 28 });
    expect(await forceSell.tierBpsOf(alice.address)).to.equal(1000n);
    const bal2 = await zyt.balanceOf(alice.address);
    await zyt.connect(alice).approve(await pool.getAddress(), bal2);
    await expect(mining.connect(alice).sellZyt(bal2 * 1000n / 10000n + 1n))
      .to.be.revertedWith("FS: over quota");
    await mining.connect(alice).sellZyt(bal2 * 1000n / 10000n);
    const w2 = await forceSell.windows(alice.address);
    expect(w2[0]).to.equal(g2.id);
    expect(w2[1]).to.equal(bal2 * 1000n / 10000n);
    console.log("      [P1-14] 首期卖足 20% 结算零销毁 | 次期档位 10% 生效");
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
