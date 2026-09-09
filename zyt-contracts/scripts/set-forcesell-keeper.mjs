// testnet：owner 给 ZYTForceSell 配置 keeper（报告 P1：ZYTConfig.keeperAddress 已配但 ForceSell.keeper 零地址）
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import "dotenv/config";
const p = new JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com", 97);
const owner = new Wallet(process.env.PRIVATE_KEY, p);
const FS = "0x24685AF81fc8443ED46b11Cb17Ba7af0ae55ce06";
const KEEPER = "0xdFA550005B75DA1930C65732Db46baD5cB50a480";
const fs = new Contract(FS, ["function setKeeper(address)","function keeper() view returns (address)"], owner);
console.log("owner:", owner.address, "| 当前 keeper:", await fs.keeper());
if ((await fs.keeper()).toLowerCase() !== KEEPER.toLowerCase()) {
  const tx = await fs.setKeeper(KEEPER);
  await tx.wait();
  console.log("setKeeper tx:", tx.hash);
}
for (let i = 0; i < 5; i++) {
  const k = await fs.keeper();
  if (k.toLowerCase() === KEEPER.toLowerCase()) { console.log("keeper 已设置 ✓", k); break; }
  await new Promise(r => setTimeout(r, 1500));
}
process.exit(0);
