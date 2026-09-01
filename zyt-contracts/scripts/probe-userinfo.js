/* global ethers */
/**
 * @title 探针：实证 ethers v6 对 UserState struct 返回的索引/命名访问语义
 * @usage  npx hardhat run scripts/probe-userinfo.js --network bscTestnet
 */
const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
  const Min = await ethers.getContractAt(
    "ZYTMining",
    "0xa7eB30aa42BC4947c3875b4592caCDf71BeBc065"
  );
  const me = "0xd6e433f3a4D4Cb5F3E881420478AB5b3d7cafd48"; // 第三套链已入金测试钱包
  const ui = await Min.userInfo(me);

  console.log("result.length:", ui.length);
  console.log("result keys:", Object.keys(ui).join(","));
  console.log("--- 数字索引 ---");
  for (let i = 0; i < ui.length; i++) {
    console.log("  ui[" + i + "] =", ui[i].toString());
  }
  console.log("--- 命名访问 ---");
  console.log("  depositTotal   =", ui.depositTotal.toString());
  console.log("  withdrawTotal  =", ui.withdrawTotal.toString());
  console.log("  dynamicQuota   =", ui.dynamicQuota.toString());
  console.log("  dynamicWithdrawn =", ui.dynamicWithdrawn.toString());
  console.log("  powerBase      =", ui.powerBase.toString());
  console.log("  powerDay       =", ui.powerDay.toString());
  console.log("  lpQuota        =", ui.lpQuota.toString());
  console.log("  pendingDividend =", ui.pendingDividend.toString());
  console.log("  isExited       =", ui.isExited.toString());
}

main().catch((e) => {
  console.error("ERROR:", e.message.slice(0, 400));
  process.exit(1);
});
