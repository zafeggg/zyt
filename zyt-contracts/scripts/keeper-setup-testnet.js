/* global ethers */
/**
 * @title keeper 签名钱包接入 testnet（第五套）
 * @notice 1) config.keeperAddress → keeper 钱包（生产形态：独立签名钱包触发快照）
 *         2) deployer 转 0.01 tBNB 供 keeper 钱包发快照交易
 * @usage  npx hardhat run scripts/keeper-setup-testnet.js --network bscTestnet
 */
require("dotenv").config();

const CONFIG_ADDR = "0x55F4e5F732ACfa49015AB6546a2766Db7534cDbd"; // 第五套
const KEEPER_ADDR = "0xdFA550005B75DA1930C65732Db46baD5cB50a480"; // 独立签名钱包

async function main() {
  const [deployer] = await ethers.getSigners();
  const Cfg = await ethers.getContractAt("ZYTConfig", CONFIG_ADDR);
  console.log("deployer:", deployer.address);

  // 1. 更新 keeperAddress（仅 owner）
  const before = await Cfg.keeperAddress();
  console.log("keeperAddress 更新前:", before);
  if (before.toLowerCase() !== KEEPER_ADDR.toLowerCase()) {
    const tx = await Cfg.setAddress("keeperAddress", KEEPER_ADDR);
    await tx.wait();
    console.log("setAddress tx:", tx.hash);
  } else {
    console.log("[SKIP] keeperAddress 已是目标值");
  }
  const after = await Cfg.keeperAddress();
  console.log("keeperAddress 更新后:", after);

  // 2. 转 gas（快照写交易用；不持有资金）
  const bal = await ethers.provider.getBalance(KEEPER_ADDR);
  if (bal < ethers.parseEther("0.005")) {
    const g = await deployer.sendTransaction({ to: KEEPER_ADDR, value: ethers.parseEther("0.01") });
    await g.wait();
    console.log("gas 转账 tx:", g.hash);
  } else {
    console.log("[SKIP] keeper 已有足够 tBNB:", ethers.formatEther(bal));
  }
  console.log("keeper tBNB 余额:", ethers.formatEther(await ethers.provider.getBalance(KEEPER_ADDR)));
}

main().catch((e) => {
  console.error("ERROR:", e.message.slice(0, 400));
  process.exit(1);
});
