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
const TOTAL_ZYT = 33_000_000_000n * E18;   // v9.2 全量：21 亿组池 + 12 亿 Treasury
const POOL_ZYT = 2_100_000_000n * E18;     // 注入底池部分（底池 2.1 万 U → 初始价不变）
const SEED_USDT = 21_000n * E18;
const DAY = 86400;
const U500 = 500n * E18;

async function ts() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

/**
 * v9.2 卖币窗口（北京时间 14/28 日全天，UTC+8）：
 * 把链上时钟推进到「下一个卖币日」的 00:00，返回 { ts, id, dom }。
 * 采用相对推进而非固定绝对时刻：Hardhat 链上时钟在用例间单调递增且跨文件保持，
 * 固定锚点会在后续用例中因「时间低于最新区块」被拒，也会随运行当天真实日期漂移。
 */
async function gotoWindow(opts = {}) {
  const want = opts.dom || null;
  const now = await ts();
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

/** 把链上时间锚定到指定时刻 */
async function setTime(t) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [t]);
  await ethers.provider.send("evm_mine", []);
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
    await forceSell.setMining(await mining.getAddress()); // v9.2：窗口复位授权（复投 / 迁移）

    // ---- 建池（v9.2：铸 33 亿，21 亿组池 + 12 亿转 Treasury） ----
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

  it("1. 建池：全量 33 亿铸造（21 亿组池 + 12 亿 Treasury）、LP 锁仓、初始价 0.00001U", async function () {
    expect(await zyt.totalSupply()).to.equal(TOTAL_ZYT);
    expect(await creator.lockedLiquidity()).to.be.gt(0n);
    const [zRes, uRes] = await pool.getReservesPublic();
    expect(zRes).to.equal(POOL_ZYT); // 底池 ZYT 仍为 21 亿
    expect(uRes).to.equal(SEED_USDT);
    expect(await pool.getPrice()).to.equal(SEED_USDT * E18 / POOL_ZYT); // 初始价不变
    // 新增供应 12 亿转入 Treasury（模拟 W3 营销 Safe），且未被登记强卖义务
    expect(await zyt.balanceOf(root.address)).to.equal(TOTAL_ZYT - POOL_ZYT);
    expect(await forceSell.firstReceiveTime(root.address)).to.equal(0n);
    expect(await creator.totalZytSeeded()).to.equal(POOL_ZYT);
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
    await gotoWindow(); // v9.2：卖出仅限 14/28 日历窗
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

    // 卖出首期额度（余额 × 20%，v9.2「不可多卖」上限）：滑点 5%，30/30/40（approve 对象 = PoolManager）
    const sellAmt = bobZyt * 2000n / 10000n;
    const marketBefore = await zyt.balanceOf(root.address);
    const divBefore = await pool.dividendPoolZyt();
    const supplyBefore = await zyt.totalSupply();
    const uBefore = await usdt.balanceOf(bob.address);
    await zyt.connect(bob).approve(await pool.getAddress(), sellAmt);
    await mining.connect(bob).sellZyt(sellAmt);
    const slip = sellAmt * 500n / 10000n;
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

  it("6. 静态 2 倍出局：价格上行后转账折算累计提取达 2×本金，复投解除", async function () {
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

    // v9.2：单期卖出受档位额度（首期 20%）限制，「2 倍出局」经由转账（视同卖出，
    // 不受日历窗约束）达成；另一条路是跨多个卖币窗口逐期卖出。
    const bal = await zyt.balanceOf(bob.address);
    const chunk = bal * 30n / 100n;
    await zyt.connect(bob).transfer(carol.address, chunk);
    expect((await mining.userInfo(bob.address)).staticExited).to.equal(false); // 首笔未到线
    await zyt.connect(bob).transfer(carol.address, chunk);
    const info = await mining.userInfo(bob.address);
    expect(info.staticExited).to.equal(true);
    expect(info.withdrawTotal).to.be.gte(info.depositTotal * 2n);
    // 复投解除
    await depositOf(bob, U500, ethers.ZeroAddress);
    const info2 = await mining.userInfo(bob.address);
    expect(info2.staticExited).to.equal(false);
    expect(info2.power).to.be.gt(0n);
  });

  it("7. 动态额度加速释放：逐笔消耗、耗尽停发、复投恢复", async function () {
    // 调小倍率：alice 入金 500 → 动态额度 500U（mul=1）；一级 7% → 30% 便于在 4 笔内耗尽
    await config.setUint("dynamicQuotaMul", 1n);
    await config.setUint("refLevel1Rate", 3000n);
    await depositOf(alice, U500, root.address); // root 直推链上 alice（不影响 alice 收下级）
    // v9.2 单钱包累计入金上限 500U：额度耗尽需多笔入金 → 用独立钱包（一手机 N 钱包口径）
    const wallets = (await ethers.getSigners()).slice(5, 10);
    await depositOf(wallets[0], U500, alice.address); // 入金 500 → alice 收 30% = 150U，额度剩 350
    expect((await mining.userInfo(alice.address)).dynamicWithdrawn).to.equal(150n * E18);

    for (let i = 1; i < wallets.length; i++) {
      await depositOf(wallets[i], U500, alice.address);
      if ((await mining.userInfo(alice.address)).dynamicWithdrawn >= U500) break;
    }
    const aInfo = await mining.userInfo(alice.address);
    expect(aInfo.dynamicWithdrawn).to.equal(U500); // 精确截断至额度上限
    expect(aInfo.dynamicExited).to.equal(true);
    // 耗尽后新钱包入金：alice 不再收（该份额转营销）
    const aUsdtBefore = await usdt.balanceOf(alice.address);
    await depositOf(wallets[4], U500, alice.address);
    expect(await usdt.balanceOf(alice.address)).to.equal(aUsdtBefore);
    // 复投解除
    await depositOf(alice, U500, root.address);
    const aInfo2 = await mining.userInfo(alice.address);
    // v9.2 复投开新一轮：动态额度按本笔重算（不再累加），出局标记复位
    expect(aInfo2.dynamicExited).to.equal(false);
    expect(aInfo2.dynamicQuota).to.equal(U500);
    expect(aInfo2.dynamicWithdrawn).to.equal(0n);
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
    // v16.1：powerDay = 入金次日（当日入金不领当日池）。alice 入金日 D → 从 D+1 池起算，
    // D+1 当天结算区间为空（from >= toDay），到 D+2 才能领到 D+1 池份额
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine");
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

  it("8d：当日入金不领当日池（v16.1 powerDay=入金次日，堵白嫖套利）", async function () {
    // D 日：alice 快照前入金，快照定格 D 日分红池（分母仅含 alice）
    await depositOf(alice, U500, ethers.ZeroAddress);
    await deflation.connect(keeper).dailySnapshot(U500);
    const dayD = BigInt(Math.floor(Number(await ts()) / DAY));
    expect((await mining.dailyInfo(dayD))[1]).to.be.gt(0n);

    // D 日快照之后 bob 才入金：powerDay = D+1，D 日池子没他的份（修复前：白拿当日池）
    await depositOf(bob, U500, ethers.ZeroAddress);

    // D+1：bob claim → 结算区间为空（from=D+1 >= toDay=D+1），当日池不白拿
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine");
    await deflation.connect(keeper).dailySnapshot(U500); // D+1 快照（登记 D+1 分红）
    const bBefore = await zyt.balanceOf(bob.address);
    await mining.connect(bob).claimDividend();
    expect(await zyt.balanceOf(bob.address)).to.equal(bBefore); // 一分不领

    // D+2：bob 领到 D+1 池份额（次日池正常参与，D+1 快照时 bob 已在账本 → 分母含他）
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine");
    await mining.connect(bob).claimDividend();
    expect(await zyt.balanceOf(bob.address)).to.be.gt(bBefore);
  });

  it("9. 窗口结算：当期无卖出活动 → 按余额 × 首期 20% 销毁（P1-13 去重）", async function () {
    const w = await gotoWindow();
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10000000n * E18);
    await depositOf(bob, U500, ethers.ZeroAddress);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);

    const bal = await zyt.balanceOf(bob.address);
    // 窗口进行中：结算为零操作（昨日非卖币日）
    expect(await forceSell.connect(keeper).settleExpired.staticCall(bob.address)).to.equal(0n);
    // 次日凌晨（15/29 日 00:30 北京）：当期零卖出 → 按余额 × 首期 20% 销毁
    await setTime(w.ts + DAY + 1800);
    const supplyBefore = await zyt.totalSupply();
    await forceSell.connect(keeper).settleExpired(bob.address);
    expect(supplyBefore - (await zyt.totalSupply())).to.equal(bal * 2000n / 10000n);
    const supplyMid = await zyt.totalSupply();
    await forceSell.connect(keeper).settleExpired(bob.address);
    expect(await zyt.totalSupply()).to.equal(supplyMid); // P1-13 去重
  });

  it("10. 滑点档位：基准=当日 08:01 快照池U（非历史峰值），池 U 跌幅分档", async function () {
    expect(await pool.getCurrentSlippage()).to.equal(500n); // 未快照 → 基准滑点
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10000000n * E18);
    await depositOf(bob, U500, ethers.ZeroAddress);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);

    // 快照基准 = 当日 08:01 的池 U
    await deflation.connect(keeper).dailySnapshot(U500);
    const base = await pool.snapshotPoolUSDT();
    expect(base).to.be.gt(0n);
    expect(await pool.getCurrentSlippage()).to.equal(500n); // 池 U ≥ 基准 → 基准档

    // 逐窗口卖出（首期 20%，其后常规 10%）把池 U 压到基准下方 ≥1%
    for (let i = 0; i < 8; i++) {
      const curNow = await pool.poolUSDT();
      if (curNow * 10000n <= base * 9900n) break; // 已跌 ≥1%
      await gotoWindow();
      const bal = await zyt.balanceOf(bob.address);
      if (bal === 0n) break;
      const cap = bal * (i === 0 ? 2000n : 1000n) / 10000n;
      await zyt.connect(bob).approve(await pool.getAddress(), cap);
      await mining.connect(bob).sellZyt(cap);
    }

    const cur = await pool.poolUSDT();
    const reduction = (base - cur) * 10000n / base;
    expect(reduction).to.be.gte(100n); // 跌幅已过 1% 档
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

  it("12. v9.2 卖币窗口：14/28 日历窗 + 首期 20% 额度 + 窗口外禁卖 + 次日结算销毁", async function () {
    const win = await gotoWindow();
    expect(await forceSell.currentWindow()).to.deep.equal([win.id, true]);

    // bob 入金 → 阶段 2 买入取得 ZYT（买币路径只登记首收，不结束首期）
    await depositOf(bob, U500, ethers.ZeroAddress);
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10_000_000n * E18);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);
    const bal = await zyt.balanceOf(bob.address);
    expect(bal).to.be.gt(0n);
    expect(await forceSell.firstSellDone(bob.address)).to.equal(false); // 首期

    // 首期额度 = 窗口首次活动时余额 × 20%；超出即「不可多卖」
    const quota = bal * 2000n / 10000n;
    await zyt.connect(bob).approve(await pool.getAddress(), bal);
    await expect(mining.connect(bob).sellZyt(bal * 21n / 100n))
      .to.be.revertedWith("FS: over quota");

    // 额度内卖出成功：额度锁存 + 已卖累计 + 首期结束
    await mining.connect(bob).sellZyt(quota / 2n);
    const w = await forceSell.windows(bob.address);
    expect(w[0]).to.equal(win.id);
    expect(w[1]).to.equal(quota);
    expect(w[2]).to.equal(quota / 2n);
    expect(await forceSell.firstSellDone(bob.address)).to.equal(true);

    // 窗口外（15/29 日）禁卖
    await setTime(win.ts + DAY + 1800);
    expect(await forceSell.pendingSettleWindow()).to.equal(win.id);
    await expect(mining.connect(bob).sellZyt(1n * E18)).to.be.revertedWith("FS: window closed");

    // 次日凌晨 keeper 结算：未卖足额度部分销毁（无宽限期）
    const supplyBefore = await zyt.totalSupply();
    const balBefore = await zyt.balanceOf(bob.address);
    await forceSell.connect(keeper).settleExpired(bob.address);
    const burned = supplyBefore - (await zyt.totalSupply());
    expect(burned).to.equal(quota - quota / 2n);
    expect(await zyt.balanceOf(bob.address)).to.equal(balBefore - burned);

    // P1-13：同一窗口重复结算为零操作
    const supplyMid = await zyt.totalSupply();
    await forceSell.connect(keeper).settleExpired(bob.address);
    expect(await zyt.totalSupply()).to.equal(supplyMid);
  });

  it("13. v9.2 治理补池 injectZyt：权限闭合 + 单次 5% 上限 + 只加 ZYT 侧不动池 U", async function () {
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10_000_000n * E18);
    await depositOf(bob, U500, ethers.ZeroAddress);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);

    // treasury = root（模拟 W3 营销 Safe：已白名单，转入无税；Safe 不直接转 pair，走本合约拉币）
    const seed = await zyt.balanceOf(bob.address);
    await zyt.connect(bob).transfer(root.address, seed);
    await pool.setTreasury(root.address);
    expect(await pool.treasury()).to.equal(root.address);

    const zytResBefore = await pool.poolZYT();
    const usdtResBefore = await pool.poolUSDT();
    const cap = zytResBefore * 500n / 10000n; // 单次上限 = 池内 ZYT 的 5%
    const amount = seed / 2n;
    expect(amount).to.be.lte(cap); // 正常额度内

    // 越权：既非 owner 也非 treasury
    await expect(pool.connect(alice).injectZyt(1n)).to.be.revertedWith("Pool: not auth");
    // 超单次上限（上限校验先于拉币，余额不足也能命中）
    await zyt.connect(root).approve(await pool.getAddress(), seed);
    await expect(pool.connect(root).injectZyt(cap + 1n)).to.be.revertedWith("Pool: over inject cap");
    // 未 approve → 拉币失败
    await zyt.connect(root).approve(await pool.getAddress(), 0n);
    await expect(pool.connect(root).injectZyt(1n)).to.be.reverted;

    // 正常注入：只加厚 ZYT 侧，池 U 不变；累计留痕
    const rootBefore = await zyt.balanceOf(root.address); // 含建池时转入的 12 亿 Treasury
    await zyt.connect(root).approve(await pool.getAddress(), seed);
    await pool.connect(root).injectZyt(amount);
    expect(await pool.poolZYT()).to.equal(zytResBefore + amount);
    expect(await pool.poolUSDT()).to.equal(usdtResBefore);
    expect(await pool.totalZytInjected()).to.equal(amount);
    expect(await zyt.balanceOf(root.address)).to.equal(rootBefore - amount);
  });

  it("14. v9.2 迁移接口：setUserData 批量回填（含分红游标）+ launchDay 继承 + 窗口重置首期", async function () {
    const empty = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, false, false];
    // 权限闭合
    await expect(mining.connect(alice).setUserData([alice.address], [empty]))
      .to.be.revertedWith("Mining: not owner");
    await expect(mining.connect(alice).setLaunchDay(1n)).to.be.revertedWith("Mining: not owner");
    // 入参校验
    await expect(mining.setUserData([alice.address], [])).to.be.revertedWith("Mining: length mismatch");
    await expect(mining.setUserData([ethers.ZeroAddress], [empty])).to.be.revertedWith("Mining: zero user");

    // 构造真实存量状态：bob 入金 + 买币 + 完成首卖（首期结束、有分红游标）
    await gotoWindow();
    await depositOf(bob, U500, ethers.ZeroAddress);
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10_000_000n * E18);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);
    const bal = await zyt.balanceOf(bob.address);
    await zyt.connect(bob).approve(await pool.getAddress(), bal);
    await mining.connect(bob).sellZyt(bal * 2000n / 10000n);
    expect(await forceSell.firstSellDone(bob.address)).to.equal(true);

    const u = await mining.users(bob.address);
    const cursor = (await mining.dividendOf(bob.address))[1];
    // migrate.mjs 的元组顺序：11 个 uint（跳过 isExited）+ dividendClaimedDay + 2 bool
    const tuple = [u[0], u[1], u[2], u[3], u[4], u[6], u[7], u[8], u[9], u[10], u[11], cursor, u[5], u[12]];
    await mining.setUserData([bob.address], [tuple]);

    // 逐字段等价（含分红游标）
    const after = await mining.users(bob.address);
    for (const i of [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11]) expect(after[i]).to.equal(u[i]);
    expect(after[5]).to.equal(u[5]);
    expect(after[12]).to.equal(u[12]);
    expect((await mining.dividendOf(bob.address))[1]).to.equal(cursor);

    // 拍板第 4 项：老用户卖出窗口迁移日重置为首期 20%
    expect(await forceSell.firstSellDone(bob.address)).to.equal(false);
    expect((await forceSell.windows(bob.address))[0]).to.equal(0n);

    // launchDay 继承（红线第 4 条；须能写入任意旧值，且拒绝 0）
    const oldDay = await mining.launchDay();
    await mining.setLaunchDay(oldDay - 3n);
    expect(await mining.launchDay()).to.equal(oldDay - 3n);
    await expect(mining.setLaunchDay(0n)).to.be.revertedWith("Mining: zero day");
  });

  it("15. v9.2 档位临界：累计卖出达入金 60% 后下一窗口降为 2%", async function () {
    await gotoWindow();
    await config.setUint("poolStage1USDT", 21000n * E18);
    await config.setUint("poolStage2USDT", 10_000_000n * E18);
    await depositOf(bob, U500, ethers.ZeroAddress);
    await usdt.connect(bob).faucet(U500);
    await usdt.connect(bob).approve(await mining.getAddress(), U500);
    await mining.connect(bob).buy(U500);
    expect(await forceSell.tierBpsOf(bob.address)).to.equal(2000n); // 首期 20%

    // 用转账（视同卖出，不受窗口额度阻断）把 withdrawTotal 推过 60% × 500U = 300U，
    // 同时刻意停在 2 倍出局线（1000U）之下：否则会触发静态出局禁卖，测不到 2% 档
    await usdt.transfer(pair, SEED_USDT * 4n); // 抬价，使转账折算额足够大
    await (await ethers.getContractAt("MiniPair", pair)).sync();
    const bal = await zyt.balanceOf(bob.address);
    await zyt.connect(bob).transfer(carol.address, bal * 30n / 100n);
    const info = await mining.userInfo(bob.address);
    expect(info.withdrawTotal).to.be.gte(info.depositTotal * 6000n / 10000n); // ≥ 60%
    expect(info.staticExited).to.equal(false); // 未触 2 倍线，仍可卖

    // 首个窗口由此结束（转账已置位首期）→ 下一窗口档位降为 2%
    await gotoWindow();
    expect(await forceSell.tierBpsOf(bob.address)).to.equal(200n);
    const bal2 = await zyt.balanceOf(bob.address);
    await zyt.connect(bob).approve(await pool.getAddress(), bal2);
    await expect(mining.connect(bob).sellZyt(bal2 * 200n / 10000n + 1n))
      .to.be.revertedWith("FS: over quota");
    await mining.connect(bob).sellZyt(bal2 * 200n / 10000n);
  });

  it("16. v9.2 双轨禁卖：动态出局同样禁止卖出（复投解除）", async function () {
    await config.setUint("dynamicQuotaMul", 1n);
    await config.setUint("refLevel1Rate", 3000n);
    await depositOf(alice, U500, root.address); // alice 动态额度 500U
    const wallets = (await ethers.getSigners()).slice(5, 10);
    for (let i = 0; i < wallets.length; i++) {
      await depositOf(wallets[i], U500, alice.address); // 每笔消耗 150U 额度
      if ((await mining.userInfo(alice.address)).dynamicExited) break;
    }
    expect((await mining.userInfo(alice.address)).dynamicExited).to.equal(true);

    await gotoWindow();
    // 动态出局 → 禁卖（守卫先于窗口/额度校验，故窗口日亦恒定 revert）
    await expect(mining.connect(alice).sellZyt(1n * E18)).to.be.revertedWith("Mining: dynamic exited");

    // 复投开新一轮 → 解除
    await depositOf(alice, U500, root.address);
    expect((await mining.userInfo(alice.address)).dynamicExited).to.equal(false);
    await expect(mining.connect(alice).sellZyt(1n * E18)).to.not.be.revertedWith("Mining: dynamic exited");
  });
});
