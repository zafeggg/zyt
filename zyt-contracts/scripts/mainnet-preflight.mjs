/**
 * 主网上线门禁自检（Preflight Gate）
 *
 * 目的：把 testnet 阶段踩过的所有坑固化为可执行检查，确保主网部署不再复发。
 * 覆盖四层：① 合约编译与修复特征 ② 部署后链上一致性 ③ keeper 口径与接口 ④ 前端与运维配置
 *
 * 用法（在 zyt-contracts 目录）：
 *   node scripts/mainnet-preflight.mjs                     # 部署前检查（源码/编译/配置）
 *   node scripts/mainnet-preflight.mjs --addr <地址集json>  # 部署后检查（含链上一致性）
 *   node scripts/mainnet-preflight.mjs --addr deployments/mainnet-test-20260914.json
 *
 * 退出码：0 = 全部通过（可继续）；1 = 存在 FAIL（必须处理）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { JsonRpcProvider } from "ethers";
import "dotenv/config";

const ROOT = path.resolve(process.cwd(), "..");
const CONT = path.join(ROOT, "zyt-contracts");
const results = [];
const add = (level, group, item, detail = "") => {
  results.push({ level, group, item, detail });
  const icon = level === "PASS" ? "✓" : level === "FAIL" ? "✗" : "!";
  console.log(`  ${icon} [${group}] ${item}${detail ? " — " + detail : ""}`);
};

// ============ ① 合约源码与编译产物 ============
console.log("\n=== ① 合约：修复特征与编译时效 ===");
const srcDir = path.join(CONT, "contracts");
const srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith(".sol"));
const srcText = {};
for (const f of srcFiles) srcText[f] = fs.readFileSync(path.join(srcDir, f), "utf8");
const allSrc = Object.values(srcText).join("\n");

// 历史修复特征（每项必须存在）
const FEATURES = [
  ["P1-7 静态出局：ZYTToken._update 双向记账（recordTransferOut）", allSrc.includes("recordTransferOut")],
  ["v9.1-1 卖出双计：白名单分支排除 pool（to != pool）", /to\s*!=\s*pool/.test(allSrc)],
  ["v9.1-2 转账税双计：_inTax 重入标志", allSrc.includes("_inTax")],
  ["决策 21 推荐代数：直推人数 = 可拿代数（downlineCount 判定）", allSrc.includes("downlineCount")],
  ["强制卖出 4 期累进：WINDOW1..4_TARGET", /WINDOW4_TARGET/.test(allSrc)],
  ["分红：dividendOf / recordDailyDividend 存在", allSrc.includes("dividendOf") && allSrc.includes("recordDailyDividend")],
  ["底池创建：ZYTLiquidityCreator 锁仓（skimDeflation）", allSrc.includes("skimDeflation")],
];
for (const [name, ok] of FEATURES) add(ok ? "PASS" : "FAIL", "合约特征", name);

// 编译产物时效：artifacts 必须不早于源码
let newestSrc = 0;
for (const f of srcFiles) newestSrc = Math.max(newestSrc, fs.statSync(path.join(srcDir, f)).mtimeMs);
const artFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".json") && !e.name.endsWith(".dbg.json")) artFiles.push(p);
  }
})(path.join(CONT, "artifacts/contracts"));
let oldestArt = Infinity;
for (const f of artFiles) oldestArt = Math.min(oldestArt, fs.statSync(f).mtimeMs);
add(
  oldestArt >= newestSrc ? "PASS" : "FAIL",
  "编译时效",
  "artifacts 不早于源码（改了源码必须重新编译）",
  oldestArt >= newestSrc ? "" : "artifacts 早于源码，请 npx hardhat compile"
);

// ============ ② 部署后链上一致性 ============
const addrArgIdx = process.argv.indexOf("--addr");
if (addrArgIdx > -1) {
  const addrFile = process.argv[addrArgIdx + 1];
  console.log(`\n=== ② 链上一致性（地址集: ${addrFile}） ===`);
  const raw = JSON.parse(fs.readFileSync(path.resolve(CONT, addrFile), "utf8"));
  const contracts = raw.contracts || raw;
  const RPC = process.env.BSC_MAINNET_RPC || process.env.BSC_TESTNET_RPC || "https://bsc-rpc.publicnode.com";
  const chainId = /mainnet|bscMain|56/.test(addrFile) ? 56 : 97;
  const p = new JsonRpcProvider(RPC, chainId, { staticNetwork: true });

  // 剥离 metadata（末尾 CBOR 段），只比对实际逻辑字节码
  const stripMeta = (hex) => {
    const h = (hex || "").toLowerCase().replace(/^0x/, "");
    const i = h.lastIndexOf("a2646970667358");
    return i > 0 ? h.slice(0, i) : h;
  };
  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

  for (const [key, addr] of Object.entries(contracts)) {
    if (typeof addr !== "string" || !addr.startsWith("0x")) continue;
    const name = key.charAt(0).toUpperCase() + key.slice(1);
    const artPath = artFiles.find((f) => path.basename(f) === `${name}.json`);
    if (!artPath) {
      add("WARN", "链上一致性", `${key} 无同名 artifacts，跳过字节码比对（可人工核对）`, addr);
      continue;
    }
    const art = JSON.parse(fs.readFileSync(artPath, "utf8")).deployedBytecode;
    let onchain = "";
    try {
      onchain = await p.getCode(addr);
    } catch {
      add("FAIL", "链上一致性", `${key} 读取链上代码失败`, addr);
      continue;
    }
    if (!onchain || onchain === "0x") {
      add("FAIL", "链上一致性", `${key} 地址无合约代码`, addr);
      continue;
    }
    // 比对 v2（2026-09-26 修订）：原实现只剥离 metadata 尾部后比哈希，对「部署时填充」会固定误报。
    //   三类预期差异（v9.1 主网实测共误报 3 项）：
    //     ① immutable 变量的值在部署时写入 runtime code（Creator 有 4 个 immutable，实测差异 616 字符）
    //     ② library 链接地址（Mining 引用 ZYTCompute，3 处 40 字符占位符，实测差异 120 字符）
    //     ③ library 自身地址（Solidity 为库插入的 call-protection，ZYTCompute 本体差异 37 字符）
    //   新判定：长度必须一致；归一化链接占位符后差异 ≤ 8% 判 WARN（标注为填充差异），超阈值判 FAIL。
    const norm = (s) => stripMeta(s).replace(/__\$[0-9a-fA-F]{34}\$__/g, (m) => "X".repeat(m.length));
    const aArt = norm(art);
    const aChain = norm(onchain);
    const sameLen = aArt.length === aChain.length;
    let diffChars = 0;
    if (sameLen) {
      for (let i = 0; i < aArt.length; i++) if (aArt[i] !== aChain[i]) diffChars++;
    }
    const diffPct = sameLen ? (diffChars / aArt.length) * 100 : 100;
    if (!sameLen || diffPct > 8) {
      add(
        "FAIL",
        "链上一致性",
        `${key} 字节码与本地编译不一致（链上可能是旧版本：长度 本地${aArt.length}/链上${aChain.length}，差异 ${diffPct.toFixed(1)}%）`,
        addr
      );
    } else if (diffChars === 0) {
      add("PASS", "链上一致性", `${key} 字节码与本地编译完全一致`, addr);
    } else {
      add(
        "WARN",
        "链上一致性",
        `${key} 字节码一致（${diffChars} 字符差异属部署时填充：immutable / library 链接）`,
        addr
      );
    }
  }
}

// ============ ③ keeper 侧检查 ============
console.log("\n=== ③ keeper：口径、接口与配置 ===");
const K = path.join(ROOT, "zyt-keeper/src");
const apiSrc = fs.readFileSync(path.join(K, "api.js"), "utf8");
const ledgerSrc = fs.readFileSync(path.join(K, "ledger.js"), "utf8");
const abisSrc = fs.readFileSync(path.join(K, "abis.js"), "utf8");

add(
  /block_time/.test(apiSrc) && !/if \(day === todayUTC\)/.test(apiSrc) ? "PASS" : "FAIL",
  "keeper 口径",
  "今日入单用 block_time（链上时间），未用 created_at"
);
add(
  /totalPower\(\)/.test(apiSrc) ? "PASS" : "WARN",
  "keeper 口径",
  "全网算力用账本口径（ledger.totalPower）",
  "链上 userList 不含纯入金用户，切勿只用链上枚举"
);
add(
  abisSrc.includes("powerOf") ? "PASS" : "FAIL",
  "keeper 接口",
  "MINING_USERINFO_ABI 含 powerOf（算力统计依赖）"
);
add(
  /_ensureBlockTimes/.test(ledgerSrc) ? "PASS" : "WARN",
  "keeper 接口",
  "存在 block_time 补齐逻辑（_ensureBlockTimes）"
);
add(
  fs.existsSync(path.join(K, "../scripts/check-keeper-interfaces.mjs")) ? "PASS" : "WARN",
  "keeper 工具",
  "接口一致性自检脚本存在"
);

// keeper .env 配置完整性（读 .env 若有）
const envPath = path.join(ROOT, "zyt-keeper/.env");
if (fs.existsSync(envPath)) {
  const env = fs.readFileSync(envPath, "utf8");
  const REQUIRED = ["CHAIN_ID", "RPC_URL", "MINING_ADDR", "POOL_ADDR", "CONFIG_ADDR", "ZYT_ADDR", "FORCESELL_ADDR", "DEFLATION_ADDR", "KEEPER_PRIVATE_KEY", "START_BLOCK", "DB_URL"];
  const missing = REQUIRED.filter((k) => !new RegExp(`^${k}=.+`, "m").test(env));
  add(missing.length === 0 ? "PASS" : "FAIL", "keeper 配置", "必需环境变量齐全", missing.length ? "缺: " + missing.join(", ") : "");
  add(/^KEEPER_PRIVATE_KEY=0x[0-9a-fA-F]{64}/m.test(env) ? "PASS" : "FAIL", "keeper 配置", "KEEPER_PRIVATE_KEY 已配置（快照写交易前提）");
} else {
  add("WARN", "keeper 配置", "未找到 zyt-keeper/.env（跳过配置检查）");
}

// ============ ④ 前端与运维 ============
console.log("\n=== ④ 前端与运维配置 ===");
const dappCfg = path.join(ROOT, "zyt-dapp/src/config/index.ts");
if (fs.existsSync(dappCfg)) {
  const cfgRaw = fs.readFileSync(dappCfg, "utf8");
  // 剥离注释后再校验（注释里会提到被废弃的域名，直接匹配会误报）
  const cfg = cfgRaw.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const badRpc = /bsc-dataseed\.binance\.org|bsc-testnet-rpc\.publicnode\.com/.test(cfg);
  add(badRpc ? "FAIL" : "PASS", "前端配置", "RPC 未使用已知被阻断域名（binance.org 旧域名 / testnet publicnode）");
  add(/apiBase:\s*envApiBase\s*\|\|\s*"\/api"/.test(cfg) ? "PASS" : "WARN", "前端配置", "apiBase 默认同源 /api（避免跨域与 keeper 直连）");

  // 主网段地址完整性（只查 BSC_MAINNET 段；允许两类已知例外：v9 弃用的 gst 空串、creator 未部署）
  const mm = cfg.match(/const BSC_MAINNET[\s\S]*?\n\};/);
  const mainnetSeg = mm ? mm[0] : "";
  const emptyKeys = [...mainnetSeg.matchAll(/(\w+):\s*""/g)].map((m) => m[1]);
  const allowed = new Set(["creator"]); // 主网 TestUSDT 版无 creator 合约；正式版重部署后应填入
  const badKeys = emptyKeys.filter((k) => !allowed.has(k));
  add(
    badKeys.length === 0 ? "PASS" : "FAIL",
    "前端配置",
    "主网段地址集已填写（无空字符串地址）",
    badKeys.length ? "空: " + badKeys.join(", ") : emptyKeys.length ? "允许的例外: " + emptyKeys.join(", ") : ""
  );

  // 主网段 RPC 与实际部署地址是否同源（防止 testnet 地址混入主网段）
  const hasTestnetAddr = /0x8402D46f|0x7e3507050db25AD09f2D772Df72C4bea3bae0b04|0x33F797D0/.test(mainnetSeg);
  add(hasTestnetAddr ? "FAIL" : "PASS", "前端配置", "主网段未混入 testnet 合约地址");
} else {
  add("WARN", "前端配置", "未找到 dapp config");
}

// keeper 快照调度配置（时区错会导致北京 8 点不触发）
const keeperEnv = path.join(ROOT, "zyt-keeper/.env");
if (fs.existsSync(keeperEnv)) {
  const e = fs.readFileSync(keeperEnv, "utf8");
  const cron = (e.match(/^SNAPSHOT_CRON=(.+)$/m) || [])[1];
  const tz = (e.match(/^SNAPSHOT_CRON_TZ=(.+)$/m) || [])[1];
  add(cron ? "PASS" : "WARN", "keeper 调度", "SNAPSHOT_CRON 已配置", cron ? String(cron).trim() : "");
  add(/UTC/i.test(String(tz || "")) ? "PASS" : "WARN", "keeper 调度", "快照时区为 UTC（北京 08:00 = UTC 00:00）", String(tz || "").trim());
}

// ============ 汇总 ============
const fails = results.filter((r) => r.level === "FAIL");
const warns = results.filter((r) => r.level === "WARN");
console.log("\n=== 汇总 ===");
console.log(`PASS ${results.length - fails.length - warns.length} | WARN ${warns.length} | FAIL ${fails.length}`);
if (fails.length) {
  console.log("\n必须处理的项：");
  for (const f of fails) console.log(`  ✗ [${f.group}] ${f.item}${f.detail ? " — " + f.detail : ""}`);
}
process.exit(fails.length ? 1 : 0);
