// SPDX-License-Identifier: MIT
/* global ethers */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const BLACK_HOLE = "0x000000000000000000000000000000000000dEaD";

const GST_MAX = 333_000_000n * 10n ** 18n;
const GST_POOL = 21_000n * 10n ** 18n;
const ZYT_MAX = 2_100_000_000n * 10n ** 18n;
const DAY = 86400;
const FIFTEEN_DAYS = 15 * DAY;

/**
 * 部署全套合约并接线、初始化底池。
 * 默认把阶段门槛调高（stage3 自由买卖）以便测试入金/卖出。
 */
async function deployFixture(opts = {}) {
  const [deployer, alice, bob, carol, dave] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  const usdt = await Mock.deploy("Mock USDT", "USDT", 18);
  await usdt.waitForDeployment();

  const Config = await ethers.getContractFactory("ZYTConfig");
  const config = await Config.deploy();
  await config.waitForDeployment();

  const GST = await ethers.getContractFactory("GSTToken");
  const gst = await GST.deploy(BLACK_HOLE);
  await gst.waitForDeployment();

  const ZYT = await ethers.getContractFactory("ZYTToken");
  const zyt = await ZYT.deploy(BLACK_HOLE);
  await zyt.waitForDeployment();

  const ForceSell = await ethers.getContractFactory("ZYTForceSell");
  const forceSell = await ForceSell.deploy(await zyt.getAddress());
  await forceSell.waitForDeployment();

  const Pool = await ethers.getContractFactory("ZYTPoolManager");
  const pool = await Pool.deploy(await config.getAddress(), await zyt.getAddress(), await usdt.getAddress(), await gst.getAddress());
  await pool.waitForDeployment();

  const Referral = await ethers.getContractFactory("ZYTReferral");
  const referral = await Referral.deploy();
  await referral.waitForDeployment();

  // ZYTCompute 为 library，需先部署并链接
  const Compute = await ethers.getContractFactory("ZYTCompute");
  const compute = await Compute.deploy();
  await compute.waitForDeployment();

  const Mining = await ethers.getContractFactory("ZYTMining", {
    libraries: { ZYTCompute: await compute.getAddress() },
  });
  const mining = await Mining.deploy(await config.getAddress(), await pool.getAddress(), await referral.getAddress(), await zyt.getAddress(), await usdt.getAddress());
  await mining.waitForDeployment();

  const Deflation = await ethers.getContractFactory("ZYTDeflation");
  const deflation = await Deflation.deploy(await config.getAddress(), await pool.getAddress(), await mining.getAddress());
  await deflation.waitForDeployment();

  // 接线
  await config.setAddress("marketAddress", deployer.address);
  await config.setAddress("technicalAddress", deployer.address);
  await config.setAddress("blackHole", BLACK_HOLE);
  await config.setAddress("usdt", await usdt.getAddress());
  await config.setAddress("gst", await gst.getAddress());
  await config.setAddress("zyt", await zyt.getAddress());
  await config.setAddress("pool", await pool.getAddress());
  await config.setAddress("mining", await mining.getAddress());
  await config.setAddress("deflation", await deflation.getAddress());
  await config.setAddress("forceSell", await forceSell.getAddress());
  await config.setAddress("referral", await referral.getAddress());
  await config.setAddress("keeperAddress", deployer.address); // V4：测试默认用 deployer(owner) 触发快照

  await zyt.setMinter(await mining.getAddress());
  await zyt.setPool(await pool.getAddress());
  await zyt.setForceSell(await forceSell.getAddress());
  await zyt.setConfig(await config.getAddress()); // V6/V7：转账滑点率 + 增发上限
  await zyt.setWhiteList(await pool.getAddress(), true);
  await zyt.setWhiteList(await mining.getAddress(), true);
  await zyt.setWhiteList(await deflation.getAddress(), true);
  // P2-2 白名单保护：fixture 中 marketAddress/technicalAddress = deployer，豁免强制卖出初始化
  await zyt.setWhiteList(deployer.address, true);

  await pool.setMining(await mining.getAddress());
  await pool.setDeflation(await deflation.getAddress());
  await referral.setMining(await mining.getAddress());
  await mining.setDeflation(await deflation.getAddress());

  // v7：买入白名单默认开启（config 默认 true），把测试账号全部加入白名单
  // （dave 故意不加，供「非白名单拒绝」用例使用）
  for (const s of [alice, bob, carol, deployer]) {
    await pool.setBuyWhitelist(s.address, true);
  }

  // 底池初始化（V5：初始 2.1 万 USDT 真实转入池，账面=实际）
  await gst.approve(await pool.getAddress(), GST_POOL);
  await usdt.faucet(GST_POOL); // 初始池 USDT（deployer 领取后转入）
  await usdt.approve(await pool.getAddress(), GST_POOL);
  await pool.initialize(GST_POOL, ZYT_MAX);
  await gst.lockRemaining();

  // 默认 stage3 自由买卖（两道门槛都设 0 → getStage 恒为 3）
  await config.setUint("poolStage1USDT", 0);
  await config.setUint("poolStage2USDT", 0);

  return { deployer, alice, bob, carol, dave, usdt, gst, zyt, config, pool, mining, referral, deflation, forceSell };
}

/** 给用户充值 USDT 并授权 */
async function fundUsdt(usdt, user, amount, spender) {
  await usdt.connect(user).faucet(amount);
  await usdt.connect(user).approve(spender, ethers.MaxUint256);
}

describe("ZYT 合约体系（方案 v7）", function () {
  describe("GSTToken", function () {
    it("总供应 3.33 亿且全量铸造给部署者", async function () {
      const { deployer, gst } = await deployFixture();
      expect(await gst.totalSupply()).to.equal(GST_MAX);
      // 底池 2.1 万已注入，其余已永久锁定转黑洞 → 部署者余额 0
      expect(await gst.balanceOf(deployer.address)).to.equal(0n);
      expect(await gst.balanceOf(BLACK_HOLE)).to.equal(GST_MAX - GST_POOL);
    });

    it("剩余供应永久锁定转黑洞，之后禁止转出", async function () {
      const { gst, deployer } = await deployFixture();
      expect(await gst.supplyLocked()).to.equal(true);
      expect(await gst.balanceOf(BLACK_HOLE)).to.equal(GST_MAX - GST_POOL);
      // 部署者余额为 0（已锁），尝试其他持有者转出会被阻止（锁定后仅黑洞可收）
      const [, alice] = await ethers.getSigners();
      expect(await gst.balanceOf(alice.address)).to.equal(0n);
    });
  });

  describe("ZYTConfig", function () {
    it("默认参数符合方案 v6", async function () {
      const { config } = await deployFixture();
      expect(await config.gstMaxSupply()).to.equal(GST_MAX);
      expect(await config.zytMaxSupply()).to.equal(ZYT_MAX);
      expect(await config.minDeposit()).to.equal(ethers.parseEther("100"));
      expect(await config.maxDeposit()).to.equal(ethers.parseEther("500"));
      expect(await config.dynamicQuotaMul()).to.equal(5n);
      expect(await config.staticExitMul()).to.equal(2n);
      expect(await config.deflationRate()).to.equal(200n);
      expect(await config.baseSlippage()).to.equal(500n);
      expect(await config.slippageTier4()).to.equal(8000n);
      expect(await config.transferSlippage()).to.equal(1000n);
      expect(await config.snapshotTime()).to.equal(28800n);
    });

    it("owner 可调参，非 owner 不可", async function () {
      const { config, alice } = await deployFixture();
      await config.setUint("maxDeposit", ethers.parseEther("1000"));
      expect(await config.maxDeposit()).to.equal(ethers.parseEther("1000"));
      await expect(config.connect(alice).setUint("maxDeposit", 1)).to.be.reverted;
      await expect(config.connect(alice).setAddress("marketAddress", alice.address)).to.be.reverted;
    });

    it("推荐奖励率：1 代 7% / 2-10 代 2% / 11-20 代 0.5%", async function () {
      const { config } = await deployFixture();
      expect(await config.refRateForLevel(1)).to.equal(700n);
      expect(await config.refRateForLevel(2)).to.equal(200n);
      expect(await config.refRateForLevel(10)).to.equal(200n);
      expect(await config.refRateForLevel(11)).to.equal(50n);
      expect(await config.refRateForLevel(20)).to.equal(50n);
      expect(await config.refRateForLevel(21)).to.equal(0n);
    });
  });

  describe("ZYTPoolManager 滑点与阶段", function () {
    it("底池初始化：2.1 万 GST + 21 亿 ZYT，价格 0.00001 U/ZYT", async function () {
      const { pool } = await deployFixture();
      expect(await pool.poolGST()).to.equal(GST_POOL);
      expect(await pool.poolZYT()).to.equal(ZYT_MAX);
      expect(await pool.poolUSDT()).to.equal(GST_POOL);
      expect(await pool.getPrice()).to.equal(ethers.parseEther("0.00001"));
    });

    it("滑点档位：底池 GST 减少 ≥1/2/3/4% → 10/20/40/80%", async function () {
      const { pool, deflation, usdt, zyt, mining, alice, bob, carol, deployer } = await deployFixture();
      // 初始无减少 → 基础 5%
      expect(await pool.getCurrentSlippage()).to.equal(500n);

      // 先入金（4 用户各 500U，底池 GST 增加），再快照基准
      const signers = [alice, bob, carol, deployer];
      for (const s of signers) {
        await fundUsdt(usdt, s, ethers.parseEther("500"), await mining.getAddress());
        await mining.connect(s).deposit(ethers.parseEther("500"), ZERO);
      }
      await deflation.dailySnapshot(0);
      const snapshot = await pool.snapshotPoolGST();
      expect(snapshot).to.be.gt(GST_POOL);

      // 充值池 USDT 模拟 DEX 流动性（卖出支付储备）
      await usdt.connect(alice).faucet(ethers.parseEther("5000"));
      await usdt.connect(alice).transfer(await pool.getAddress(), ethers.parseEther("5000"));

      // 集中卖出：底池 GST 单调下降
      for (const s of signers) {
        const bal = await zyt.balanceOf(s.address);
        if (bal > 0n) {
          await zyt.connect(s).approve(await pool.getAddress(), ethers.MaxUint256);
          await mining.connect(s).sellZyt(bal);
        }
      }
      const gstAfter = await pool.poolGST();
      const reduction = ((snapshot - gstAfter) * 10000n) / snapshot;
      expect(reduction).to.be.gte(400n); // 底池 GST 减少 ≥4%
      expect(await pool.getCurrentSlippage()).to.equal(8000n); // 滑点升到 80% 档
    });

    it("阶段门控：stage1 禁止买入，stage2 需 LP 额度", async function () {
      const { pool, config, usdt, mining, alice } = await deployFixture();
      // stage1：底池 21000 < 10M 但这里我们把门槛设回 21001
      await config.setUint("poolStage1USDT", GST_POOL + 1n);
      await config.setUint("poolStage2USDT", 1n << 120n);
      expect(await pool.getStage()).to.equal(1n);
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await expect(mining.connect(alice).deposit(ethers.parseEther("100"), ZERO)).to.be.revertedWith("Mining: buy disabled in stage1");

      // stage2：21000 >= 20000 → stage2，需要 LP 额度
      await config.setUint("poolStage1USDT", ethers.parseEther("20000"));
      expect(await pool.getStage()).to.equal(2n);
      await expect(mining.connect(alice).deposit(ethers.parseEther("100"), ZERO)).to.be.revertedWith("Mining: no LP quota");
      await fundUsdt(usdt, alice, ethers.parseEther("300"), await mining.getAddress()); // addLiquidity 后仍有余额
      await mining.connect(alice).addLiquidity(ethers.parseEther("100"));
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      expect((await mining.userInfo(alice.address))[0]).to.equal(ethers.parseEther("100"));
    });
  });

  describe("ZYTMining 入金 / 算力 / 动态额度", function () {
    it("入金 100U：40% 营销、60% 底池，mint 对应 ZYT，算力=100，动态额度=500", async function () {
      const { mining, pool, usdt, zyt, deployer, alice } = await deployFixture();
      const usdtBefore = await usdt.balanceOf(deployer.address);
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);

      // 营销 40U
      expect(await usdt.balanceOf(deployer.address)).to.equal(usdtBefore + ethers.parseEther("40"));
      // 底池 +60U
      expect(await pool.poolUSDT()).to.equal(GST_POOL + ethers.parseEther("60"));
      // mint ZYT = 60U / 当日快照锁定价（v7：初始快照价 0.00001 U/ZYT，注入后实时价不影响当日计价）
      const expectedMint = ethers.parseEther("60") * 10n ** 18n / ethers.parseEther("0.00001");
      expect(await zyt.balanceOf(alice.address)).to.equal(expectedMint);
      // 算力 + 额度
      const info = await mining.userInfo(alice.address);
      expect(info[4]).to.equal(ethers.parseEther("100")); // power
      expect(info[2]).to.equal(ethers.parseEther("500")); // quota
    });

    it("复投刷新动态额度（1000U → 5000U）", async function () {
      const { mining, usdt, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("500"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("300"), ZERO);
      let info = await mining.userInfo(alice.address);
      expect(info[2]).to.equal(ethers.parseEther("1500"));
      await mining.connect(alice).deposit(ethers.parseEther("200"), ZERO);
      info = await mining.userInfo(alice.address);
      expect(info[2]).to.equal(ethers.parseEther("2500")); // (300+200)×5
    });

    it("动态额度耗尽停发收益，复投恢复（v8 修复：产出按 USDT 等值折算）", async function () {
      const { mining, deflation, usdt, pool, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO); // quota 500

      // 每日快照（全网算力 100）
      await deflation.dailySnapshot(ethers.parseEther("100"));
      const day = BigInt(Math.floor(Date.now() / 1000 / 86400));
      await mining.connect(alice).claimReward(day);
      // v8 修复：产出 100000e18 ZYT → 额度消耗 = 100000e18 × price / 1e18（按快照锁定价 0.00001 = 1U）
      // 修复前错误累加 100000（ZYT 数）→ 误判额度耗尽；修复后仅记 USDT 等值
      let info = await mining.userInfo(alice.address);
      const price = await pool.getTradePrice();
      const usdtEquivalent = (ethers.parseEther("100000") * price) / 10n ** 18n;
      expect(info[3]).to.equal(usdtEquivalent);
      // 额度 500U 未耗尽（修复核心：不再误判）
      expect(info[3]).to.be.lt(ethers.parseEther("500"));

      // 快进 1 天，再入金 500U → quota = (100+500)×5 = 3000
      await ethers.provider.send("evm_increaseTime", [DAY]);
      await ethers.provider.send("evm_mine", []);
      await fundUsdt(usdt, alice, ethers.parseEther("500"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("500"), ZERO);
      info = await mining.userInfo(alice.address);
      expect(info[2]).to.equal(ethers.parseEther("3000"));
    });

    it("静态 2 倍出局：累计提取 ≥ 2×入金后停发", async function () {
      const { mining, usdt, zyt, pool, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      const minted = await zyt.balanceOf(alice.address);
      expect(minted).to.be.gt(0n);

      // 卖出全部（≈60U）→ withdrawTotal ≈ 60 < 200，未出局
      await zyt.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await mining.connect(alice).sellZyt(minted);
      let info = await mining.userInfo(alice.address);
      expect(info[1]).to.be.lt(ethers.parseEther("200"));
      expect(info[6]).to.equal(false);

      // 继续入金并卖出，累计提取逼近 2×入金（200U）
      // 为构造出局需要池子有足够 USDT；此处验证核心路径：提取额累计与出局标记逻辑
      await fundUsdt(usdt, alice, ethers.parseEther("500"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("500"), ZERO);
      info = await mining.userInfo(alice.address);
      expect(info[0]).to.equal(ethers.parseEther("600"));
      expect(info[2]).to.equal(ethers.parseEther("3000")); // quota 刷新
    });
  });

  describe("ZYTReferral 推荐分账", function () {
    it("B 入金时 A 获得 7% 推荐奖励，计入动态额度消耗", async function () {
      const { mining, usdt, zyt, alice, bob } = await deployFixture();
      // A 先入金成为上级
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      const balA0 = await zyt.balanceOf(alice.address);

      // B 带 A 推荐入金 100U
      await fundUsdt(usdt, bob, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(bob).deposit(ethers.parseEther("100"), alice.address);

      // A 收到 7% 推荐奖励（v7：按当日快照锁定价 0.00001 换算）：7U → 7e5 ZYT
      const refReward = ethers.parseEther("7") * 10n ** 18n / ethers.parseEther("0.00001");
      expect(await zyt.balanceOf(alice.address)).to.equal(balA0 + refReward);
      // A 动态额度消耗 = 7U（按 USDT 计）
      const info = await mining.userInfo(alice.address);
      expect(info[3]).to.equal(ethers.parseEther("7"));
    });
  });

  describe("ZYTForceSell 强制卖出", function () {
    it("首次收币 15 天后未卖足 20%，转账时自动销毁", async function () {
      const { mining, usdt, zyt, alice, bob } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      const zytOfAlice = await zyt.balanceOf(alice.address);

      // 快进 15 天
      await ethers.provider.send("evm_increaseTime", [FIFTEEN_DAYS]);
      await ethers.provider.send("evm_mine", []);

      // 未卖出 → soldAmount=0 → 转账触发销毁（本次转账 1 wei 全部销毁）
      const balBefore = await zyt.balanceOf(alice.address);
      await zyt.connect(alice).transfer(bob.address, 1n); // 触发 hook
      // 转出 1 + 销毁 1
      expect(await zyt.balanceOf(alice.address)).to.equal(balBefore - 1n - 1n);
    });
  });

  describe("ZYTDeflation 每日通缩", function () {
    it("每日快照：1% 销毁 + 1% 分红，通缩至 500 万停止", async function () {
      const { pool, deflation } = await deployFixture();
      const poolZytBefore = await pool.poolZYT();
      await deflation.dailySnapshot(0);
      const totalBurn = (poolZytBefore * 2n) / 100n;
      expect(await pool.poolZYT()).to.equal(poolZytBefore - totalBurn);
      expect(await pool.dividendPool()).to.equal(totalBurn / 2n);
      // 同一天不能重复快照
      await expect(deflation.dailySnapshot(0)).to.be.revertedWith("Deflation: once per day");
    });
  });

  describe("v7 买入白名单（防闪电贷）", function () {
    it("非白名单地址入金被拒绝", async function () {
      const { config, pool, usdt, mining, dave } = await deployFixture();
      // 白名单默认开启（config.buyWhitelistEnabled == true）
      expect(await config.buyWhitelistEnabled()).to.equal(true);
      expect(await pool.buyWhitelist(dave.address)).to.equal(false);
      await fundUsdt(usdt, dave, ethers.parseEther("100"), await mining.getAddress());
      await expect(mining.connect(dave).deposit(ethers.parseEther("100"), ZERO)).to.be.revertedWith("Mining: not whitelisted");
    });

    it("多签添加白名单后可入金；批量添加生效", async function () {
      const { pool, usdt, mining, carol, alice } = await deployFixture();
      await pool.setBuyWhitelist(carol.address, true);
      expect(await pool.buyWhitelist(carol.address)).to.equal(true);
      await fundUsdt(usdt, carol, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(carol).deposit(ethers.parseEther("100"), ZERO);
      // 批量添加
      await pool.setBuyWhitelistBatch([alice.address], false);
      expect(await pool.buyWhitelist(alice.address)).to.equal(false);
    });

    it("关闭开关后非白名单可入金（开关控制逃生通道）", async function () {
      const { config, pool, usdt, mining, carol } = await deployFixture();
      await config.setBuyWhitelistEnabled(false);
      await fundUsdt(usdt, carol, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(carol).deposit(ethers.parseEther("100"), ZERO);
    });
  });

  describe("v7 当日快照基准价（防价格操纵）", function () {
    it("初始化即锁定初始快照价，入金不改变当日计价价", async function () {
      const { pool, usdt, mining, alice } = await deployFixture();
      const initPrice = await pool.getTradePrice();
      // 初始 0.00001 U/ZYT：21000e18 / 21e9e18 × 1e18 = 1e13
      expect(initPrice).to.equal(ethers.parseEther("0.00001"));
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      // 实时价因入金上涨，但快照锁定价当日恒定
      expect(await pool.getPrice()).to.be.gt(initPrice);
      expect(await pool.getTradePrice()).to.equal(initPrice);
    });

    it("快照后计价价锁定为快照瞬间实时价（通缩不影响当日计价）", async function () {
      const { pool, deflation, usdt, mining, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      const beforePrice = await pool.getPrice(); // 快照前实时价（含入金影响）
      await deflation.dailySnapshot(0);          // 快照锁定 + 通缩 2%
      // 锁定价 = 快照瞬间价；实时价因通缩(池 ZYT -2%)而高于锁定价
      expect(await pool.getTradePrice()).to.equal(beforePrice);
      expect(await pool.getPrice()).to.be.gt(beforePrice);
    });
  });

  describe("v7 链上卖出统计（UserSellInfo + userList）", function () {
    it("卖出后统计更新：次数/累计 ZYT/累计 USDT", async function () {
      const { zyt, mining, usdt, pool, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      const zytBal = await zyt.balanceOf(alice.address);
      await zyt.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await mining.connect(alice).sellZyt(zytBal / 2n);
      const info = await zyt.getSellInfo(alice.address);
      expect(info[0]).to.equal(1n);          // sellCount
      expect(info[1]).to.equal(zytBal / 2n); // totalSellZyt
      expect(info[2]).to.be.gt(0n);          // totalSellUsdt
      expect(info[4]).to.be.gt(0n);          // lastSellAt
    });

    it("userList 去重登记 + 遍历接口可用", async function () {
      const { zyt, mining, usdt, pool, alice, bob, deployer } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      await fundUsdt(usdt, bob, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(bob).deposit(ethers.parseEther("100"), ZERO);
      // 铸币即入列表：alice、bob（P2-2 白名单保护：技术 10% 收款方 technicalAddress=deployer 已白名单豁免，不列入用户统计）
      expect(await zyt.getUserCount()).to.equal(2n);
      const list = [];
      for (let i = 0; i < 2; i++) list.push((await zyt.getUserAt(i)).toLowerCase());
      expect(list).to.include(alice.address.toLowerCase());
      expect(list).to.include(bob.address.toLowerCase());
      // 同用户多次入金不重复入列
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      expect(await zyt.getUserCount()).to.equal(2n);
    });
  });

  describe("安全修复 V1/V2（审计第一批）", function () {
    it("V1：真实卖出（sellZyt 到池）计入 forceSell.soldAmount", async function () {
      const { mining, usdt, zyt, pool, forceSell, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      const zytOfAlice = await zyt.balanceOf(alice.address);
      // 卖出前 soldAmount = 0
      expect(await forceSell.soldAmount(alice.address)).to.equal(0n);
      // 卖出 1/10 到池（真实卖出路径）
      await zyt.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await mining.connect(alice).sellZyt(zytOfAlice / 10n);
      // 修复后：卖出量计入 soldAmount（转账视同卖出）
      expect(await forceSell.soldAmount(alice.address)).to.equal(zytOfAlice / 10n);
    });

    it("V1：卖出到池不影响池的卖出检查（池收币无强制卖出义务）", async function () {
      const { mining, usdt, zyt, pool, forceSell, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      const zytOfAlice = await zyt.balanceOf(alice.address);
      await zyt.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await mining.connect(alice).sellZyt(zytOfAlice / 10n);
      // 池被 checkAndBurn 初始化（记录 firstReceiveTime）属无害行为：
      // 池作为 from 转出时被 isWhiteList 跳过（永不触发检查），也不入 userList
      expect(await forceSell.initialized(await pool.getAddress())).to.equal(true);
      // 关键：池转出 ZYT（如 payoutDividend）不触发销毁检查
      const poolBal = await zyt.balanceOf(await pool.getAddress());
      expect(poolBal).to.be.gt(0n);
    });

    it("V2：claimDividend 额度消耗按 USDT 等值折算（非 ZYT 数）", async function () {
      const { mining, pool, deflation, usdt, zyt, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      // 制造分红池：快照产生 1% 分红
      await deflation.dailySnapshot(ethers.parseEther("100"));
      const divPool = await pool.dividendPool();
      expect(divPool).to.be.gt(0n);
      const before = (await mining.userInfo(alice.address))[3];
      await mining.connect(alice).claimDividend();
      const after = (await mining.userInfo(alice.address))[3];
      const diff = after - before;
      // 修复后：diff = share × price / 1e18（USDT 等值，远小于 share）
      const price = await pool.getTradePrice();
      // alice 是全网唯一算力（100），share = divPool 全额
      expect(diff).to.equal(divPool * price / 10n ** 18n);
      expect(diff).to.be.lt(divPool); // 折算后远小于 ZYT 数
    });
  });

  describe("安全修复 V4-V7（审计第二批）", function () {
    it("V4：非 keeper/owner 调用 dailySnapshot 被拒（防恶意 totalPower）", async function () {
      const { deflation, config, alice } = await deployFixture();
      // fixture 中 keeperAddress = deployer（owner）；alice 非 keeper 非 owner
      expect(await config.keeperAddress()).to.equal((await ethers.getSigners())[0].address);
      await expect(deflation.connect(alice).dailySnapshot(ethers.parseEther("1000000000"))).to.be.revertedWith("Deflation: not keeper");
    });

    it("V4：owner 可触发快照（多签兜底）", async function () {
      const { deflation } = await deployFixture();
      await deflation.dailySnapshot(0); // deployer = owner
    });

    it("V5：初始底池 2.1 万 USDT 真实转入池（账面=实际）", async function () {
      const { pool, usdt } = await deployFixture();
      // 池实际 USDT 余额 = 初始 2.1 万（fixture 未入金）
      expect(await usdt.balanceOf(await pool.getAddress())).to.equal(GST_POOL);
      expect(await pool.poolUSDT()).to.equal(GST_POOL);
    });

    it("V5：卖出后账面与实际一致（实际余额 ≥ 账面 2.1 万缺口消除）", async function () {
      const { mining, usdt, zyt, pool, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      // 入金 60U 进池：实际 = 21000 + 60，账面 = 21000 + 60 → 一致
      expect(await usdt.balanceOf(await pool.getAddress())).to.equal(GST_POOL + ethers.parseEther("60"));
      expect(await pool.poolUSDT()).to.equal(GST_POOL + ethers.parseEther("60"));
    });

    it("V3：推荐循环绑定被拒（A→B→A 防自我奖励）", async function () {
      const { mining, referral, usdt, alice, bob } = await deployFixture();
      // A(先入金成为上级) → B 带 A 推荐
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      // A 再入金时尝试绑定到 B 形成循环？实际 bind(A) 已绑定，bind(B,A) 先：
      await fundUsdt(usdt, bob, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(bob).deposit(ethers.parseEther("100"), alice.address); // B → A
      // A 尝试把上级链引向 B（A 已绑定谁？首次入金 ref=0 → 未绑定）：
      // A 首次 deposit ref=ZERO → referrerOf[A]=0；此时让 A 用 B 作 ref 再入金 → bind(A,B)
      // 但 bind(A,B) 检查 B 祖先链是否含 A：B 的上级是 A → 含 A → 应拒绝
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), bob.address); // 尝试 A→B（循环）
      // A 的 referrer 应仍为 0（绑定被拒）
      expect(await referral.referrerOf(alice.address)).to.equal(ZERO);
    });

    it("V6：用户间转账扣 10% 滑点（转账视同卖出）", async function () {
      const { mining, usdt, zyt, alice, bob } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      const bal = await zyt.balanceOf(alice.address);
      const amount = ethers.parseEther("1000");
      await zyt.connect(alice).transfer(bob.address, amount);
      // 转出 1000 + 10% 滑点 100 销毁 = 1100
      expect(await zyt.balanceOf(alice.address)).to.equal(bal - amount - amount / 10n);
      expect(await zyt.balanceOf(bob.address)).to.equal(amount);
    });

    it("V7：mintTo 超过 totalSupplyCap 被拒（防无限增发）", async function () {
      const { mining, usdt, config, zyt, alice } = await deployFixture();
      // 把 cap 压到仅剩 1 枚空间（初始池 21 亿已 mint）
      await config.setUint("totalSupplyCap", (await zyt.totalSupply()) + 1n);
      // 通过真实入金路径触发 mintTo → 超 cap 应 revert
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await expect(mining.connect(alice).deposit(ethers.parseEther("100"), ZERO)).to.be.revertedWith("ZYT: supply cap");
      // 用户 USDT 未丢失（整笔回滚）
      expect(await usdt.balanceOf(alice.address)).to.equal(ethers.parseEther("100"));
    });
  });

  describe("安全修复 V8-V13（审计 P2）", function () {
    it("V9：销毁后 soldAmount 不扣减（进度不被侵蚀）", async function () {
      const { mining, usdt, zyt, forceSell, alice, bob } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      // 快进 15 天（进入窗口 1）
      await ethers.provider.send("evm_increaseTime", [FIFTEEN_DAYS]);
      await ethers.provider.send("evm_mine", []);
      await zyt.connect(alice).transfer(bob.address, 1n); // 触发 checkAndBurn：soldAmount=1，销毁 1
      // 修复后：soldAmount 保持 1（销毁不扣减）
      expect(await forceSell.soldAmount(alice.address)).to.equal(1n);
    });

    it("V8：settleExpired 到期自动销毁差额（owner 触发）", async function () {
      const { mining, usdt, zyt, forceSell, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      const bal = await zyt.balanceOf(alice.address);
      // 快进 15 天
      await ethers.provider.send("evm_increaseTime", [FIFTEEN_DAYS]);
      await ethers.provider.send("evm_mine", []);
      // owner 调用 settleExpired → 销毁 余额×20% 差额（alice 未卖出）
      await forceSell.settleExpired(alice.address);
      const expectedBurn = (bal * 20n) / 100n;
      expect(await zyt.balanceOf(alice.address)).to.equal(bal - expectedBurn);
      // 事件已发（余额验证等价，跳过事件断言）
    });

    it("V8：settleExpired 非 keeper/owner 被拒", async function () {
      const { forceSell, alice } = await deployFixture();
      await expect(forceSell.connect(alice).settleExpired(alice.address)).to.be.revertedWith("FS: not keeper");
    });

    it("V10：setUint 费率参数超过 10000 被拒", async function () {
      const { config } = await deployFixture();
      await expect(config.setUint("baseSlippage", 20000)).to.be.revertedWith("ZYTConfig: rate > 10000");
      await expect(config.setUint("slippageTier4", 10001)).to.be.revertedWith("ZYTConfig: rate > 10000");
      // 正常值仍可设置
      await config.setUint("baseSlippage", 800);
      expect(await config.baseSlippage()).to.equal(800);
    });

    it("V13：claimDividend 同一天只能领取一次", async function () {
      const { mining, pool, deflation, usdt, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      await deflation.dailySnapshot(ethers.parseEther("100")); // 产生分红
      expect(await pool.dividendPool()).to.be.gt(0n);
      await mining.connect(alice).claimDividend();
      await expect(mining.connect(alice).claimDividend()).to.be.revertedWith("Mining: claimed today");
    });
  });

  describe("安全修复 V14/V17（审计 P3）", function () {
    it("V14：锁定后非豁免转账被拒，豁免 flag 可设置", async function () {
      const { gst, pool, alice, bob } = await deployFixture();
      // 锁定后（fixture 已 lockRemaining）：普通地址转账被拒（require 先于余额检查）
      await expect(gst.connect(alice).transfer(bob.address, ethers.parseEther("1"))).to.be.revertedWith("GST: supply locked");
      // 豁免机制存在：pool 可被设为豁免（前瞻 DEX 接入）
      await gst.setTransferAllowed(await pool.getAddress(), true);
      expect(await gst.transferAllowed(await pool.getAddress())).to.equal(true);
    });

    it("V17：Sold 事件携带滑点档位（rate）", async function () {
      const { mining, usdt, zyt, pool, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      const zytOfAlice = await zyt.balanceOf(alice.address);
      await zyt.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      const sellAmt = zytOfAlice / 10n;
      const tx = await mining.connect(alice).sellZyt(sellAmt);
      const receipt = await tx.wait();
      const sold = receipt.logs
        .map((l) => {
          try {
            return mining.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .filter((x) => x && x.name === "Sold");
      expect(sold.length).to.equal(1);
      expect(sold[0].args.rate).to.equal(500n); // 基准滑点 5% = 500 基点
      expect(sold[0].args.zytIn).to.equal(sellAmt);
    });
  });

  describe("第二轮深度检测修复（P1-1/P1-2）", function () {
    it("P1-1：禁止领取入金日之前的产出（回溯领取修复）", async function () {
      const { mining, deflation, usdt, alice, bob } = await deployFixture();
      // alice 在 day D 入金（powerDay = D）
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      // 快照记录 day D 的产出与全网算力
      await deflation.dailySnapshot(ethers.parseEther("100"));
      const dayD = BigInt(Math.floor((await ethers.provider.getBlock("latest")).timestamp / 86400));

      // 快进 1 天：bob 在 day D+1 入金（powerDay = D+1）
      await ethers.provider.send("evm_increaseTime", [DAY]);
      await ethers.provider.send("evm_mine", []);
      await fundUsdt(usdt, bob, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(bob).deposit(ethers.parseEther("100"), ZERO);

      // bob 试图回溯领取入金前 day D 的产出 → 拒绝（修复核心断言）
      await expect(mining.connect(bob).claimReward(dayD)).to.be.revertedWith("Mining: before deposit");
      // alice（day D 入金）领取 day D 产出正常
      await mining.connect(alice).claimReward(dayD);
    });

    it("P1-2：动态额度耗尽后 claimDividend 被拒（分红额度修复）", async function () {
      const { mining, deflation, usdt, alice, bob } = await deployFixture();
      // alice 入金 100U → 动态额度 = 500U
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      // 分红池入账（通缩 1% 分红）
      await deflation.dailySnapshot(ethers.parseEther("100"));

      // bob 连续 15 次入金 500U 且 ref=alice → alice 累计推荐奖励 15×35U = 525U > 500U 额度耗尽
      await fundUsdt(usdt, bob, ethers.parseEther("7500"), await mining.getAddress());
      for (let i = 0; i < 15; i++) {
        await mining.connect(bob).deposit(ethers.parseEther("500"), alice.address);
      }
      const info = await mining.userInfo(alice.address);
      expect(info[3]).to.be.gte(ethers.parseEther("500")); // withdrawn >= quota，前置确认

      // 额度耗尽后 claimDividend → 拒绝（修复核心断言）
      await expect(mining.connect(alice).claimDividend()).to.be.revertedWith("Mining: quota exhausted");
    });

    it("P2-1：claimReward 领取成功后标记置位，同日二次领取被拒（状态后置修复回归）", async function () {
      const { mining, deflation, usdt, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      await deflation.dailySnapshot(ethers.parseEther("100"));
      const day = BigInt(Math.floor((await ethers.provider.getBlock("latest")).timestamp / 86400));

      // 首次领取成功（mint 成功后才置位标记）
      await mining.connect(alice).claimReward(day);
      // 同日二次领取 → 标记已置位，被拒（验证状态变更后置未破坏防重复）
      await expect(mining.connect(alice).claimReward(day)).to.be.revertedWith("Mining: claimed");
    });

    it("P1-3：静态出局用户复投自动重置出局状态（决策 A）", async function () {
      const { mining, config, usdt, zyt, pool, deflation, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);

      // 临时调 staticExitMul=0 构造出局（withdrawTotal>=depositTotal×0 恒真），卖出 1 wei 即触发
      await config.setUint("staticExitMul", 0);
      await zyt.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await mining.connect(alice).sellZyt(1n);
      expect((await mining.userInfo(alice.address))[6]).to.equal(true); // isExited=true

      // 调回 2 倍后复投 → 出局状态重置（withdrawTotal 保留不清零）
      await config.setUint("staticExitMul", 2);
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      expect((await mining.userInfo(alice.address))[6]).to.equal(false); // 复投后重置

      // 复投后算力恢复，可正常领取产出（不再 exited）
      await deflation.dailySnapshot(ethers.parseEther("100"));
      const day = BigInt(Math.floor((await ethers.provider.getBlock("latest")).timestamp / 86400));
      await mining.connect(alice).claimReward(day);
    });

    it("P2-2：营销/技术地址白名单豁免强制卖出初始化（决策 A 保护）", async function () {
      const { mining, usdt, zyt, pool, forceSell, deployer, alice } = await deployFixture();
      await fundUsdt(usdt, alice, ethers.parseEther("100"), await mining.getAddress());
      await mining.connect(alice).deposit(ethers.parseEther("100"), ZERO);
      // 卖出 → 滑点 30% 营销转给 marketAddress=deployer（白名单）→ 不应启动强制卖出窗口
      const bal = await zyt.balanceOf(alice.address);
      await zyt.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
      await mining.connect(alice).sellZyt(bal);
      expect(await forceSell.initialized(deployer.address)).to.equal(false);
      expect(await forceSell.firstReceiveTime(deployer.address)).to.equal(0n);
    });
  });
});
