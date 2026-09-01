/* global ethers */
const { ethers } = require("hardhat");
require("dotenv").config();
const A = {
  config: "0xC441F49A9B6f3fCC035C5F3CAFE0cB2F01352547",
  gst: "0x0b50EbCF3720c2225BAEFCFb8cCAE2F25570EDE3",
  zyt: "0xE3d62AbaE7F8F85502ef24816f53b74Fd37859C6",
  pool: "0x93C14B12d000c48b2E94e725971D150547a68389",
  mining: "0x447260bC0fb5BBA34eEA92f839e0571Cd9d2D173",
  usdt: "0x3295108D79e857029a7016D2F4A0C55C5E1ba6c6",
  deployer: "0xB7233A003C37Beb100C4eFCF82793D24B90179F9",
  blackHole: "0x000000000000000000000000000000000000dEaD",
};
async function main() {
  const [Cfg, Gst, Zyt, Pool] = await Promise.all([
    ethers.getContractAt("ZYTConfig", A.config),
    ethers.getContractAt("GSTToken", A.gst),
    ethers.getContractAt("ZYTToken", A.zyt),
    ethers.getContractAt("ZYTPoolManager", A.pool),
  ]);
  const fmt = (x) => ethers.formatUnits(x, 18);
  const log = (k, v) => console.log(k.padEnd(28), v);
  log("keeper == deployer", (await Cfg.keeperAddress()).toLowerCase() === A.deployer.toLowerCase());
  log("usdt_cfg == mock", (await Cfg.usdt()).toLowerCase() === A.usdt.toLowerCase());
  log("market", await Cfg.marketAddress());
  log("router", await Cfg.router());
  log("poolStage1USDT", fmt(await Cfg.poolStage1USDT()));
  log("poolStage2USDT", fmt(await Cfg.poolStage2USDT()));
  log("buyWhitelistEnabled", await Cfg.buyWhitelistEnabled());
  log("paused", await Cfg.paused());
  log("poolGST", fmt(await Pool.poolGST()));
  log("poolZYT", fmt(await Pool.poolZYT()));
  log("poolUSDT", fmt(await Pool.poolUSDT()));
  log("snapshotPrice(1e18)", (await Pool.snapshotPrice()).toString());
  log("stage", await Pool.getStage());
  log("initialized", await Pool.initialized());
  log("dividendPool", fmt(await Pool.dividendPool()));
  log("zytSupply", fmt(await Zyt.totalSupply()));
  log("poolZytBal == supply", (await Zyt.balanceOf(A.pool)) === (await Zyt.totalSupply()));
  log("zytMinter == mining", (await Zyt.minter()).toLowerCase() === A.mining.toLowerCase());
  log("zytConfig == config", (await Zyt.configAddr()).toLowerCase() === A.config.toLowerCase());
  log("wl[pool]", await Zyt.isWhiteList(A.pool));
  log("wl[mining]", await Zyt.isWhiteList(A.mining));
  log("gstSupplyLocked", await Gst.supplyLocked());
  const gs = await Gst.totalSupply(), gp = await Gst.balanceOf(A.pool), gb = await Gst.balanceOf(A.blackHole);
  log("gstSupply", fmt(gs));
  log("gst@pool", fmt(gp));
  log("gst@blackhole", fmt(gb));
  log("blackhole == supply-pool", gb === gs - gp);
  log("userCount", (await Zyt.getUserCount()).toString());
}
main().catch((e) => { console.error("ERROR:", e.message.slice(0, 300)); process.exit(1); });
