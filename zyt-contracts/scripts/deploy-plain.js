// 纯 ethers 部署脚本 v2（手动 nonce 管理，绕开 hardhat 客户端 gas 校验）
// 用法：node scripts/deploy-plain.js
const { ethers } = require("ethers");
const fs = require("fs");

const RPC = "http://127.0.0.1:8545";
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat account#0
const BLACK_HOLE = "0x000000000000000000000000000000000000dEaD";
// V4：Keeper 触发地址（与 keeper 服务 KEEPER_PRIVATE_KEY 对应；本地联调 = hardhat alice）
const KEEPER_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const GAS = 5_000_000;

function artifact(rel) {
  const base = rel.split("/").pop();
  const j = JSON.parse(fs.readFileSync(`artifacts/contracts/${rel}.sol/${base}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode };
}
const base = (rel) => rel.split("/").pop();

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 31337);
  const signer = new ethers.Wallet(PK, provider);
  let nonce = await signer.getNonce();
  console.log("Deployer:", signer.address, "startNonce:", nonce);

  async function tx(promise, label) {
    const t = await promise;
    const r = await t.wait();
    console.log(`  ${label}: ${r.hash.slice(0, 18)}... (block ${r.blockNumber})`);
    return t;
  }
  async function call(contract, method, args, label) {
    const t = await contract[method](...args, { gasLimit: GAS, nonce: nonce++ });
    await t.wait();
    return t;
  }
  async function deploy(rel, args = [], links = {}) {
    let { abi, bytecode } = artifact(rel);
    for (const [name, addr] of Object.entries(links)) {
      const placeholder = `__$${ethers.id(name).slice(2, 36)}$__`;
      if (bytecode.includes(placeholder)) {
        const escaped = placeholder.replace(/\$/g, "\\$");
        bytecode = bytecode.replace(new RegExp(escaped, "g"), addr.slice(2).toLowerCase());
      }
    }
    const factory = new ethers.ContractFactory(abi, bytecode, signer);
    const c = await factory.deploy(...args, { gasLimit: GAS, nonce: nonce++ });
    await c.waitForDeployment();
    console.log(`  ${base(rel)}: ${await c.getAddress()}`);
    return c;
  }

  const usdt = await deploy("mocks/MockERC20", ["Mock USDT", "USDT", 18]);
  const config = await deploy("ZYTConfig");
  const gst = await deploy("GSTToken", [BLACK_HOLE]);
  const zyt = await deploy("ZYTToken", [BLACK_HOLE]);
  const forceSell = await deploy("ZYTForceSell", [await zyt.getAddress()]);
  const pool = await deploy("ZYTPoolManager", [await config.getAddress(), await zyt.getAddress(), await usdt.getAddress(), await gst.getAddress()]);
  const referral = await deploy("ZYTReferral");
  const compute = await deploy("ZYTCompute");
  const mining = await deploy("ZYTMining", [
    await config.getAddress(), await pool.getAddress(), await referral.getAddress(),
    await zyt.getAddress(), await usdt.getAddress(),
  ], { "contracts/ZYTCompute.sol:ZYTCompute": await compute.getAddress() });
  const deflation = await deploy("ZYTDeflation", [
    await config.getAddress(), await pool.getAddress(), await mining.getAddress(),
  ]);

  const A = {
    config: await config.getAddress(), gst: await gst.getAddress(), zyt: await zyt.getAddress(),
    forceSell: await forceSell.getAddress(), pool: await pool.getAddress(),
    referral: await referral.getAddress(), mining: await mining.getAddress(),
    deflation: await deflation.getAddress(), usdt: await usdt.getAddress(),
  };

  // 接线
  for (const [k, v] of Object.entries({
    marketAddress: signer.address, technicalAddress: signer.address, blackHole: BLACK_HOLE,
    usdt: A.usdt, gst: A.gst, zyt: A.zyt, pool: A.pool, mining: A.mining,
    deflation: A.deflation, forceSell: A.forceSell, referral: A.referral,
    // V4：Keeper 触发地址（= keeper 服务 KEEPER_PRIVATE_KEY 对应地址；owner 亦可触发）
    keeperAddress: KEEPER_ADDR,
  })) await call(config, "setAddress", [k, v], "set:" + k);

  await call(zyt, "setMinter", [A.mining], "setMinter");
  await call(zyt, "setPool", [A.pool], "setPool");
  await call(zyt, "setForceSell", [A.forceSell], "setForceSell");
  await call(zyt, "setConfig", [A.config], "zyt.setConfig"); // V6/V7：转账滑点率 + 增发上限
  for (const a of [A.pool, A.mining, A.deflation]) await call(zyt, "setWhiteList", [a, true], "wl:" + a.slice(0, 6));
  // P2-2 白名单保护：营销/技术地址豁免强制卖出初始化
  for (const a of [signer.address, signer.address]) await call(zyt, "setWhiteList", [a, true], "wl:mkt/tech");
  await call(pool, "setMining", [A.mining], "pool.setMining");
  await call(pool, "setDeflation", [A.deflation], "pool.setDeflation");
  await call(referral, "setMining", [A.mining], "ref.setMining");
  await call(mining, "setDeflation", [A.deflation], "mining.setDeflation");

  // 池初始化 + GST 锁定（V5：初始 2.1 万 USDT 真实转入池，保证账面=实际）
  await call(gst, "approve", [A.pool, ethers.parseEther("21000")], "gst.approve");
  await call(usdt, "faucet", [ethers.parseEther("21000")], "usdt.faucet(初始池USDT)");
  await call(usdt, "approve", [A.pool, ethers.parseEther("21000")], "usdt.approve");
  await call(pool, "initialize", [ethers.parseEther("21000"), ethers.parseEther("2100000000")], "pool.initialize");
  await call(gst, "lockRemaining", [], "gst.lock");

  // 阶段门控放宽（本地测试自由买卖）
  await call(config, "setUint", ["poolStage1USDT", 0], "stage1=0");
  await call(config, "setUint", ["poolStage2USDT", 0], "stage2=0");

  console.log("\n===== ADDRESSES =====");
  console.log(JSON.stringify(A, null, 2));
  fs.writeFileSync("deploy-plain.json", JSON.stringify(A, null, 2));
  console.log("saved deploy-plain.json");
}

main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
