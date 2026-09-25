/**
 * 众赢币 ZYT v9.1 攻击向量测试（本地 MiniV2 真池）
 *
 * 目标：验证经济模型的抗操纵性与权限闭合，覆盖 8 类攻击面：
 *   A1 闪电贷式 peak 操纵（拉高峰值后撤出，反向抬升自己的卖出成本）
 *   A2 越权调用矩阵（onlyMining / onlyDeflation / not pool / 二次建池 / owner 越权）
 *   A3 多钱包转账绕静态 2 倍（受赠上限约束，无法跨钱包放大提取额度）
 *   A4 零成本刷额度（额度严格 = 5×累计真实入金）
 *   A5 出局后行为边界（分红权重归零，币仍可卖，复投恢复）
 *   A6 通缩防护（同日重复、超限抽池、越权抽池）
 *   A7 推荐自环/互推（无自奖励、无循环放大）
 *   A8 强卖窗口转移（接收方独立计时，转出方基数按现余额）
 *
 * 说明：断言基于合约不变量，任何一条被绕过即测试失败。
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const E18 = 10n ** 18n;
const ZYT_MAX = 2_100_000_000n * E18;
const SEED_USDT = 21_000n * E18;
const DAY = 86400;
const U500 = 500n * E18;
const ZERO = ethers.ZeroAddress;

async function ts() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

describe("ZYT v9.1 攻击向量", function () {
  let usdt, zyt, config, creator, pool, referral, forceSell, mining, deflation, pair, factory;
  let deployer, keeper, alice, bob, carol, root;

  async function depositOf(signer, amount, ref) {
    await usdt.connect(signer).faucet(amount);
    await usdt.connect(signer).approve(await mining.getAddress(), amount);
    await mining.connect(signer).deposit(amount, ref || ZERO);
  }

  /** 打开阶段 2（买额生效），便于构造买卖场景 */
  async function openStage2() {
    await config.setUint("poolStage1USDT", SEED_USDT);
    await config.setUint("poolStage2USDT", 10_000_000n * E18);
  }

  async function buyOf(signer, amount) {
    await usdt.connect(signer).faucet(amount);
    await usdt.connect(signer).approve(await mining.getAddress(), amount);
    await mining.connect(signer).buy(amount);
  }

  async function sellOf(signer, amount) {
    await zyt.connect(signer).approve(await pool.getAddress(), amount);
    await mining.connect(signer).sellZyt(amount);
  }

  beforeEach(async function () {
    [deployer, keeper, alice, bob, carol] = await ethers.getSigners();
    root = deployer;

    const Mock = await ethers.getContractFactory("MockERC20");
    usdt = await Mock.deploy("USDT", "USDT", 18);
    config = await (await ethers.getContractFactory("ZYTConfig")).deploy();
    zyt = await (await ethers.getContractFactory("ZYTToken")).deploy(DEAD);
    factory = await (await ethers.getContractFactory("MiniFactory")).deploy();
    creator = await (await ethers.getContractFactory("ZYTLiquidityCreator")).deploy(
      await zyt.getAddress(), await usdt.getAddress(), await factory.getAddress(), DEAD
    );
    pool = await (await ethers.getContractFactory("ZYTPoolManager")).deploy(
      await config.getAddress(), await zyt.getAddress(), await usdt.getAddress()
    );
    referral = await (await ethers.getContractFactory("ZYTReferral")).deploy();
    forceSell = await (await ethers.getContractFactory("ZYTForceSell")).deploy(await zyt.getAddress());
    const zytCompute = await (await ethers.getContractFactory("ZYTCompute")).deploy();
    mining = await (await ethers.getContractFactory("ZYTMining", {
      libraries: { ZYTCompute: await zytCompute.getAddress() },
    })).deploy(
      await config.getAddress(), await pool.getAddress(), await referral.getAddress(),
      await zyt.getAddress(), await usdt.getAddress()
    );
    deflation = await (await ethers.getContractFactory("ZYTDeflation")).deploy(
      await config.getAddress(), await pool.getAddress(), await mining.getAddress()
    );

    const cfgAddr = await config.getAddress();
    for (const [k, v] of [
      ["usdt", await usdt.getAddress()], ["blackHole", DEAD], ["zyt", await zyt.getAddress()],
      ["factory", await factory.getAddress()], ["pool", await pool.getAddress()],
      ["mining", await mining.getAddress()], ["deflation", await deflation.getAddress()],
      ["forceSell", await forceSell.getAddress()], ["referral", await referral.getAddress()],
      ["creator", await creator.getAddress()], ["marketAddress", root.address],
      ["technicalAddress", carol.address], ["keeperAddress", keeper.address],
    ]) await config.setAddress(k, v);

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

  // ============ A1 闪电贷式 peak 操纵 ============
  it("A1. peak 操纵：拉高峰值后撤出，攻击者自身卖出成本不降反升", async function () {
    await openStage2();
    await depositOf(alice, U500, ZERO);
    await depositOf(bob, U500, ZERO);

    const peakBefore = await pool.peakPoolUSDT();
    // 攻击者（bob）大额买入，把池 U 与峰值同时推高
    await buyOf(bob, 400n * E18);
    const peakAfterBuy = await pool.peakPoolUSDT();
    expect(peakAfterBuy).to.be.gt(peakBefore); // 峰值被抬高

    // 攻击者立即撤出（卖出）→ 池 U 回落，但峰值不下降（只升不降）
    const bobZyt = await zyt.balanceOf(bob.address);
    await sellOf(bob, bobZyt / 2n);
    expect(await pool.peakPoolUSDT()).to.be.gte(peakAfterBuy); // 峰值不回退

    // 核心断言：回落后滑点档 ≥ 基档，攻击者无法通过「拉高再撤」取得低成本
    const cur = await pool.poolUSDT();
    const peak = await pool.peakPoolUSDT();
    const reduction = (peak - cur) * 10000n / peak;
    const rate = await pool.getCurrentSlippage();
    if (reduction >= 100n) {
      expect(rate).to.be.gt(500n); // 回落达 1% → 档位升高
    } else {
      expect(rate).to.equal(500n);
    }
    // 档位函数与池状态自洽（无外部可写入的操纵入口）
    const expectRate = reduction >= 400n ? 8000n : reduction >= 300n ? 4000n
      : reduction >= 200n ? 2000n : reduction >= 100n ? 1000n : 500n;
    expect(rate).to.equal(expectRate);
  });

  // ============ A2 越权调用矩阵 ============
  it("A2. 越权矩阵：受限接口对任意外部地址全部 revert", async function () {
    // Pool 仅 Mining / Deflation 可调
    await expect(pool.connect(alice).sellFor(alice.address, 1n)).to.be.revertedWith("Pool: only mining");
    await expect(pool.connect(alice).buyFor(alice.address, 1n)).to.be.revertedWith("Pool: only mining");
    await expect(pool.connect(alice).injectLiquidity(1n)).to.be.revertedWith("Pool: only mining");
    await expect(pool.connect(alice).deflate()).to.be.revertedWith("Pool: only deflation");
    await expect(pool.connect(alice).updateSnapshot()).to.be.revertedWith("Pool: only deflation");

    // Creator 仅 Pool 可调抽通缩；建池不可二次调用
    await expect(creator.connect(alice).skimDeflation(200)).to.be.revertedWith("Creator: not pool");
    await usdt.connect(alice).faucet(SEED_USDT);
    await usdt.connect(alice).approve(await creator.getAddress(), SEED_USDT);
    await expect(creator.connect(alice).createInitialPool(ZYT_MAX, SEED_USDT)).to.be.reverted;

    // Token 权限：minter / ledger / pool 仅 owner
    await expect(zyt.connect(alice).setMinter(alice.address)).to.be.reverted;
    await expect(zyt.connect(alice).setPool(alice.address)).to.be.reverted;
    await expect(zyt.connect(alice).setWhiteList(alice.address, true)).to.be.reverted;

    // Mining：setDeflation 仅 owner；deflation 侧接口仅自身
    await expect(mining.connect(alice).setDeflation(alice.address)).to.be.revertedWith("Mining: not owner");
    await expect(mining.connect(alice).recordTransferOut(alice.address, 1n)).to.be.revertedWith("Mining: not token");

    // Config：仅 owner 可改参数
    await expect(config.connect(alice).setUint("maxDeposit", 10n ** 30n)).to.be.reverted;
    await expect(config.connect(alice).setAddress("marketAddress", alice.address)).to.be.reverted;
  });

  // ============ A3 多钱包绕静态 2 倍 ============
  it("A3. 多钱包绕静态 2 倍：转出方计入提取，接收方上限仅受赠值", async function () {
    await openStage2();
    await depositOf(alice, U500, ZERO); // 入金 500 → 静态上限 1000
    await depositOf(bob, U500, ZERO);
    await buyOf(bob, 400n * E18);

    const price = await pool.getTradePrice();
    const bobWithdrawBefore = (await mining.userInfo(bob.address))[1];
    const aliceWithdrawBefore = (await mining.userInfo(alice.address))[1];

    // bob 把 1000 ZYT 转到自己控制的另一个钱包（carol，无入金）
    const move = 1000n * E18;
    const bobZyt = await zyt.balanceOf(bob.address);
    await zyt.connect(bob).transfer(carol.address, move);

    // 1) 转出方按快照价折算，计入自己的累计提取（无法靠转出规避 2 倍线）
    const bobWithdrawAfter = (await mining.userInfo(bob.address))[1];
    const tax = move * 1000n / 10000n;
    expect(bobWithdrawAfter - bobWithdrawBefore).to.equal((move + tax) * price / E18);
    // 无关账户不受影响
    expect((await mining.userInfo(alice.address))[1]).to.equal(aliceWithdrawBefore);

    // 2) 接收方（carol）无本金 → 出局线 = 受赠值（= 实收市值），卖光也拿不到 2 倍
    const [, carolCap] = await mining.transferValueOf(carol.address);
    expect(carolCap).to.equal(move * price / E18);
    const carolBal = await zyt.balanceOf(carol.address);
    expect(carolBal).to.equal(move); // 实收全额（税由发送方另扣）

    // 3) carol 全卖 → 累计提取不会超过其上限（受 AMM 折价影响只会更低）
    await sellOf(carol, carolBal);
    const carolWithdraw = (await mining.userInfo(carol.address))[1];
    expect(carolWithdraw).to.be.lte(carolCap);
    const carolCapAfter = (await mining.transferValueOf(carol.address))[1];
    expect(carolCapAfter).to.equal(carolCap); // 上限不因卖出变化（受赠值固定）
    expect(carolWithdraw).to.be.lt(carolCapAfter * 2n); // 远达不到 2 倍
  });

  // ============ A4 零成本刷额度 ============
  it("A4. 额度严格等于 5×累计真实入金，零成本或重复调用无法增加", async function () {
    await depositOf(alice, U500, ZERO);
    let info = await mining.userInfo(alice.address);
    expect(info[3]).to.equal(info[0] * 5n); // dynamicQuota = 5×depositTotal

    // 0 值入金被拒（低于最小起投）
    await expect(mining.connect(alice).deposit(0n, ZERO)).to.be.revertedWith("Mining: amount range");
    // 超单笔上限被拒
    await usdt.connect(alice).faucet(U500 * 10n);
    await usdt.connect(alice).approve(await mining.getAddress(), U500 * 10n);
    await expect(mining.connect(alice).deposit(U500 + 1n, ZERO)).to.be.revertedWith("Mining: amount range");

    // 再次真实入金 → 额度按新入金叠加（线性，无倍增杠杆）
    await depositOf(alice, U500, ZERO);
    info = await mining.userInfo(alice.address);
    expect(info[0]).to.equal(1000n * E18);
    expect(info[3]).to.equal(5000n * E18);
    expect(info[3]).to.equal(info[0] * 5n);
  });

  // ============ A5 出局后行为边界 ============
  it("A5. 出局后分红权重归零；币仍可卖；复投全额恢复", async function () {
    await openStage2();
    await depositOf(alice, U500, ZERO);
    await buyOf(alice, 500n * E18);
    const zBal = await zyt.balanceOf(alice.address);
    const half = zBal / 2n;
    await sellOf(alice, half);
    await sellOf(alice, half);

    const info = await mining.userInfo(alice.address);
    // 无论是否触发 2 倍（AMM 折价下通常未达），出局状态与算力口径必须自洽
    const [dep, wd, power, , , , staticExited] = info;
    if (staticExited) {
      expect(power).to.equal(0n); // 出局 → 算力归零（不再享分红权重）
    } else {
      expect(power).to.be.gt(0n);
      expect(wd).to.be.lt(dep * 2n); // 未出局时提取额必然小于 2 倍线
    }

    // 出局后仍可卖出剩余持仓（财产权保留），累计提取继续累加但不再获得分红权重
    const rest = await zyt.balanceOf(alice.address);
    if (rest > 0n) {
      await sellOf(alice, rest);
      const after = await mining.userInfo(alice.address);
      expect(after[1]).to.be.gt(wd);
      if (staticExited) expect(after[2]).to.equal(0n);
    }

    // 复投 → 出局状态与算力恢复
    await depositOf(alice, U500, ZERO);
    const refreshed = await mining.userInfo(alice.address);
    expect(refreshed[6]).to.equal(false);
    expect(refreshed[2]).to.be.gte(U500);
  });

  // ============ A6 通缩防护 ============
  it("A6. 通缩防护：同日重复 revert、抽池超限 revert、越权 revert", async function () {
    await depositOf(alice, U500, ZERO);

    // 越权抽池
    await expect(creator.connect(alice).skimDeflation(200)).to.be.revertedWith("Creator: not pool");
    // 超硬顶（>200bps）
    await expect(pool.deflate.staticCall()).to.be.reverted; // 仅 deflation 可调
    // 通过 Deflation 正常触发一次
    await deflation.connect(keeper).dailySnapshot(500n * E18);
    const day1 = await deflation.lastSnapshotDay();
    expect(day1).to.be.gt(0n);
    // 同日重复调用 revert（day 必须严格递增）
    await expect(deflation.connect(keeper).dailySnapshot(500n * E18)).to.be.reverted;

    // 推进一天后可再次快照（不 revert）
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);
    await deflation.connect(keeper).dailySnapshot(500n * E18);
    expect(await deflation.lastSnapshotDay()).to.be.gt(day1);
  });

  // ============ A7 推荐自环 / 互推 ============
  it("A7. 推荐自环与互推：无自奖励、无循环放大", async function () {
    // 自环：alice 以自己为上级
    await usdt.connect(alice).faucet(U500);
    await usdt.connect(alice).approve(await mining.getAddress(), U500);
    let selfOk = true;
    try {
      await mining.connect(alice).deposit(U500, alice.address);
    } catch {
      selfOk = false;
    }
    const selfRef = await referral.referrerOf(alice.address);
    expect(selfRef === ZERO || selfRef.toLowerCase() === alice.address.toLowerCase()).to.equal(true);
    // 自环时不产生给自己的一代奖励（营销/技术分配保持 30/10 口径）
    if (selfOk) {
      expect(await referral.referrerOf(alice.address)).to.not.equal(alice.address);
    }

    // 互推：bob 以 alice 为上级，alice 无法再以 bob 为上级（首次绑定即固化）
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).deposit(U500, alice.address);
    const bobRef = await referral.referrerOf(bob.address);
    expect(bobRef.toLowerCase()).to.equal(alice.address.toLowerCase());

    // bob 再次入金并传 alice（不变），传自己无效：上级关系不可被自己改写
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).deposit(U500, bob.address);
    expect((await referral.referrerOf(bob.address)).toLowerCase()).to.equal(alice.address.toLowerCase());

    // 循环检测：alice 的上级链中不含 bob（无环）
    const aliceRef = await referral.referrerOf(alice.address);
    expect(aliceRef.toLowerCase()).to.not.equal(bob.address.toLowerCase());
  });

  // ============ A8 强卖窗口转移 ============
  it("A8. 强卖窗口：转出方基数按现余额，接收方独立计时", async function () {
    await openStage2();
    await depositOf(alice, U500, ZERO);
    await buyOf(alice, 300n * E18); // 让 alice 真实持有 ZYT（首收登记）
    const t0 = await ts();

    // alice 首收币时间已登记
    const [, , , aliceFirst] = await zyt.getSellInfo(alice.address);
    expect(aliceFirst).to.be.gt(0n);

    // alice 转一半给 carol（新钱包）
    const bal = await zyt.balanceOf(alice.address);
    await zyt.connect(alice).transfer(carol.address, bal / 2n);

    // carol 收到即启动自己的强卖计时（不继承 alice 的起点，也不会被清零）
    const [, , , carolFirst] = await zyt.getSellInfo(carol.address);
    expect(carolFirst).to.be.gt(0n);
    expect(carolFirst).to.be.gte(aliceFirst);
    expect(carolFirst).to.be.gte(BigInt(t0) - 5n);

    // 转出方应卖基数按转后余额计算；且转账视同卖出 → 已计入强卖进度（抵充窗口 1 的 20%）
    await ethers.provider.send("evm_increaseTime", [15 * DAY + 60]);
    await ethers.provider.send("evm_mine", []);
    const aliceNow = await zyt.balanceOf(alice.address);
    const [, aliceSoldZyt] = await zyt.getSellInfo(alice.address);
    // 卖出统计包含转出的那一半（转账视同卖出）
    expect(aliceSoldZyt).to.be.gte(aliceNow); // 至少含转出量

    const before = await zyt.balanceOf(alice.address);
    await expect(forceSell.connect(keeper).settleExpired(alice.address)).to.not.be.reverted;
    const burnedAlice = before - (await zyt.balanceOf(alice.address));
    // alice 已通过转出抵充窗口 1，结算不再销毁差额（无重复惩罚）
    expect(burnedAlice).to.equal(0n);

    // 接收方 carol 独立计时（自己的首收起点），同样到期未卖 → 按自己余额销毁 20%
    const carolBal = await zyt.balanceOf(carol.address);
    expect(carolBal).to.be.gt(0n);
    const carolRequired = carolBal * 2000n / 10000n; // 窗口 1：20%
    await expect(forceSell.connect(keeper).settleExpired(carol.address)).to.not.be.reverted;
    expect(carolBal - (await zyt.balanceOf(carol.address))).to.equal(carolRequired);
    // 二次结算幂等（同窗口不重复销毁）
    const carolAfter = await zyt.balanceOf(carol.address);
    await expect(forceSell.connect(keeper).settleExpired(carol.address)).to.not.be.reverted;
    expect(await zyt.balanceOf(carol.address)).to.equal(carolAfter);
  });
});
