// 主网 TestUSDT 试运行版 部署后接线核对（只读）+ 一键修复（setKeeper + 白名单开关）
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import "dotenv/config";
const A = {
  config: "0x7247791Bd79e831C78B8DCFDF820C43a7386f370",
  zyt: "0xAB4c090CD436D1d93Aa6D18067A3217206Bd097A",
  forceSell: "0xD944f0A514b92F9adBc805F7E94E75aD489Af2A6",
  pool: "0xe2b0DdB48f4455830D38cD765d9b79DBd906c291",
  mining: "0xFC97Bf17243C2ef9A8442c190A1897B61745C830",
  testUsdt: "0x4cd6d10260Cdfc55A9dcf97dfffade73080E7608",
};
const RPC = process.env.BSC_MAINNET_RPC || "https://bsc-dataseed1.bnbchain.org";
const p = new JsonRpcProvider(RPC, 56, { staticNetwork: true });
const owner = new Wallet(process.env.PRIVATE_KEY, p);
const cfg = new Contract(A.config, [
  "function marketAddress() view returns (address)","function technicalAddress() view returns (address)",
  "function keeperAddress() view returns (address)","function buyWhitelistEnabled() view returns (bool)",
  "function usdt() view returns (address)","function setBuyWhitelistEnabled(bool)",
], owner);
const fs = new Contract(A.forceSell, ["function keeper() view returns (address)","function setKeeper(address)"], owner);
const zyt = new Contract(A.zyt, ["function configAddr() view returns (address)","function minter() view returns (address)","function pool() view returns (address)","function totalSupply() view returns (uint256)"], p);
const pool = new Contract(A.pool, ["function poolGST() view returns (uint256)","function poolZYT() view returns (uint256)","function poolUSDT() view returns (uint256)","function getStage() view returns (uint256)"], p);
const usdt = new Contract(A.testUsdt, ["function balanceOf(address) view returns (uint256)","function symbol() view returns (string)"], p);

const [market, tech, keeperAddr, wlEnabled, usdtAddr, fsKeeper] = await Promise.all([
  cfg.marketAddress(), cfg.technicalAddress(), cfg.keeperAddress(), cfg.buyWhitelistEnabled(), cfg.usdt(), fs.keeper(),
]);
console.log("=== 接线核对 ===");
console.log("marketAddress  :", market);
console.log("technicalAddr  :", tech);
console.log("keeperAddress  :", keeperAddr, keeperAddr.toLowerCase() === "0x09bed12b5956e1e53668aa10e242766e3a3e3b641" ? "✓" : "✗ 期望 0x09BeD...");
console.log("buyWhitelist   :", wlEnabled, "(true=需白名单)");
console.log("config.usdt    :", usdtAddr, usdtAddr.toLowerCase() === A.testUsdt.toLowerCase() ? "✓ TestUSDT" : "✗ 非 TestUSDT");
console.log("ForceSell.keeper:", fsKeeper);
const [cAddr, minter, poolAddr] = await Promise.all([zyt.configAddr(), zyt.minter(), zyt.pool()]);
console.log("zyt.configAddr :", cAddr, cAddr.toLowerCase() === A.config.toLowerCase() ? "✓" : "✗");
console.log("zyt.minter     :", minter, minter.toLowerCase() === A.mining.toLowerCase() ? "✓" : "✗");
console.log("zyt.pool       :", poolAddr, poolAddr.toLowerCase() === A.pool.toLowerCase() ? "✓" : "✗");
const [g, z, u, st] = await Promise.all([pool.poolGST(), pool.poolZYT(), pool.poolUSDT(), pool.getStage()]);
console.log("池 GST/ZYT/USDT:", Number(g)/1e18, "/", Number(z)/1e18, "/", Number(u)/1e18, "stage:", Number(st));
console.log("deployer TestUSDT 余额:", Number(await usdt.balanceOf(owner.address))/1e18, await usdt.symbol());

// ---- 修复 1：ForceSell keeper ----
if (fsKeeper === "0x0000000000000000000000000000000000000000") {
  if (keeperAddr && keeperAddr !== "0x0000000000000000000000000000000000000000") {
    const tx = await fs.setKeeper(keeperAddr);
    await tx.wait();
    console.log("✓ setKeeper(", keeperAddr, ") tx:", tx.hash);
  }
} else console.log("ForceSell.keeper 已配置 ✓");

// ---- 修复 2：白名单开关（试运行期开放，参数 whitelist-off 时执行）----
if (process.argv[2] === "whitelist-off" && wlEnabled) {
  const tx = await cfg.setBuyWhitelistEnabled(false);
  await tx.wait();
  console.log("✓ setBuyWhitelistEnabled(false) tx:", tx.hash, "（试运行期人人可入金）");
}
process.exit(0);
