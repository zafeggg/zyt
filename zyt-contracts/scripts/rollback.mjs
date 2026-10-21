// 热切换回退：把代币四点与 Referral / Creator 授权改回旧地址
//
// 用法：
//   RPC_URL=... PRIVATE_KEY=... ROLLBACK_FILE=deployments/hotswap-xxx.json \
//     node scripts/rollback.mjs --dry-run     # 只打印将执行的步骤
//   ...                                        # 不带 --dry-run 即真实发送
//
// 可回退边界（务必确认）：
//   · 只切了指针、未恢复交易 → 随时可回退，旧合约状态从未被写入
//   · 已恢复交易且有成交 → 不能回退（价格/持仓已变），只能向前修复
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const RPC = env.RPC_URL || "http://127.0.0.1:8545";
const CHAIN_ID = Number(env.CHAIN_ID || 56);
const DRY = process.argv.includes("--dry-run");

const log = (...a) => console.log(...a);
const die = (m) => {
  console.error("✗", m);
  process.exit(1);
};

function pickRecord() {
  const f = env.ROLLBACK_FILE;
  if (f) {
    const p = path.isAbsolute(f) ? f : path.join(ROOT, f);
    if (!fs.existsSync(p)) die(`找不到回退记录：${p}`);
    return { file: p, rec: JSON.parse(fs.readFileSync(p, "utf8")) };
  }
  const dir = path.join(ROOT, "deployments");
  if (!fs.existsSync(dir)) die("deployments 目录不存在，请用 ROLLBACK_FILE 指定");
  const cands = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith("hotswap-") && n.endsWith(".json"))
    .sort()
    .reverse();
  if (!cands.length) die("未找到 hotswap-*.json，请用 ROLLBACK_FILE 指定");
  const p = path.join(dir, cands[0]);
  return { file: p, rec: JSON.parse(fs.readFileSync(p, "utf8")) };
}

const TOKEN_ABI = [
  "function owner() view returns (address)",
  "function pool() view returns (address)",
  "function forceSell() view returns (address)",
  "function ledger() view returns (address)",
  "function configAddr() view returns (address)",
  "function setPool(address)",
  "function setForceSell(address)",
  "function setLedger(address)",
  "function setConfig(address)",
];
const POOL_ABI = ["function pair() view returns (address)", "function dividendPoolZyt() view returns (uint256)"];
const PAIR_ABI = ["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"];

async function main() {
  const { file, rec } = pickRecord();
  const OLD = rec.old || {};
  const NEW = rec.new || {};
  log(`回退记录：${file}`);
  log(`模式：${DRY ? "dry-run（不发送交易）" : "真实执行"}`);

  const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  if (!env.PRIVATE_KEY) die("缺少 PRIVATE_KEY");
  const signer = new Wallet(env.PRIVATE_KEY, provider);

  const token = new Contract(OLD.token, TOKEN_ABI, signer);
  const owner = await token.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase())
    die(`签名者不是代币 owner（owner=${owner}），无法回退`);

  // 现状核对：只有在"已切到新合约"时才需要回退
  const cur = {
    pool: (await token.pool()).toLowerCase(),
    forceSell: (await token.forceSell()).toLowerCase(),
    ledger: (await token.ledger()).toLowerCase(),
    config: (await token.configAddr()).toLowerCase(),
  };
  const isNew =
    cur.pool === String(NEW.ZYTPoolManager || "").toLowerCase() &&
    cur.forceSell === String(NEW.ZYTForceSell || "").toLowerCase() &&
    cur.ledger === String(NEW.ZYTMining || "").toLowerCase();
  if (!isNew) {
    log("⚠ 代币当前并未指向本次部署的新合约，可能已回退或指向其它版本：");
    log("  pool      =", cur.pool);
    log("  forceSell =", cur.forceSell);
    log("  ledger    =", cur.ledger);
    log("如需强制回退到记录中的旧地址，加 --force 后再跑（默认停止）");
    if (!process.argv.includes("--force")) return;
  }

  // 资产侧只读核对：回退不涉及任何资金动作，此处仅记录以便人工比对
  const pair = new Contract(OLD.pair, PAIR_ABI, provider);
  const r = await pair.getReserves();
  const zytIs0 = (await pair.token0()).toLowerCase() === OLD.token.toLowerCase();
  log(
    `池储备（只读）：${zytIs0 ? r[0] : r[1]} ZYT / ${zytIs0 ? r[1] : r[0]} U`
  );
  if (NEW.ZYTPoolManager) {
    const p = new Contract(NEW.ZYTPoolManager, POOL_ABI, provider);
    try {
      log(`新池管分红池（应已 seedDividend 补足）：${await p.dividendPoolZyt()}`);
    } catch {
      /* 旧记录里可能没有新池管 */
    }
  }

  // 回退顺序与切换严格相反：Config → 账本 → 档位 → 池（避免 hook 打到空池）
  const steps = [
    ["token.setConfig(旧)", () => token.setConfig(OLD.config)],
    ["token.setLedger(旧)", () => token.setLedger(OLD.mining)],
    ["token.setForceSell(旧)", () => token.setForceSell(OLD.forceSell)],
    ["token.setPool(旧)", () => token.setPool(OLD.pool)],
    [
      "referral.setMining(旧)",
      () => new Contract(OLD.referral, ["function setMining(address)"], signer).setMining(OLD.mining),
    ],
    [
      "creator.setPoolManager(旧)",
      () => new Contract(OLD.creator, ["function setPoolManager(address)"], signer).setPoolManager(OLD.pool),
    ],
    [
      "旧 Config.unpause()",
      () => new Contract(OLD.config, ["function unpause()"], signer).unpause(),
    ],
  ];

  for (const [name, run] of steps) {
    if (DRY) {
      log(`[dry-run] ${name}`);
      continue;
    }
    log(`→ ${name}`);
    const tx = await run();
    await tx.wait();
  }

  if (DRY) {
    log("\n[dry-run] 未发送任何交易。去掉 --dry-run 即真实回退。");
    return;
  }

  // 回退后断言
  const after = {
    pool: (await token.pool()).toLowerCase(),
    forceSell: (await token.forceSell()).toLowerCase(),
    ledger: (await token.ledger()).toLowerCase(),
    config: (await token.configAddr()).toLowerCase(),
  };
  for (const [k, exp] of [
    ["pool", OLD.pool],
    ["forceSell", OLD.forceSell],
    ["ledger", OLD.mining],
    ["config", OLD.config],
  ]) {
    if (after[k] !== String(exp).toLowerCase()) die(`回退后 ${k} 仍为 ${after[k]}`);
  }
  log("✓ 四点已回退到旧合约");
  log("⚠ 还需要人工：keeper 地址与前端地址改回旧值；旧 Config 的 pause 状态确认已解除");
}

main().catch((e) => die(e.shortMessage || e.stack || e.message));
