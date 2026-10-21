// 热切换上线自检（部署后 / 切指针后均可跑）
//
// 用法：
//   RPC_URL=... HOTSWAP_FILE=deployments/hotswap-xxx.json node scripts/post-hotswap-check.mjs
//
// 断言四组（任一失败退出码 1，可直接用于部署门禁）：
//   A 零资产移动：总量与池储备与基线完全一致
//   B 四点指向：已切换时必须全部指向新合约；未切换时必须仍指向旧合约
//   C 新合约参数：21 亿上限、dynamicPlayingMul=3、滑点基准 21000U 与四档 20/60/120/240、卖币档位 2000/1000/200/6000
//   D 接线完整性：新池管 pair/locker/mining/deflation、新档位 keeper/mining/config、新 Mining launchDay 非 0
import { JsonRpcProvider, Contract, formatEther } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const RPC = env.RPC_URL || "http://127.0.0.1:8545";
const CHAIN_ID = Number(env.CHAIN_ID || 56);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`✓ ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    fail++;
    console.error(`✗ ${name}${detail ? `  (${detail})` : ""}`);
  }
};
const eq = (name, actual, expect, fmt = (v) => String(v)) =>
  ok(name, String(actual).toLowerCase() === String(expect).toLowerCase(), `实际 ${fmt(actual)}`);

function loadRecord() {
  const f = env.HOTSWAP_FILE;
  const dir = path.join(ROOT, "deployments");
  const p = f
    ? path.isAbsolute(f)
      ? f
      : path.join(ROOT, f)
    : path.join(dir, fs.readdirSync(dir).filter((n) => n.startsWith("hotswap-")).sort().pop());
  if (!fs.existsSync(p)) {
    console.error("✗ 找不到部署记录，请用 HOTSWAP_FILE 指定");
    process.exit(1);
  }
  console.log(`记录：${p}\n`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const TOKEN_ABI = [
  "function owner() view returns (address)",
  "function pool() view returns (address)",
  "function forceSell() view returns (address)",
  "function ledger() view returns (address)",
  "function configAddr() view returns (address)",
  "function totalSupply() view returns (uint256)",
];
const POOL_ABI = [
  "function pair() view returns (address)",
  "function locker() view returns (address)",
  "function mining() view returns (address)",
  "function deflation() view returns (address)",
  "function getCurrentSlippage() view returns (uint256)",
  "function dividendPoolZyt() view returns (uint256)",
];
const PAIR_ABI = ["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"];
const CONFIG_ABI = [
  "function zytMaxSupply() view returns (uint256)",
  "function totalSupplyCap() view returns (uint256)",
  "function dynamicPlayingMul() view returns (uint256)",
  "function slippageDropBase() view returns (uint256)",
  "function slippageDropBps1() view returns (uint256)",
  "function slippageDropBps2() view returns (uint256)",
  "function slippageDropBps3() view returns (uint256)",
  "function slippageDropBps4() view returns (uint256)",
  "function tierFirstBps() view returns (uint256)",
  "function tierStepBps() view returns (uint256)",
  "function tierAfter60Bps() view returns (uint256)",
  "function tier60Bps() view returns (uint256)",
  "function paused() view returns (bool)",
];
const FS_ABI = ["function keeper() view returns (address)", "function mining() view returns (address)", "function config() view returns (address)"];
const MINING_ABI = ["function launchDay() view returns (uint64)", "function config() view returns (address)"];

async function main() {
  const rec = loadRecord();
  const OLD = rec.old || {};
  const NEW = rec.new || {};
  const baseline = rec.baseline || null;
  const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const token = new Contract(OLD.token, TOKEN_ABI, provider);

  console.log("=== A. 零资产移动 ===");
  if (!baseline) {
    console.log("… 记录中无 baseline（旧版脚本产出），跳过资产基线比对");
  } else {
    eq("总供应不变", (await token.totalSupply()).toString(), baseline.supply);
    const pair = new Contract(OLD.pair, PAIR_ABI, provider);
    const [r0, r1] = await pair.getReserves();
    const zytIs0 = (await pair.token0()).toLowerCase() === OLD.token.toLowerCase();
    eq("池 ZYT 不变", (zytIs0 ? r0 : r1).toString(), baseline.zyt);
    eq("池 USDT 不变", (zytIs0 ? r1 : r0).toString(), baseline.usdt);
    console.log(`  （基线：${formatEther(baseline.zyt)} ZYT / ${formatEther(baseline.usdt)} U）`);
  }

  console.log("\n=== B. 四点指向 ===");
  const cur = {
    pool: await token.pool(),
    forceSell: await token.forceSell(),
    ledger: await token.ledger(),
    config: await token.configAddr(),
  };
  const wantNew = rec.switched === true;
  const pairs = [
    ["pool", NEW.ZYTPoolManager, OLD.pool],
    ["forceSell", NEW.ZYTForceSell, OLD.forceSell],
    ["ledger", NEW.ZYTMining, OLD.mining],
    ["config", NEW.ZYTConfig, OLD.config],
  ];
  for (const [k, newAddr, oldAddr] of pairs) {
    eq(`token.${k} → ${wantNew ? "新合约" : "旧合约"}`, cur[k], wantNew ? newAddr : oldAddr);
  }
  if (wantNew) {
    const cfg = new Contract(NEW.ZYTConfig, CONFIG_ABI, provider);
    ok("新 Config 已 unpause", (await cfg.paused()) === false);
  }

  console.log("\n=== C. 新合约参数 ===");
  const cfg = new Contract(NEW.ZYTConfig, CONFIG_ABI, provider);
  eq("zytMaxSupply = 21 亿", formatEther(await cfg.zytMaxSupply()), "2100000000.0");
  eq("totalSupplyCap = 21 亿", formatEther(await cfg.totalSupplyCap()), "2100000000.0");
  eq("dynamicPlayingMul = 3", (await cfg.dynamicPlayingMul()).toString(), "3");
  eq("slippageDropBase = 21000 U", formatEther(await cfg.slippageDropBase()), "21000.0");
  const drops = await Promise.all([1, 2, 3, 4].map((i) => cfg[`slippageDropBps${i}`]()));
  eq("四档减少% = 20/60/120/240", drops.map(String).join(","), "20,60,120,240");
  const tiers = await Promise.all([cfg.tierFirstBps(), cfg.tierStepBps(), cfg.tierAfter60Bps(), cfg.tier60Bps()]);
  eq("卖币档位 = 2000/1000/200/6000", tiers.map(String).join(","), "2000,1000,200,6000");

  console.log("\n=== D. 接线完整性 ===");
  const pool = new Contract(NEW.ZYTPoolManager, POOL_ABI, provider);
  eq("新池管 pair = 旧 pair", await pool.pair(), OLD.pair);
  eq("新池管 locker = 旧 Creator", await pool.locker(), OLD.creator);
  eq("新池管 mining = 新 Mining", await pool.mining(), NEW.ZYTMining);
  eq("新池管 deflation = 新 Deflation", await pool.deflation(), NEW.ZYTDeflation);
  const fsC = new Contract(NEW.ZYTForceSell, FS_ABI, provider);
  ok("新档位 keeper 已设置", (await fsC.keeper()) !== "0x0000000000000000000000000000000000000000");
  eq("新档位 mining = 新 Mining", await fsC.mining(), NEW.ZYTMining);
  eq("新档位 config = 新 Config", await fsC.config(), NEW.ZYTConfig);
  const mining = new Contract(NEW.ZYTMining, MINING_ABI, provider);
  ok("新 Mining launchDay 已继承", (await mining.launchDay()) > 0n, String(await mining.launchDay()));
  eq("新 Mining config = 新 Config", await mining.config(), NEW.ZYTConfig);

  console.log("\n=== E. 运行态参考 ===");
  console.log(`当日滑点档位：${await pool.getCurrentSlippage()} bps（0 表示尚未定档，回退基础 5%）`);
  console.log(`新池分红池：${formatEther(await pool.dividendPoolZyt())} ZYT（需 ≥ snapshot 的 totalPendingDividend）`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("✗", e.shortMessage || e.message);
  process.exit(1);
});
