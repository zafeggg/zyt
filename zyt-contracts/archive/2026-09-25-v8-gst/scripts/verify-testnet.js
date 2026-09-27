/* global ethers */
const { ethers } = require("hardhat");
require("dotenv").config();
const A = {
  config: "0x55F4e5F732ACfa49015AB6546a2766Db7534cDbd",
  gst: "0xD63C5528008A6c9C521Fe2BEA9349bE4687b5ed3",
  zyt: "0xdF18105bB57165c59AD651Eda1B4d896412d4166",
  pool: "0x020927BC660f7631709d388C992979359196DcfD",
  mining: "0x1ffCec692Ef2c8287C1dE7248B0621bdAd135703",
  usdt: "0x7749da5d64c0ABA2A8203c0C630d31e7D13cFb29",
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
