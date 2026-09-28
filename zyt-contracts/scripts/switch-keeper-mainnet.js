/**
 * 主网 keeper 地址切换（2026-09-28）
 * 前置：F:/zyt/zyt-contracts/.env 的 PRIVATE_KEY 已由用户手动填入（deployer 0x65851a66…347c）。
 * 动作：①ZYTConfig.setAddress("keeperAddress", 新) ②ZYTForceSell.setKeeper(新) ③链上校验。
 * 安全：私钥只从 .env 读取，本脚本与输出绝不回显私钥；执行完建议用户自行清空该行。
 */
process.env.CHAIN_ID = process.env.CHAIN_ID || "56";
const { JsonRpcProvider, Contract, Wallet, formatEther } = require("ethers");
require("dotenv").config();

const RPC = process.env.BSC_MAINNET_RPC || "https://1rpc.io/bnb";
const CONFIG_ADDR = "0x4FEFe79A90Bf7C9BD2699030Ee1ad0360f4B1B22";
const FORCESELL_ADDR = "0xaE0EeD16e6f7ca4736294a6c2E4a5b87d02672C8";
const NEW_KEEPER = "0x060FA4cfbC3d636dAeC01cfed01bE24B55728DfA";
const EXPECTED_DEPLOYER = "0x65851a66d806d797c25f2b2f0c766e731d70347c";

(async () => {
  const pk = (process.env.PRIVATE_KEY || "").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) {
    console.error("✗ .env 的 PRIVATE_KEY 为空或格式无效——请先把 deployer 私钥填入本地 .env（不要发到对话里）");
    process.exit(2);
  }
  const p = new JsonRpcProvider(RPC, 56, { staticNetwork: true, timeout: 20000 });
  const signer = new Wallet(pk.startsWith("0x") ? pk : "0x" + pk, p);
  if (signer.address.toLowerCase() !== EXPECTED_DEPLOYER) {
    console.error(`✗ 私钥对应的地址(${signer.address})不是 deployer(${EXPECTED_DEPLOYER})，终止`);
    process.exit(2);
  }
  const cfg = new Contract(CONFIG_ADDR, [
    "function owner() view returns (address)",
    "function setAddress(string,address)",
    "function keeperAddress() view returns (address)",
  ], p);
  const fs = new Contract(FORCESELL_ADDR, [
    "function owner() view returns (address)",
    "function setKeeper(address)",
    "function keeper() view returns (address)",
  ], p).connect(signer);
  const cfgW = cfg.connect(signer);

  console.log("签名者:", signer.address, "| BNB:", formatEther(await p.getBalance(signer.address)));

  // ① Config.setAddress("keeperAddress", NEW)
  const t1 = await cfgW.setAddress("keeperAddress", NEW_KEEPER);
  console.log("tx1 (Config.setAddress) 已发:", t1.hash);
  await t1.wait();
  console.log("tx1 确认 ✓");

  // ② ForceSell.setKeeper(NEW)
  const t2 = await fs.setKeeper(NEW_KEEPER);
  console.log("tx2 (ForceSell.setKeeper) 已发:", t2.hash);
  await t2.wait();
  console.log("tx2 确认 ✓");

  // ③ 链上校验
  const [k1, k2] = await Promise.all([cfg.keeperAddress(), fs.keeper()]);
  const ok = k1.toLowerCase() === NEW_KEEPER.toLowerCase() && k2.toLowerCase() === NEW_KEEPER.toLowerCase();
  console.log("\n校验：Config.keeperAddress =", k1);
  console.log("校验：ForceSell.keeper     =", k2);
  console.log(ok ? "✔ 两处均已切到新 keeper" : "✘ 存在未切换项，需排查");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("执行失败:", String(e.shortMessage || e.message).slice(0, 200));
  process.exit(1);
});
