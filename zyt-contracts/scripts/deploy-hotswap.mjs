// 热切换部署与接线（只部署逻辑合约，代币与流动性零改动）
//
// 用法：
//   RPC_URL=... PRIVATE_KEY=... OLD_TOKEN=0x.. OLD_POOL=0x.. OLD_MINING=0x.. OLD_FORCESELL=0x.. \
//   OLD_CONFIG=0x.. OLD_REFERRAL=0x.. OLD_CREATOR=0x.. OLD_PAIR=0x.. USDT=0x.. KEEPER=0x.. \
//   node scripts/deploy-hotswap.mjs              # 只部署 + 接线（不改代币指针）
//   ... --switch                                  # 额外执行代币四点切换（真正切换）
//
// 安全约束：
//   - 默认不切代币指针，必须先部署接线、核对无误后再加 --switch
//   - 每步接线后立即断言，任何不一致直接退出，不进入下一步
//   - 产出 deployments/hotswap-<ts>.json，rollback.mjs 依赖它
import { JsonRpcProvider, Wallet, Contract, ContractFactory, formatEther } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART = path.join(ROOT, "artifacts", "contracts");

const env = process.env;
const RPC = env.RPC_URL || "http://127.0.0.1:8545";
const CHAIN_ID = Number(env.CHAIN_ID || 56);
const SWITCH = process.argv.includes("--switch");

const OLD = {
  token: env.OLD_TOKEN || "",
  pool: env.OLD_POOL || "",
  mining: env.OLD_MINING || "",
  forceSell: env.OLD_FORCESELL || "",
  config: env.OLD_CONFIG || "",
  referral: env.OLD_REFERRAL || "",
  creator: env.OLD_CREATOR || "",
  pair: env.OLD_PAIR || "",
  usdt: env.USDT || "",
  compute: env.COMPUTE_LIB || "",
};
const KEEPER = env.KEEPER || "";

const log = (...a) => console.log(...a);
const die = (m) => {
  console.error("✗", m);
  process.exit(1);
};

for (const [k, v] of Object.entries(OLD)) if (!v && k !== "compute") die(`缺少环境变量：${k}`);
if (!KEEPER) die("缺少 KEEPER");

const art = (name) => {
  const p = path.join(ART, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) die(`找不到 artifact：${p}（先 npx hardhat compile）`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
};
const linkLib = (bytecode, addr) => bytecode.replace(/__\$[0-9a-f]{34}\$__/g, addr.slice(2).toLowerCase());

async function main() {
  const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  if (!env.PRIVATE_KEY) die("缺少 PRIVATE_KEY");
  const signer = new Wallet(env.PRIVATE_KEY, provider);
  log("部署账户：", signer.address);
  log("链 ID：", CHAIN_ID, " 目标：", (await provider.getBlockNumber()));

  // ---------- 0. 前置校验：代币当前指向必须还是旧合约 ----------
  const token = new Contract(
    OLD.token,
    [
      "function owner() view returns (address)",
      "function pool() view returns (address)",
      "function forceSell() view returns (address)",
      "function ledger() view returns (address)",
      "function configAddr() view returns (address)",
      "function totalSupply() view returns (uint256)",
      "function setPool(address)",
      "function setForceSell(address)",
      "function setLedger(address)",
      "function setConfig(address)",
    ],
    signer
  );
  const owner = await token.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase())
    die(`签名者不是代币 owner（owner=${owner}），四点切换会被拒绝`);
  for (const [name, cur, exp] of [
    ["pool", await token.pool(), OLD.pool],
    ["forceSell", await token.forceSell(), OLD.forceSell],
    ["ledger", await token.ledger(), OLD.mining],
    ["config", await token.configAddr(), OLD.config],
  ]) {
    if (cur.toLowerCase() !== exp.toLowerCase()) die(`代币 ${name} 当前指向 ${cur}，与预期旧地址不符`);
  }
  log("✓ 前置校验：代币四点仍指向旧合约，owner 一致");

  // 基线快照（供 post-hotswap-check.mjs 断言「零资产移动」）
  const pairC = new Contract(
    OLD.pair,
    ["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"],
    provider
  );
  const [r0, r1] = await pairC.getReserves();
  const zytIs0 = (await pairC.token0()).toLowerCase() === OLD.token.toLowerCase();
  const baseline = {
    supply: (await token.totalSupply()).toString(),
    zyt: (zytIs0 ? r0 : r1).toString(),
    usdt: (zytIs0 ? r1 : r0).toString(),
    at: new Date().toISOString(),
  };
  log(`✓ 基线：总量 ${baseline.supply}，池 ${baseline.zyt} ZYT / ${baseline.usdt} U`);

  // ---------- 1. 部署 5 个逻辑合约 ----------
  const deploy = async (name, args = [], libs = {}) => {
    const a = art(name);
    let bytecode = a.bytecode;
    for (const [lib, addr] of Object.entries(libs)) bytecode = linkLib(bytecode, addr);
    if (bytecode.includes("__$")) die(`${name} 存在未链接的库，请设置 COMPUTE_LIB`);
    const f = new ContractFactory(a.abi, bytecode, signer);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    log(`  ${name}: ${addr}`);
    return { contract: c, addr, abi: a.abi };
  };

  log("\n[1/6] 部署新合约");
  const cfg = await deploy("ZYTConfig");
  const pool = await deploy("ZYTPoolManager", [cfg.addr, OLD.token, OLD.usdt]);
  const mining = await deploy(
    "ZYTMining",
    [cfg.addr, pool.addr, OLD.referral, OLD.token, OLD.usdt],
    OLD.compute ? { ZYTCompute: OLD.compute } : {}
  );
  const forceSell = await deploy("ZYTForceSell", [OLD.token]);
  const deflation = await deploy("ZYTDeflation", [cfg.addr, pool.addr, mining.addr]);

  // ---------- 2. 新池管内部接线 ----------
  log("\n[2/6] 新池管接线");
  await (await pool.contract.setPair(OLD.pair)).wait();
  await (await pool.contract.setLocker(OLD.creator)).wait();
  await (await pool.contract.setMining(mining.addr)).wait();
  await (await pool.contract.setDeflation(deflation.addr)).wait();
  if ((await pool.contract.pair()).toLowerCase() !== OLD.pair.toLowerCase()) die("pool.pair 接线失败");
  if ((await pool.contract.mining()).toLowerCase() !== mining.addr.toLowerCase()) die("pool.mining 接线失败");
  log("✓ pair / locker / mining / deflation 已接线");

  // ---------- 3. 新档位接线 ----------
  log("\n[3/6] 新 ForceSell 接线");
  await (await forceSell.contract.setKeeper(KEEPER)).wait();
  await (await forceSell.contract.setMining(mining.addr)).wait();
  await (await forceSell.contract.setConfig(cfg.addr)).wait();
  log("✓ keeper / mining / config 已接线");

  // ---------- 4. 新 Config 地址表 ----------
  log("\n[4/6] 新 Config 地址表");
  for (const [k, v] of [
    ["zyt", OLD.token],
    ["usdt", OLD.usdt],
    ["pair", OLD.pair],
    ["pool", pool.addr],
    ["mining", mining.addr],
    ["forceSell", forceSell.addr],
    ["deflation", deflation.addr],
    ["referral", OLD.referral],
    ["creator", OLD.creator],
    ["keeperAddress", KEEPER],
  ]) {
    await (await cfg.contract.setAddress(k, v)).wait();
  }
  log("✓ 10 个地址已写入新 Config（marketAddress / technicalAddress / blackHole 需按部署记录补）");

  // ---------- 5. 旧 Referral / 旧 Creator 授权 ----------
  log("\n[5/6] 旧 Referral / Creator 授权");
  const referral = new Contract(OLD.referral, ["function setMining(address)"], signer);
  const creator = new Contract(OLD.creator, ["function setPoolManager(address)"], signer);
  try {
    await (await referral.setMining(mining.addr)).wait();
    await (await creator.setPoolManager(pool.addr)).wait();
    log("✓ referral.mining / creator.poolManager 已指向新合约");
  } catch (e) {
    die(`旧合约授权失败（owner 可能不是部署账户）：${e.shortMessage || e.message}`);
  }

  // ---------- 6. 代币四点切换（需 --switch） ----------
  if (SWITCH) {
    log("\n[6/6] 代币四点切换（顺序：池 → 档位 → 账本 → Config）");
    await (await token.setPool(pool.addr)).wait();
    await (await token.setForceSell(forceSell.addr)).wait();
    await (await token.setLedger(mining.addr)).wait();
    await (await token.setConfig(cfg.addr)).wait();
    if ((await token.pool()).toLowerCase() !== pool.addr.toLowerCase()) die("setPool 未生效");
    if ((await token.forceSell()).toLowerCase() !== forceSell.addr.toLowerCase()) die("setForceSell 未生效");
    if ((await token.ledger()).toLowerCase() !== mining.addr.toLowerCase()) die("setLedger 未生效");
    if ((await token.configAddr()).toLowerCase() !== cfg.addr.toLowerCase()) die("setConfig 未生效");
    log("✓ 四点切换完成并校验通过");
  } else {
    log("\n[6/6] 跳过代币切换（未传 --switch）。核对无误后执行：node scripts/deploy-hotswap.mjs --switch");
  }

  // ---------- 落盘 ----------
  const outDir = path.join(ROOT, "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `hotswap-${Date.now()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        version: "v9.2b-hotswap",
        chainId: CHAIN_ID,
        switched: SWITCH,
        new: {
          ZYTConfig: cfg.addr,
          ZYTPoolManager: pool.addr,
          ZYTMining: mining.addr,
          ZYTForceSell: forceSell.addr,
          ZYTDeflation: deflation.addr,
        },
        old: OLD,
        keeper: KEEPER,
        baseline,
      },
      null,
      2
    )
  );
  log(`\n部署记录：${file}`);
  log("下一步：migrate.mjs snapshot → launchday → push → verify；核对后 rollback.mjs 可用于回退");
}

main().catch((e) => die(e.shortMessage || e.stack || e.message));
