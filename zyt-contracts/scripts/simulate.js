// 本地联调：模拟真实交易流（hardhat node 上跑）
// 用法：npx hardhat run scripts/simulate.js --network localhost
const { ethers } = require("hardhat");
const fs = require("fs");

const ADDRS = {
  mining: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
  pool: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
  deflation: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
  zyt: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  usdt: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
};

function abi(rel) {
  const base = rel.split("/").pop();
  return JSON.parse(fs.readFileSync(`artifacts/contracts/${rel}.sol/${base}.json`, "utf8")).abi;
}

async function main() {
  const [deployer, alice, bob, carol] = await ethers.getSigners();
  const usdt = new ethers.Contract(ADDRS.usdt, abi("mocks/MockERC20"), deployer);
  const mining = new ethers.Contract(ADDRS.mining, abi("ZYTMining"), deployer);
  const zyt = new ethers.Contract(ADDRS.zyt, abi("ZYTToken"), deployer);
  const deflation = new ethers.Contract(ADDRS.deflation, abi("ZYTDeflation"), deployer);
  const pool = new ethers.Contract(ADDRS.pool, abi("ZYTPoolManager"), deployer);

  // 给用户充值 USDT
  for (const s of [alice, bob, carol]) {
    await (await usdt.connect(s).faucet(ethers.parseEther("500"))).wait();
    await (await usdt.connect(s).approve(ADDRS.mining, ethers.MaxUint256)).wait();
  }
  console.log("USDT funded");

  // 三笔入金（含推荐）
  await (await mining.connect(alice).deposit(ethers.parseEther("300"), ethers.ZeroAddress)).wait();
  await (await mining.connect(bob).deposit(ethers.parseEther("200"), alice.address)).wait();
  await (await mining.connect(carol).deposit(ethers.parseEther("100"), alice.address)).wait();
  console.log("deposits done");

  // 每日快照（全网算力 = 600）
  await (await deflation.dailySnapshot(ethers.parseEther("600"))).wait();
  console.log("snapshot done");

  // alice 领取当日产出
  const day = BigInt(Math.floor(Date.now() / 1000 / 86400));
  await (await mining.connect(alice).claimReward(day)).wait();
  console.log("claim done");

  // bob 卖出部分 ZYT
  const bobZyt = await zyt.balanceOf(bob.address);
  await (await zyt.connect(bob).approve(ADDRS.pool, ethers.MaxUint256)).wait();
  const sellAmt = (bobZyt * 30n) / 100n;
  await (await mining.connect(bob).sellZyt(sellAmt)).wait();
  console.log("sell done, sold:", ethers.formatEther(sellAmt));

  // 输出池状态
  const [gst, zytPool, usdtPool, price, stage, slip] = await Promise.all([
    pool.poolGST(),
    pool.poolZYT(),
    pool.poolUSDT(),
    pool.getPrice(),
    pool.getStage(),
    pool.getCurrentSlippage(),
  ]);
  console.log("pool: gst=%s zyt=%s usdt=%s price=%s stage=%s slip=%s%%",
    ethers.formatEther(gst), ethers.formatEther(zytPool), ethers.formatEther(usdtPool),
    ethers.formatEther(price), stage, Number(slip) / 100);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
