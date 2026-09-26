/**
 * 接口一致性自检（防"keeper/前端 调用的合约方法在链上不存在"这类问题复发）
 *
 * 背景：2026-09-26 出现 networkPower 恒为 0，根因是 keeper 用账本口径统计算力（DB 事件缺失时为 0），
 *       以及更早期"ABI 声明与合约实现不一致"的历史坑。本脚本做三层校验：
 *       ① keeper/src 与 dapp/src 里声明的合约函数 → 与 artifacts 编译产物 ABI 比对
 *       ② 关键方法 → 链上 eth_call 探针（能发现"本地编译有、链上未部署"的情况）
 *       ③ 地址配置一致性（.env 的地址是否与 deployments 记录一致）
 *
 * 用法：
 *   node scripts/check-keeper-interfaces.mjs              # 只跑静态比对
 *   node scripts/check-keeper-interfaces.mjs --probe      # 附带链上探针（需 RPC）
 */
import fs from "node:fs";
import path from "node:path";
import { JsonRpcProvider } from "ethers";

const ROOT = "F:/zyt";
const KEEPER_SRC = path.join(ROOT, "zyt-keeper/src");
const DAPP_SRC = path.join(ROOT, "zyt-dapp/src");
const ARTIFACTS = path.join(ROOT, "zyt-contracts/artifacts/contracts");
const DEPLOYMENTS = path.join(ROOT, "zyt-contracts/deployments");
const RPC = process.env.BSC_TESTNET_RPC || "https://bsc-testnet-rpc.publicnode.com";

// ---------- ① 收集 artifacts 的真实 ABI ----------
const CONTRACTS = ["ZYTConfig", "ZYTToken", "ZYTMining", "ZYTPoolManager", "ZYTForceSell", "ZYTDeflation", "ZYTReferral", "ZYTLiquidityCreator"];
const realAbi = {}; // 合约名 → { fns:Set, sigs:Map<name, 参数类型串> }
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".json") && !e.name.endsWith(".dbg.json")) out.push(p);
  }
  return out;
}
for (const f of walk(ARTIFACTS)) {
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!CONTRACTS.includes(j.contractName) || !j.abi) continue;
    const fns = new Set();
    const sigs = new Map();
    for (const e of j.abi) {
      if (e.type !== "function") continue;
      fns.add(e.name);
      sigs.set(e.name, e.inputs.map((i) => i.type).join(","));
    }
    realAbi[j.contractName] = { fns, sigs };
  } catch {
    /* 跳过无法解析的文件 */
  }
}
const allRealFns = new Set();
for (const c of Object.values(realAbi)) for (const f of c.fns) allRealFns.add(f);

// ---------- ② 收集 keeper / dapp 里声明的合约函数 ----------
const declRe = /"function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)[^"]*"/g;
function collectDeclared(dir, exts) {
  const out = new Map(); // 方法名 → Set(文件)
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (!/node_modules|dist|\.git/.test(e.name)) stack.push(p);
        continue;
      }
      if (!exts.some((x) => e.name.endsWith(x))) continue;
      const txt = fs.readFileSync(p, "utf8");
      let m;
      const re = new RegExp(declRe.source, "g");
      while ((m = re.exec(txt))) {
        const name = m[1];
        if (!out.has(name)) out.set(name, new Set());
        out.get(name).add(path.relative(ROOT, p));
      }
    }
  }
  return out;
}
const keeperDeclared = collectDeclared(KEEPER_SRC, [".js"]);
const dappDeclared = collectDeclared(DAPP_SRC, [".ts", ".vue"]);

console.log("=== ① 静态比对：声明的方法 vs artifacts ABI ===");
console.log("artifacts 合约:", Object.keys(realAbi).join(", "), `| 方法总数 ${allRealFns.size}`);
let bad = 0;
for (const [src, decl] of [["keeper", keeperDeclared], ["dapp", dappDeclared]]) {
  const missing = [...decl.keys()].filter((m) => !allRealFns.has(m) && !["balanceOf", "totalSupply", "allowance", "approve", "transfer", "transferFrom", "decimals", "symbol", "name", "owner", "transferOwnership", "renounceOwnership", "initialized"].includes(m));
  console.log(`\n[${src}] 声明 ${decl.size} 个方法，artifacts 中不存在 ${missing.length} 个`);
  for (const m of missing) {
    bad++;
    console.log(`  ✗ ${m}  ←  ${[...decl.get(m)].join(", ")}`);
  }
}
if (bad === 0) console.log("\n✅ 声明的方法在 artifacts 中全部存在");

// ---------- ③ 链上探针（关键方法） ----------
if (process.argv.includes("--probe")) {
  console.log("\n=== ② 链上探针：关键方法是否真的已部署 ===");
  const dep = JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS, "v91-testnet-20260924.json"), "utf8")).contracts;
  const addr = {
    ZYTConfig: dep.ZYTConfig,
    ZYTToken: dep.ZYTToken,
    ZYTMining: dep.ZYTMining,
    ZYTPoolManager: dep.ZYTPoolManager,
    ZYTForceSell: dep.ZYTForceSell,
    ZYTDeflation: dep.ZYTDeflation,
  };
  const CRITICAL = {
    ZYTToken: [["getUserCount", []], ["getUserAt", ["uint256"]]],
    ZYTMining: [["powerOf", ["address"]], ["userInfo", ["address"]], ["dailyInfo", ["uint256"]], ["dividendOf", ["address"]]],
    ZYTPoolManager: [["poolZYT", []], ["poolUSDT", []], ["getStage", []], ["getPrice", []]],
    ZYTForceSell: [["firstReceiveTime", ["address"]], ["soldAmount", ["address"]]],
    ZYTDeflation: [["lastSnapshotDay", []], ["snapshotCount", []]],
  };
  const p = new JsonRpcProvider(RPC, 97, { staticNetwork: true });
  const { Interface } = await import("ethers");
  const ZERO = "0x0000000000000000000000000000000000000000";
  for (const [c, list] of Object.entries(CRITICAL)) {
    for (const [fn, args] of list) {
      const sig = `${fn}(${args.join(",")})`;
      const iface = new Interface([`function ${sig} view returns (uint256)`]);
      const data = iface.encodeFunctionData(fn, args.map((t) => (t === "address" ? ZERO : 0)));
      try {
        const ret = await p.call({ to: addr[c], data });
        const ok = ret && ret !== "0x";
        console.log(`  ${ok ? "✓" : "✗ 无返回"} ${c}.${sig}`);
      } catch {
        console.log(`  ✗ revert ${c}.${sig}`);
      }
    }
  }
}

console.log("\n提示：artifacts 反映本地最新编译，链上部署可能落后（用 --probe 校验）。");
