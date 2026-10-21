// Config 参数对齐（部署前置 P0 项）
//
// 两种用法：
//   1) 仅 dump 主网旧 Config 全部可读参数（只读，随时可跑）
//        RPC_URL=... OLD_CONFIG=0x.. node scripts/config-diff.mjs
//   2) 部署后对比「旧 Config vs 新 Config」，输出需补写的 setUint/setAddress 命令
//        RPC_URL=... OLD_CONFIG=0x.. NEW_CONFIG=0x.. node scripts/config-diff.mjs
//
// 参数清单以「新合约 artifact 的 ABI」为准（即新源码真实字段集），
// 旧 Config 上不存在的字段会标记为「新增参数」，避免照抄源码导致的字段漂移。
import "dotenv/config";
import { JsonRpcProvider, Contract, formatEther, formatUnits } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART = path.join(ROOT, "artifacts", "contracts", "ZYTConfig.sol", "ZYTConfig.json");
const env = process.env;
const RPC = env.RPC_URL || "http://127.0.0.1:8545";
const CHAIN_ID = Number(env.CHAIN_ID || 56);
const OLD = env.OLD_CONFIG || "";
const NEW = env.NEW_CONFIG || "";

const die = (m) => {
  console.error("✗", m);
  process.exit(1);
};
if (!OLD) die("缺少 OLD_CONFIG");
if (!fs.existsSync(ART)) die(`找不到 artifact：${ART}（先 npx hardhat compile）`);

const abi = JSON.parse(fs.readFileSync(ART, "utf8")).abi;
const params = abi
  .filter(
    (f) =>
      f.type === "function" &&
      f.stateMutability === "view" &&
      f.inputs.length === 0 &&
      f.outputs.length === 1 &&
      ["uint256", "address", "bool", "uint64"].includes(f.outputs[0].type)
  )
  .map((f) => ({ name: f.name, type: f.outputs[0].type }))
  .filter((p) => !["owner", "paused"].includes(p.name)); // 单独处理

// 已知无 setter 的只读量（不参与对齐）
const READONLY = new Set();

const fmt = (type, v) => {
  if (type === "address") return v;
  if (type === "bool") return String(v);
  const n = BigInt(v);
  // 金额类（>1e12）同时显示原始值与 ether 值，避免误读
  return n > 10n ** 12n ? `${n} (${formatEther(n)})` : n.toString();
};

async function main() {
  const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const oldC = new Contract(OLD, abi, provider);
  const newC = NEW ? new Contract(NEW, abi, provider) : null;
  console.log(`RPC: ${RPC}  chainId: ${CHAIN_ID}`);
  console.log(`旧 Config: ${OLD}`);
  if (NEW) console.log(`新 Config: ${NEW}`);
  console.log(`参数项: ${params.length}\n`);

  const same = [];
  const diff = [];
  const added = [];
  const cmds = [];

  for (const p of params) {
    if (READONLY.has(p.name)) continue;
    let ov;
    try {
      ov = await oldC[p.name]();
    } catch {
      added.push(p); // 旧合约无此参数 = 本次新增
      continue;
    }
    if (!newC) continue;
    const nv = await newC[p.name]();
    if (String(ov) === String(nv)) same.push({ ...p, v: ov });
    else {
      diff.push({ ...p, ov, nv });
      cmds.push(
        p.type === "address"
          ? `await newConfig.setAddress("${p.name}", "${ov}");`
          : `await newConfig.setUint("${p.name}", ${BigInt(ov)}n);`
      );
    }
  }

  if (!newC) {
    console.log("=== 旧 Config 现有参数（只读 dump）===");
    for (const p of params) {
      if (READONLY.has(p.name)) continue;
      let v;
      try {
        v = await oldC[p.name]();
      } catch {
        continue;
      }
      console.log(`  ${p.name.padEnd(24)} ${fmt(p.type, v)}`);
    }
    console.log(`\n旧 Config 无、新版本新增的参数（共 ${added.length} 项）：`);
    for (const p of added) console.log(`  + ${p.name}`);
    console.log("\n提示：部署后加 NEW_CONFIG=0x... 再跑一次，即可得到需补写的 setUint/setAddress 清单。");
    return;
  }

  console.log(`=== 一致（${same.length} 项）===`);
  console.log(`=== 不一致（${diff.length} 项，需写入新 Config）===`);
  for (const d of diff) {
    console.log(`  ${d.name.padEnd(24)} 旧=${fmt(d.type, d.ov)}  新=${fmt(d.type, d.nv)}`);
  }
  console.log(`=== 旧版无、需确认是否要设的新参数（${added.length} 项）===`);
  for (const p of added) console.log(`  + ${p.name} (${p.type})`);

  if (cmds.length) {
    console.log("\n=== 可直接粘贴执行的补写命令 ===");
    for (const c of cmds) console.log(c);
  } else {
    console.log("\n✓ 新旧参数完全一致，无需补写");
  }
}

main().catch((e) => die(e.shortMessage || e.message));
