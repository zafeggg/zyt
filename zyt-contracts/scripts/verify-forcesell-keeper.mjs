// 验证 ForceSell keeper 接线（报告 §3 建议）：非授权被拒 + keeper 可结算（用零地址防误销毁）
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import "dotenv/config";
const p = new JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com", 97);
const FS = "0x24685AF81fc8443ED46b11Cb17Ba7af0ae55ce06";
const KEEPER = "0xdFA550005B75DA1930C65732Db46baD5cB50a480";
const ZERO = "0x0000000000000000000000000000000000000000";
const fsRead = new Contract(FS, ["function keeper() view returns (address)","function settleExpired(address) returns (uint256)"], p);
console.log("keeper 当前:", await fsRead.keeper());

// 1) 非授权随机钱包 → 期望 revert FS: not keeper
const random = Wallet.createRandom().connect(p);
const fsRandom = new Contract(FS, ["function settleExpired(address) returns (uint256)"], random);
try {
  const tx = await fsRandom.settleExpired(ZERO);
  console.log("!! 非授权竟成功(门控失效?)", tx.hash);
} catch (e) {
  const msg = (e.shortMessage || e.message || "");
  console.log("非授权被拒 ✓:", msg.includes("not keeper") ? "FS: not keeper" : msg.slice(0, 80));
}

// 2) keeper（0xdFA5，.env 私钥）→ 零地址 settle 期望 burned=0 成功
const kp = process.env.KEEPER_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!kp) { console.log("无 keeper 私钥，跳过第 2 步"); process.exit(0); }
const keeperW = new Wallet(kp, p);
console.log("keeper 调用者:", keeperW.address);
if (keeperW.address.toLowerCase() !== KEEPER.toLowerCase()) {
  console.log("!! 私钥地址与 keeperAddress 不符，跳过实际调用");
  process.exit(0);
}
const fsKeeper = new Contract(FS, ["function settleExpired(address) returns (uint256)"], keeperW);
try {
  const tx = await fsKeeper.settleExpired(ZERO);
  const r = await tx.wait();
  console.log("keeper 可结算 ✓ tx:", tx.hash, "| status:", r.status);
  // 事件解析 burned
  for (const e of r.logs) {
    try {
      const parsed = fsKeeper.interface.parseLog(e);
      if (parsed) console.log("  事件:", parsed.name, "burned=", parsed.args.amount?.toString?.() || "");
    } catch {}
  }
} catch (e) {
  console.log("keeper 调用失败:", (e.shortMessage || e.message || "").slice(0, 120));
}
process.exit(0);
