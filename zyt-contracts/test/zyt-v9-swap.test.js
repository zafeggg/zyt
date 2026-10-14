/**
 * ZYT v9.2 迁移兑换 ZYTSwap 测试
 *
 * 覆盖：
 *   - 白名单红线硬校验（未白名单即 fund → 拒绝，防 1:1 被 10% 转账税削掉）
 *   - 1:1 兑换、旧币逐笔入黑地址销毁、记账累计
 *   - 14 天窗口到期自动关闭 / owner 提前关闭 / 未开启状态
 *   - 未用新币回收（窗口关闭或到期后才可）
 *   - 新币余额不足时兑换整体回滚
 *
 * 说明：旧币与新币均为真实 ZYTToken（含转账 hook 与白名单分支），
 *       故本套件同时验证「白名单化后转账无税、不登记强卖义务」。
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const E18 = 10n ** 18n;
const DAY = 86400;

describe("ZYT v9.2 迁移兑换 ZYTSwap", function () {
  let cfgOld, cfgNew, zytOld, zytNew, swap;
  let deployer, alice, bob;

  beforeEach(async function () {
    [deployer, alice, bob] = await ethers.getSigners();

    const Config = await ethers.getContractFactory("ZYTConfig");
    cfgOld = await Config.deploy();
    cfgNew = await Config.deploy();

    const ZYT = await ethers.getContractFactory("ZYTToken");
    zytOld = await ZYT.deploy(DEAD);
    zytNew = await ZYT.deploy(DEAD);

    await zytOld.setConfig(await cfgOld.getAddress());
    await zytOld.setMinter(deployer.address);
    await zytNew.setConfig(await cfgNew.getAddress());
    await zytNew.setMinter(deployer.address);

    swap = await (await ethers.getContractFactory("ZYTSwap")).deploy(
      await zytOld.getAddress(), await zytNew.getAddress(), DEAD
    );
  });

  it("SWAP-1：白名单红线硬校验 + 1:1 兑换 + 旧币入黑地址销毁", async function () {
    const amt = 1_000n * E18;
    await zytOld.mintTo(alice.address, amt);
    await zytNew.mintTo(deployer.address, amt);
    await zytNew.approve(await swap.getAddress(), amt);

    // 两端未白名单 → fund 拒绝（否则用户转入旧币被扣 10%、转出新币再扣 10%）
    await expect(swap.fund(amt)).to.be.revertedWith("Swap: old token not whitelisted");
    await zytOld.setWhiteList(await swap.getAddress(), true);
    await expect(swap.fund(amt)).to.be.revertedWith("Swap: new token not whitelisted");
    await zytNew.setWhiteList(await swap.getAddress(), true);
    // 越权注资
    await expect(swap.connect(alice).fund(amt)).to.be.reverted;
    // 零额
    await expect(swap.fund(0n)).to.be.revertedWith("Swap: zero");

    // 正常注资 → 窗口开启 14 天
    await swap.fund(amt);
    expect(await swap.isOpen()).to.equal(true);
    expect(await swap.deadline()).to.equal((await swap.startTime()) + BigInt(14 * DAY));

    // 1:1 兑换：精确等值，旧币余额归零（无 10% 税）
    await zytOld.connect(alice).approve(await swap.getAddress(), amt);
    await swap.connect(alice).swap(amt);
    expect(await zytNew.balanceOf(alice.address)).to.equal(amt);
    expect(await zytOld.balanceOf(alice.address)).to.equal(0n);
    expect(await zytOld.balanceOf(DEAD)).to.equal(amt); // 兑入旧币统一销毁
    expect(await swap.totalOldIn()).to.equal(amt);
    expect(await swap.totalNewOut()).to.equal(amt);
  });

  it("SWAP-2：14 天窗口到期自动关闭 + 未用新币回收", async function () {
    const amt = 1_000n * E18;
    await zytOld.mintTo(alice.address, amt);
    await zytNew.mintTo(deployer.address, amt);
    await zytOld.setWhiteList(await swap.getAddress(), true);
    await zytNew.setWhiteList(await swap.getAddress(), true);
    await zytNew.approve(await swap.getAddress(), amt);
    await swap.fund(amt);

    // 窗口内不可回收
    await expect(swap.reclaim(deployer.address, 1n)).to.be.revertedWith("Swap: still open");

    // 到期后：兑换被拒、回收可用
    await ethers.provider.send("evm_increaseTime", [15 * DAY]);
    await ethers.provider.send("evm_mine");
    expect(await swap.isOpen()).to.equal(false);
    await zytOld.connect(alice).approve(await swap.getAddress(), amt);
    await expect(swap.connect(alice).swap(amt)).to.be.revertedWith("Swap: window closed");
    await swap.reclaim(deployer.address, amt);
    expect(await zytNew.balanceOf(deployer.address)).to.equal(amt);
  });

  it("SWAP-3：owner 可提前关闭窗口，关闭后可回收", async function () {
    const amt = 100n * E18;
    await zytOld.mintTo(alice.address, amt);
    await zytNew.mintTo(deployer.address, amt);
    await zytOld.setWhiteList(await swap.getAddress(), true);
    await zytNew.setWhiteList(await swap.getAddress(), true);
    await zytNew.approve(await swap.getAddress(), amt);
    await swap.fund(amt);

    await expect(swap.connect(alice).close()).to.be.reverted;
    await swap.close();
    expect(await swap.isOpen()).to.equal(false);
    await expect(swap.close()).to.be.revertedWith("Swap: already closed");
    await zytOld.connect(alice).approve(await swap.getAddress(), amt);
    await expect(swap.connect(alice).swap(amt)).to.be.revertedWith("Swap: window closed");
    await swap.reclaim(deployer.address, amt);
    expect(await zytNew.balanceOf(deployer.address)).to.equal(amt);
  });

  it("SWAP-4：未开启不可兑换；新币不足时兑换整体回滚", async function () {
    const amt = 100n * E18;
    await zytOld.mintTo(alice.address, amt);
    await zytOld.setWhiteList(await swap.getAddress(), true);
    await zytNew.setWhiteList(await swap.getAddress(), true);
    await zytOld.connect(alice).approve(await swap.getAddress(), amt);

    // 未 fund → 窗口未开启
    await expect(swap.connect(alice).swap(amt)).to.be.revertedWith("Swap: window closed");

    // 只备一半新币：超出部分整体回滚（旧币不会白送进黑洞）
    await zytNew.mintTo(deployer.address, amt / 2n);
    await zytNew.approve(await swap.getAddress(), amt / 2n);
    await swap.fund(amt / 2n);
    await expect(swap.connect(alice).swap(amt)).to.be.reverted;
    expect(await zytOld.balanceOf(DEAD)).to.equal(0n);
    await swap.connect(alice).swap(amt / 2n);
    expect(await zytNew.balanceOf(alice.address)).to.equal(amt / 2n);
    expect(await zytOld.balanceOf(DEAD)).to.equal(amt / 2n);
  });
});
