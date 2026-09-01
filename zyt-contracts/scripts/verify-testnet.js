/* global ethers */
const { ethers } = require("hardhat");
require("dotenv").config();
const A = {
  config: "0x62a96b2880fD282BC0984db800057F1CDFe2873C",
  gst: "0x6E612B64885EBcd2511f97d8eC74c80fAE08FF20",
  zyt: "0x9bd8CD99e61BE9c1FbB35282345111017a80F107",
  pool: "0x701A4A0cF59a05ada702e9b8b572b46e50F70726",
  mining: "0x3A7B648752D3557C9770a56Fd3B471dB6ee8FE69",
  usdt: "0xe6d5879149078B7082567AF70319a16b7952CA8C",
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
