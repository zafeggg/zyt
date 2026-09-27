/**
 * 众赢币 ZYT v9 测试（USDT↔ZYT 单币直换，真实 MiniPair 底池）
 * 覆盖：建池 / 入金 40-60 / 阶段与买 / 卖与滑点档 / 转账税 / 静态出局 /
 *       动态额度加速释放 / 每日通缩（U 回池 sync）/ 强制卖出 / 真池 gate / 滑点档位
 * 注意：单笔入金上限 500U（maxDeposit），全部用例按此约束构造。
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const E18 = 10n ** 18n;
const ZYT_MAX = 2_100_000_000n * E18;
const SEED_USDT = 21_000n * E18;
const DAY = 86400;
const U500 = 500n * E18;

async function ts() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

describe("ZYT v9", function () {
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
    creator = await Creator.deploy(await zyt.getAddress(), await usdt.getAddress(), await factory.getAddress(), DEAD);

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

    // ---- 接线 ----
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
    await zyt.setWhiteList(root.address, true); // 营销地址豁免转账税

    await pool.setLocker(await creator.getAddress());
    await pool.setMining(await mining.getAddress());
    await pool.setDeflation(await deflation.getAddress());
    await referral.setMining(await mining.getAddress());
    await creator.setPoolManager(await pool.getAddress());
    await mining.setDeflation(await deflation.getAddress());
    await forceSell.setKeeper(keeper.address);

    // ---- 建池 ----
    await usdt.faucet(SEED_USDT * 100n);
    await usdt.approve(await creator.getAddress(), SEED_USDT);
    await creator.createInitialPool(ZYT_MAX, SEED_USDT);
    pair = await creator.pair();
    await config.setAddress("pair", pair);
    await zyt.setPair(pair);
    await pool.setPair(pair);
    await zyt.setWhiteList(pair, true);
  });

  it("1. 建池：全量铸造、LP 锁仓、初始价 0.00001U", async function () {
    expect(await zyt.totalSupply()).to.equal(ZYT_MAX);
    expect(await creator.lockedLiquidity()).to.be.gt(0n);
    const [zRes, uRes] = await pool.getReservesPublic();
    expect(zRes).to.equal(ZYT_MAX);
    expect(uRes).to.equal(SEED_USDT);
    expect(await pool.getPrice()).to.equal(SEED_USDT * E18 / ZYT_MAX); // 1e13
  });

  it("2. 入金 500U：40% 直发 + 60% 组 LP 销毁 + 算力/买额/动态额度", async function () {
    const marketBefore = await usdt.balanceOf(root.address);
    const techBefore = await usdt.balanceOf(carol.address);
    const lpBurnedBefore = await pool.totalLpBurned();

    await depositOf(alice, U500, ethers.ZeroAddress);

    // 40%：无推荐链 → 30% 转营销、10% 转技术
    expect(await usdt.balanceOf(root.address) - marketBefore).to.equal(150n * E18);
    expect(await usdt.balanceOf(carol.address) - techBefore).to.equal(50n * E18);
    // 60%：LP 凭证销毁
    expect(await pool.totalLpBurned() - lpBurnedBefore).to.be.gt(0n);
    // 记账
    const info = await mining.userInfo(alice.address);
    expect(info.depositTotal).to.equal(U500);
    expect(info.power).to.equal(U500);
    expect(info.buyQuotaLeft).to.equal(U500);
    expect(info.dynamicQuota).to.equal(2500n * E18);
    expect(await pool.poolUSDT()).to.be.gt(SEED_USDT);
  });

  it("3. 真池 gate：阶段 1 禁买；绕过合约直接交易被拦", async function () {
    await depositOf(alice, U500, ethers.ZeroAddress);

    // 默认阈值（1000 万）：池 U ≈ 2.15 万 → 阶段 1 禁买
    expect(await pool.getStage()).to.equal(1);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await expect(mining.connect(bob).buy(U500)).to.be.revertedWith("Mining: buy disabled in stage1");

    // 抬到阶段 2，bob 买入获得 ZYT
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10_000_000n * E18);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).deposit(U500, ethers.ZeroAddress);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);
    expect(await zyt.balanceOf(bob.address)).to.be.gt(0n);

    // 绕过 1：直接把 ZYT 转给 pair（卖出）→ 卖闸拦截
    await expect(zyt.connect(bob).transfer(pair, 1000n * E18))
      .to.be.revertedWith("ZYT: pair inflow gated");

    // 绕过 2：直接调 pair.swap（买入）→ 买闸拦截（swap 输出侧按 pair 排序动态定）
    await usdt.connect(carol).faucet(100n * E18);
    await usdt.connect(carol).transfer(pair, 100n * E18);
    const p = await ethers.getContractAt("MiniPair", pair);
    const zIsT0 = await pool.zytIsToken0();
    const zytOut = 1000n * E18;
    // 底层被买闸（ZYT: pair outflow gated）拦截，Mock 的低级 call 将其包装为 transfer failed
    await expect(
      p.connect(carol).swap(zIsT0 ? zytOut : 0n, zIsT0 ? 0n : zytOut, carol.address, "0x")
    ).to.be.revertedWith("MiniPair: transfer failed");
  });

  it("4. 阶段 2 买入（消耗买额）与卖出（滑点 30/30/40）", async function () {
    await depositOf(alice, U500, ethers.ZeroAddress);
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10_000_000n * E18);
    expect(await pool.getStage()).to.equal(2);

    // bob 入金获买额 → 买入 500U
    await depositOf(bob, U500, ethers.ZeroAddress);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);
    const bobZyt = await zyt.balanceOf(bob.address);
    expect(bobZyt).to.be.gt(0n);
    expect((await mining.userInfo(bob.address)).buyQuotaLeft).to.equal(0n);
    await expect(mining.connect(bob).buy(1n)).to.be.revertedWith("Mining: over buy quota");
    expect(await pool.swapGate()).to.equal(false); // gate 复位

    // 卖出 1/2：滑点 5%，30/30/40（卖出 approve 对象 = PoolManager）
    const marketBefore = await zyt.balanceOf(root.address);
    const divBefore = await pool.dividendPoolZyt();
    const supplyBefore = await zyt.totalSupply();
    const uBefore = await usdt.balanceOf(bob.address);
    await zyt.connect(bob).approve(await pool.getAddress(), bobZyt / 2n);
    await mining.connect(bob).sellZyt(bobZyt / 2n);
    const slip = (bobZyt / 2n) * 500n / 10000n;
    // 合约分配：m = d = slip*3/10（向下取整），burn 吸收截断残差 = slip - m - d
    const m = slip * 3000n / 10000n;
    expect(await zyt.balanceOf(root.address) - marketBefore).to.equal(m);
    expect(await pool.dividendPoolZyt() - divBefore).to.equal(m);
    expect(supplyBefore - (await zyt.totalSupply())).to.equal(slip - 2n * m);
    const usdtOut = await usdt.balanceOf(bob.address) - uBefore;
    expect(usdtOut).to.be.gt(0n);
    // 2026-09-24 双计修复断言：withdrawTotal 必须恰好等于卖出实收（只计一次，
    // 用户→pool 拉币不再触发 recordTransferOut 折算，否则 2 倍出局线提前触发）
    expect((await mining.userInfo(bob.address)).withdrawTotal).to.equal(usdtOut);
  });

  it("5. 转账视同卖出：10% 税（40 烧/30 营销/30 分红）+ 双向记账", async function () {
    await depositOf(alice, U500, ethers.ZeroAddress);
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10000000n * E18);
    await depositOf(bob, U500, ethers.ZeroAddress);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);

    const price = await pool.getTradePrice();
    const supplyBefore = await zyt.totalSupply();
    const marketBefore = await zyt.balanceOf(root.address);
    const divBefore = await pool.dividendPoolZyt();
    const bobWithdrawBefore = (await mining.userInfo(bob.address)).withdrawTotal;

    const amount = 1000n * E18; // 1000 枚 ZYT
    await zyt.connect(bob).transfer(carol.address, amount);

    const tax = amount * 1000n / 10000n;
    expect(supplyBefore - (await zyt.totalSupply())).to.equal(tax * 4000n / 10000n);
    expect(await zyt.balanceOf(root.address) - marketBefore).to.equal(tax * 3000n / 10000n);
    expect(await pool.dividendPoolZyt() - divBefore).to.equal(tax * 3000n / 10000n);
    // 发送方（转出方）按当日快照价折算 USDT 等值计入累计提取（静态 2 倍扣除），
    // 基数 = amount + tax（从严口径：转出总量含税，防「转全额+税」漏计）
    const bobUsdtValue = (amount + tax) * price / E18;
    expect((await mining.userInfo(bob.address)).withdrawTotal - bobWithdrawBefore).to.equal(bobUsdtValue);
    // carol 实收全额（税从 bob 另扣）
    expect(await zyt.balanceOf(carol.address)).to.equal(amount);
    // carol 记受赠 + 强卖计时启动
    const [, carolCap] = await mining.transferValueOf(carol.address);
    expect(carolCap).to.equal(amount * price / E18);
    expect((await zyt.getSellInfo(carol.address))[3]).to.be.gt(0n);
  });

  it("6. 静态 2 倍出局：价格上行后卖出累计提取达 2×本金，复投解除", async function () {
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10000000n * E18);
    await depositOf(bob, U500, ethers.ZeroAddress);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);

    // 模拟价格上行（真实场景来自每日通缩）：注入 4 倍池U + sync
    await usdt.transfer(pair, SEED_USDT * 4n);
    const p = await ethers.getContractAt("MiniPair", pair);
    await p.sync();

    // bob 全卖 → usdtOut ≈ 4×面值 ≥ 2×本金 → 静态出局
    const bal = await zyt.balanceOf(bob.address);
    await zyt.connect(bob).approve(await pool.getAddress(), bal);
    await mining.connect(bob).sellZyt(bal);
    const info = await mining.userInfo(bob.address);
    expect(info.staticExited).to.equal(true);
    // 复投解除
    await depositOf(bob, U500, ethers.ZeroAddress);
    const info2 = await mining.userInfo(bob.address);
    expect(info2.staticExited).to.equal(false);
    expect(info2.power).to.be.gt(0n);
  });

  it("7. 动态额度加速释放：逐笔消耗、耗尽停发、复投恢复", async function () {
    // 调小倍率：alice 入金 500 → 动态额度 500U（mul=1）
    await config.setUint("dynamicQuotaMul", 1n);
    await depositOf(alice, U500, root.address); // root 直推链上 alice（不影响 alice 收下级）
    await depositOf(bob, U500, alice.address);  // bob 入金 → alice 收 1 代 7% = 35U，额度剩 465

    expect((await mining.userInfo(alice.address)).dynamicWithdrawn).to.equal(35n * E18);

    // bob 反复入金（每次 alice 应收 35U），直到额度耗尽
    for (let i = 0; i < 15; i++) {
      await depositOf(bob, U500, alice.address);
      const withdrawn = (await mining.userInfo(alice.address)).dynamicWithdrawn;
      if (withdrawn >= 500n * E18) break;
    }
    const aInfo = await mining.userInfo(alice.address);
    expect(aInfo.dynamicWithdrawn).to.equal(500n * E18); // 精确截断至额度上限
    expect(aInfo.dynamicExited).to.equal(true);
    // 耗尽后 bob 再入金：alice 不再收（转营销）
    const aUsdtBefore = await usdt.balanceOf(alice.address);
    await depositOf(bob, U500, alice.address);
    expect(await usdt.balanceOf(alice.address)).to.equal(aUsdtBefore);
    // 复投解除
    await depositOf(alice, U500, root.address);
    const aInfo2 = await mining.userInfo(alice.address);
    expect(aInfo2.dynamicExited).to.equal(false);
    expect(aInfo2.dynamicQuota).to.equal(1000n * E18);
  });

  it("8. 每日通缩：LP 报销 2%、U 回池 sync（池 U 不变）、1% 烧 + 1% 分红", async function () {
    await depositOf(alice, U500, ethers.ZeroAddress);

    const zBefore = await pool.poolZYT();
    const uBefore = await pool.poolUSDT();
    const lpBefore = await creator.lockedLiquidity();
    const supplyBefore = await zyt.totalSupply();
    const priceBefore = await pool.getPrice();

    await deflation.connect(keeper).dailySnapshot(U500);

    expect(await pool.poolUSDT()).to.equal(uBefore); // U 不变（回池 sync）
    expect(await pool.poolZYT()).to.be.lt(zBefore);
    expect(await creator.lockedLiquidity()).to.equal(lpBefore - lpBefore * 200n / 10000n);
    expect(supplyBefore - (await zyt.totalSupply())).to.be.gt(0n);
    expect(await pool.getPrice()).to.be.gt(priceBefore);
    // 分红登记 + 次日结算后领取（v8 语义：结算区间不含当日）
    const day = BigInt(Math.floor(Number(await ts()) / DAY));
    const divAmt = (await mining.dailyInfo(day))[1];
    expect(divAmt).to.be.gt(0n);
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine");
    await deflation.connect(keeper).dailySnapshot(U500); // 次日快照（登记 T+1 日分红）
    const aDivBefore = await zyt.balanceOf(alice.address);
    await mining.connect(alice).claimDividend();
    expect(await zyt.balanceOf(alice.address)).to.be.gt(aDivBefore);
  });

  it("8b：withdrawLp 仅 owner 可调；提取后 lockedLiquidity 与实际余额同步", async function () {
    // 非 owner 被拒
    await expect(
      creator.connect(alice).withdrawLp(alice.address, 1n)
    ).to.be.revertedWithCustomError(creator, "OwnableUnauthorizedAccount");

    // 参数边界
    await expect(creator.withdrawLp(ethers.ZeroAddress, 1n)).to.be.revertedWith("Creator: zero addr");
    await expect(creator.withdrawLp(alice.address, 0n)).to.be.revertedWith("Creator: zero amount");

    const lpBal = await creator.lockedLiquidity();
    await expect(creator.withdrawLp(alice.address, lpBal + 1n)).to.be.revertedWith("Creator: insufficient lp");

    // 正常提取一半：LP 到账、lockedLiquidity 递减、累计量累加
    const half = lpBal / 2n;
    const lp = new ethers.Contract(
      pair,
      ["function balanceOf(address) view returns (uint256)"],
      ethers.provider
    );
    const aLpBefore = await lp.balanceOf(alice.address);
    await expect(creator.withdrawLp(alice.address, half))
      .to.emit(creator, "LpWithdrawn")
      .withArgs(alice.address, half);
    expect(await lp.balanceOf(alice.address)).to.equal(aLpBefore + half);
    expect(await creator.lockedLiquidity()).to.equal(lpBal - half);
    expect(await creator.totalLpWithdrawn()).to.equal(half);
    // 合约实际 LP 余额与记账一致
    expect(await lp.balanceOf(await creator.getAddress())).to.equal(lpBal - half);
  });

  it("8c：提取后通缩可用基数随之减少（skimDeflation 按剩余 LP 计算）", async function () {
    await depositOf(alice, U500, ethers.ZeroAddress);

    const lpBal = await creator.lockedLiquidity();
    const half = lpBal / 2n;
    await creator.withdrawLp(alice.address, half); // 提到只剩一半

    const remaining = await creator.lockedLiquidity();
    expect(remaining).to.equal(lpBal - half);

    const zBefore = await pool.poolZYT();
    await deflation.connect(keeper).dailySnapshot(U500);
    // 报销量 = 剩余 LP × 2%，池内 ZYT 减少
    expect(await creator.lockedLiquidity()).to.equal(remaining - remaining * 200n / 10000n);
    expect(await pool.poolZYT()).to.be.lt(zBefore);
  });

  it("9. 强制卖出：首收币 15 天后未卖足 20% → keeper 结算销毁（窗口去重）", async function () {
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10000000n * E18);
    await depositOf(bob, U500, ethers.ZeroAddress);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);

    const bal = await zyt.balanceOf(bob.address);
    expect(await forceSell.connect(keeper).settleExpired.staticCall(bob.address)).to.equal(0n);
    await ethers.provider.send("evm_increaseTime", [16 * DAY]);
    await ethers.provider.send("evm_mine");
    const supplyBefore = await zyt.totalSupply();
    await forceSell.connect(keeper).settleExpired(bob.address);
    expect(supplyBefore - (await zyt.totalSupply())).to.equal(bal * 2000n / 10000n);
    const supplyMid = await zyt.totalSupply();
    await forceSell.connect(keeper).settleExpired(bob.address);
    expect(await zyt.totalSupply()).to.equal(supplyMid); // P1-13 去重
  });

  it("10. 滑点档位：基准=峰值池U；入金抬峰后卖出可升档", async function () {
    expect(await pool.getCurrentSlippage()).to.equal(500n);
    await depositOf(alice, U500, ethers.ZeroAddress);
    // peak 已抬升至入金后高点；卖出消耗池 U，reduction 达 1% → 10%
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10000000n * E18);
    await depositOf(bob, U500, ethers.ZeroAddress);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);
    const peak = await pool.peakPoolUSDT();
    const cur = await pool.poolUSDT();
    const reduction = (peak - cur) * 10000n / peak;
    const expected = reduction >= 400n ? 8000n : reduction >= 300n ? 4000n
      : reduction >= 200n ? 2000n : reduction >= 100n ? 1000n : 500n;
    expect(await pool.getCurrentSlippage()).to.equal(expected);
  });

  it("11. 算力补偿（v16）：后入金者按 1.01^天数 补偿，全网算力同步基准", async function () {
    // D0：alice 首个入金 → launchDay = D0，算力基数 500
    await depositOf(alice, U500, ethers.ZeroAddress);
    expect(await mining.powerOf(alice.address)).to.equal(U500);
    // 跳 5 天：alice 算力 = 500 × 1.01^5
    await ethers.provider.send("evm_increaseTime", [5 * DAY]);
    await ethers.provider.send("evm_mine");
    const expected = U500 * 101n ** 5n / 100n ** 5n;
    expect(await mining.powerOf(alice.address)).to.equal(expected);
    // D5：bob 入金 → 入金即补偿到 500 × 1.01^5（与 alice 相同）
    await depositOf(bob, U500, ethers.ZeroAddress);
    expect(await mining.powerOf(bob.address)).to.equal(expected);
    // 再跳 3 天：两人算力继续同步（各 = 500 × 1.01^8）
    await ethers.provider.send("evm_increaseTime", [3 * DAY]);
    await ethers.provider.send("evm_mine");
    const expected8 = U500 * 101n ** 8n / 100n ** 5n / 100n ** 3n;
    expect(await mining.powerOf(alice.address)).to.equal(expected8);
    expect(await mining.powerOf(bob.address)).to.equal(expected8);
  });
});
