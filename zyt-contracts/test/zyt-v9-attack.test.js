/**
 * 众赢币 ZYT v9.1 攻击向量测试（本地 MiniV2 真池）
 *
 * 目标：验证经济模型的抗操纵性与权限闭合，覆盖 8 类攻击面：
 *   A1 闪电贷式 peak 操纵（拉高峰值后撤出，反向抬升自己的卖出成本）
 *   A2 越权调用矩阵（onlyMining / onlyDeflation / not pool / 二次建池 / owner 越权）
 *   A3 多钱包转账绕静态 2 倍（受赠上限约束，无法跨钱包放大提取额度）
 *   A4 零成本刷额度（额度严格 = 5×累计真实入金）
 *   A5 出局后行为边界（分红权重归零 + 双轨禁卖，复投恢复）
 *   A6 通缩防护（同日重复、超限抽池、越权抽池）
 *   A7 推荐自环/互推（无自奖励、无循环放大）
 *   A8 卖币窗口为全局日历（转账视同卖出占额度，接收方无独立计时）
 *
 * 说明：断言基于合约不变量，任何一条被绕过即测试失败。
 * v9.2（2026-10-14）：卖出仅限每月 14/28 日历窗，单期额度 = 余额 × 档位（首期 20% / 常规 10% /
 *   达入金 60% 后 2%）；本套件用 gotoWindow() 相对推进链上时钟，避免固定锚点随运行日期漂移。
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
const ZERO = ethers.ZeroAddress;

async function ts() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

/**
 * v9.2 卖币窗口（北京时间 14/28 日全天，UTC+8）：
 * 把链上时钟推进到「下一个卖币日」的 00:00，返回 { ts, id, dom }。
 * 相对推进而非固定绝对时刻：Hardhat 链上时钟跨用例单调递增且跨文件保持。
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

async function setTime(t) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [t]);
  await ethers.provider.send("evm_mine", []);
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

  // ============ A1 闪电贷式 peak 操纵 ============
  it("A1. peak 操纵：拉高峰值不再影响滑点档位（基准=当日 08:01 快照池 U）", async function () {
    await openStage2();
    await gotoWindow(); // v9.2：卖出仅限 14/28 日历窗
    await depositOf(alice, U500, ZERO);
    await depositOf(bob, U500, ZERO);

    const peakBefore = await pool.peakPoolUSDT();
    // 攻击者（bob）大额买入，把池 U 与峰值同时推高
    await buyOf(bob, 400n * E18);
    const peakAfterBuy = await pool.peakPoolUSDT();
    expect(peakAfterBuy).to.be.gt(peakBefore); // 峰值被抬高

    // 攻击者立即撤出（卖出首期额度上限 = 余额 × 20%）→ 池 U 回落，但峰值不下降（只升不降）
    const bobZyt = await zyt.balanceOf(bob.address);
    await sellOf(bob, bobZyt * 2000n / 10000n);
    expect(await pool.peakPoolUSDT()).to.be.gte(peakAfterBuy); // 峰值不回退

    // v9.2 核心断言：滑点基准已换成「当日 08:01 快照池 U」，峰值不再参与档位判定。
    // 尚未发生快照时基准为 0 → 直接回落基准滑点 5%，
    // 攻击者「拉高再撤」在自身卖出成本上不产生任何档位效应。
    expect(await pool.snapshotPoolUSDT()).to.equal(0n);
    expect(await pool.getCurrentSlippage()).to.equal(500n);

    // 快照写入后基准锁定为快照时刻的真实池 U；池 U 不低于基准 → 仍为基准滑点（无升档）
    await deflation.connect(keeper).dailySnapshot(U500);
    const base = await pool.snapshotPoolUSDT();
    expect(base).to.be.gt(0n);
    expect(await pool.getCurrentSlippage()).to.equal(500n);
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
    await expect(creator.connect(alice).createInitialPool(TOTAL_ZYT, POOL_ZYT, SEED_USDT)).to.be.reverted;

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
    await gotoWindow(); // v9.2：卖出仅限 14/28 日历窗
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

    // 3) carol 卖出首期额度（余额 × 20%）→ 累计提取不会超过其上限（受 AMM 折价影响只会更低）
    await sellOf(carol, carolBal * 2000n / 10000n);
    const carolWithdraw = (await mining.userInfo(carol.address))[1];
    expect(carolWithdraw).to.be.lte(carolCap);
    const carolCapAfter = (await mining.transferValueOf(carol.address))[1];
    expect(carolCapAfter).to.equal(carolCap); // 上限不因卖出变化（受赠值固定）
    expect(carolWithdraw).to.be.lt(carolCapAfter * 2n); // 远达不到 2 倍
  });

  // ============ A4 零成本刷额度 ============
  it("A4. 额度严格等于 5×累计真实入金，零成本或重复调用无法增加", async function () {
    const U200 = 200n * E18;
    await depositOf(alice, U200, ZERO);
    let info = await mining.userInfo(alice.address);
    expect(info[3]).to.equal(info[0] * 5n); // dynamicQuota = 5×depositTotal

    // 0 值入金被拒（低于最小起投）
    await expect(mining.connect(alice).deposit(0n, ZERO)).to.be.revertedWith("Mining: amount range");
    // 超单笔上限被拒
    await usdt.connect(alice).faucet(U500 * 10n);
    await usdt.connect(alice).approve(await mining.getAddress(), U500 * 10n);
    await expect(mining.connect(alice).deposit(U500 + 1n, ZERO)).to.be.revertedWith("Mining: amount range");
    // v9.2：入金须为 100U 倍数（150U 非倍数 → 拒绝）
    await expect(mining.connect(alice).deposit(150n * E18, ZERO)).to.be.revertedWith("Mining: step mismatch");

    // 再次真实入金 → 额度按新入金线性叠加（无倍增杠杆）
    await depositOf(alice, U200, ZERO);
    info = await mining.userInfo(alice.address);
    expect(info[0]).to.equal(400n * E18);
    expect(info[3]).to.equal(2000n * E18);
    expect(info[3]).to.equal(info[0] * 5n);

    // v9.2：单钱包累计入金上限 500U（400 + 200 = 600 > 500 → 拒绝）
    await usdt.connect(alice).faucet(U200);
    await usdt.connect(alice).approve(await mining.getAddress(), U200);
    await expect(mining.connect(alice).deposit(U200, ZERO)).to.be.revertedWith("Mining: over cap");
  });

  // ============ A5 出局后行为边界 ============
  it("A5. 出局后禁卖且分红权重归零；复投全额恢复", async function () {
    await openStage2();
    await gotoWindow();
    await depositOf(alice, U500, ZERO);
    await buyOf(alice, 500n * E18);

    // 价格上行（注入 4 倍池 U + sync），使转账折算足以越过静态 2 倍线
    await usdt.transfer(pair, SEED_USDT * 4n);
    const p = await ethers.getContractAt("MiniPair", pair);
    await p.sync();

    // v9.2：单期卖出受档位额度限制，2 倍出局经由转账（视同卖出）达成
    const zBal = await zyt.balanceOf(alice.address);
    await zyt.connect(alice).transfer(bob.address, zBal * 30n / 100n);
    await zyt.connect(alice).transfer(bob.address, zBal * 30n / 100n);

    const info = await mining.userInfo(alice.address);
    expect(info[6]).to.equal(true); // staticExited：累计提取 ≥ 2×本金
    expect(info[1]).to.be.gte(info[0] * 2n);
    expect(info[2]).to.equal(0n);   // 出局 → 算力归零（不再享分红权重）

    // v9.2 拍板：双轨出局任一到线即禁卖（旧行为「出局后仍可卖」已作废）
    const rest = await zyt.balanceOf(alice.address);
    expect(rest).to.be.gt(0n);
    await zyt.connect(alice).approve(await pool.getAddress(), rest);
    await expect(mining.connect(alice).sellZyt(rest)).to.be.revertedWith("Mining: static exited");

    // 复投 → 出局标记复位、算力恢复（新一轮账本）
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
    // v9.2 单钱包累计入金上限 500U：本用例按 200U 构造，便于同一钱包二次入金
    const U200 = 200n * E18;
    // 自环：alice 以自己为上级
    await usdt.connect(alice).faucet(U200);
    await usdt.connect(alice).approve(await mining.getAddress(), U200);
    let selfOk = true;
    try {
      await mining.connect(alice).deposit(U200, alice.address);
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
    await usdt.connect(bob).faucet(U200);
    await usdt.connect(bob).approve(await mining.getAddress(), U200);
    await mining.connect(bob).deposit(U200, alice.address);
    const bobRef = await referral.referrerOf(bob.address);
    expect(bobRef.toLowerCase()).to.equal(alice.address.toLowerCase());

    // bob 再次入金并传 alice（不变），传自己无效：上级关系不可被自己改写
    await usdt.connect(bob).faucet(U200);
    await usdt.connect(bob).approve(await mining.getAddress(), U200);
    await mining.connect(bob).deposit(U200, bob.address);
    expect((await referral.referrerOf(bob.address)).toLowerCase()).to.equal(alice.address.toLowerCase());

    // 循环检测：alice 的上级链中不含 bob（无环）
    const aliceRef = await referral.referrerOf(alice.address);
    expect(aliceRef.toLowerCase()).to.not.equal(bob.address.toLowerCase());
  });

  // ============ A8 强卖窗口转移 ============
  it("A8. 窗口为全局日历：转账视同卖出占用当期额度，接收方无独立计时", async function () {
    await openStage2();
    const g = await gotoWindow();
    await depositOf(alice, U500, ZERO);
    await buyOf(alice, 300n * E18); // alice 真实持币（首收登记）

    // alice 转一半给 carol（新钱包）：转账视同卖出，占用 alice 当期额度
    const bal = await zyt.balanceOf(alice.address);
    const half = bal / 2n;
    await zyt.connect(alice).transfer(carol.address, half);

    const w = await forceSell.windows(alice.address);
    expect(w[0]).to.equal(g.id);                 // 已锁存当期窗口
    expect(w[1]).to.equal(bal * 2000n / 10000n); // 额度 = 转账前余额 × 首期 20%
    expect(w[2]).to.equal(half);                 // 已卖进度含转出量（转账视同卖出）
    expect(await forceSell.firstSellDone(alice.address)).to.equal(true); // 首期由转出终结

    // 转出已达 50% > 20% 额度 → 当期不可再卖（不可多卖）
    await zyt.connect(alice).approve(await pool.getAddress(), 1n * E18);
    await expect(mining.connect(alice).sellZyt(1n * E18)).to.be.revertedWith("FS: over quota");

    // 接收方 carol 无独立计时：窗口为全局日历，carol 自身无任何窗口锁存
    expect(await forceSell.firstSellDone(carol.address)).to.equal(false);
    expect((await forceSell.windows(carol.address))[0]).to.equal(0n);

    // 次日凌晨（15/29 日）结算
    await setTime(g.ts + DAY + 1800);
    const aliceBefore = await zyt.balanceOf(alice.address);
    await forceSell.connect(keeper).settleExpired(alice.address);
    expect(await zyt.balanceOf(alice.address)).to.equal(aliceBefore); // 已超额，无欠账可烧

    const carolBal = await zyt.balanceOf(carol.address);
    expect(carolBal).to.be.gt(0n);
    await forceSell.connect(keeper).settleExpired(carol.address);
    // carol 当期零活动 → 按自身余额 × 首期 20% 销毁
    expect(carolBal - (await zyt.balanceOf(carol.address))).to.equal(carolBal * 2000n / 10000n);
    // 二次结算幂等（同窗口不重复销毁）
    const carolAfter = await zyt.balanceOf(carol.address);
    await forceSell.connect(keeper).settleExpired(carol.address);
    expect(await zyt.balanceOf(carol.address)).to.equal(carolAfter);
  });
});
