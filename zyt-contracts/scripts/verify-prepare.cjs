/**
 * bscscan 验证载荷生成（2026-09-26）
 *
 * 背景：Etherscan V2 API 对 BSC 收紧了免费层，但「合约验证端点」官方明确豁免、所有链保持免费。
 *       hardhat-verify 走 undici 代理隧道在本机 502，因此改为：本地生成 standard-json 载荷，
 *       用 curl（实测可通代理）直接 POST verifysourcecontract 提交。
 *
 * 本脚本只做「准备」：
 *   输出 verify-json/ 目录：
 *     {Contract}.json     standard-json-input（含全部 23 个源文件 + optimizer 设置 + libraries）
 *     {Contract}.args     构造参数 hex（无 0x 前缀，Etherscan constructorArguements 口径）
 *     manifest.json       顺序清单（verify 依赖顺序：库 → 无依赖 → 多依赖）
 *
 * 用法：node scripts/verify-prepare.cjs
 */
const fs = require("fs");
const path = require("path");
const { AbiCoder } = require("ethers");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "verify-json");

// ---------- 1. 读部署记录 ----------
const record = JSON.parse(
  fs.readFileSync(path.join(ROOT, "deployments", "mainnet-20260926.json"), "utf8")
);
const C = record.contracts;
const BLACK_HOLE = "0x000000000000000000000000000000000000dEaD";

// ---------- 2. 读最新 build-info（standard-json-input 与 solc 版本） ----------
const biDir = path.join(ROOT, "artifacts", "build-info");
const biFile = fs
  .readdirSync(biDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ f, m: fs.statSync(path.join(biDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0].f;
const bi = JSON.parse(fs.readFileSync(path.join(biDir, biFile), "utf8"));
console.log("build-info:", biFile, "| solc:", bi.solcLongVersion);

// ---------- 3. 组装各合约载荷 ----------
// 验证依赖顺序：库 → 无依赖 → 单依赖 → 多依赖（bscscan 需先有依赖源码）
const ORDER = [
  "ZYTCompute",
  "ZYTConfig",
  "ZYTReferral",
  "ZYTToken",
  "ZYTForceSell",
  "ZYTPoolManager",
  "ZYTLiquidityCreator",
  "ZYTMining",
  "ZYTDeflation",
];

/** 构造参数类型表（与 deploy.js constructorArgs 一一对应） */
const TYPES = {
  ZYTCompute: [],
  ZYTConfig: [],
  ZYTReferral: [],
  ZYTToken: ["address"],
  ZYTForceSell: ["address"],
  ZYTPoolManager: ["address", "address", "address"],
  ZYTLiquidityCreator: ["address", "address", "address", "address"],
  ZYTMining: ["address", "address", "address", "address", "address"],
  ZYTDeflation: ["address", "address", "address"],
};

/** 构造参数值表（来自部署记录） */
const VALUES = {
  ZYTToken: [BLACK_HOLE],
  ZYTForceSell: [C.ZYTToken],
  ZYTPoolManager: [C.ZYTConfig, C.ZYTToken, C.USDT],
  ZYTLiquidityCreator: [C.ZYTToken, C.USDT, record.factory, BLACK_HOLE],
  ZYTMining: [C.ZYTConfig, C.ZYTPoolManager, C.ZYTReferral, C.ZYTToken, C.USDT],
  ZYTDeflation: [C.ZYTConfig, C.ZYTPoolManager, C.ZYTMining],
};

// standard-json 的 libraries 设置（ZYTCompute 已在链上，Mining 链接需要）
const input = JSON.parse(JSON.stringify(bi.input));
input.settings.libraries = {
  "contracts/ZYTCompute.sol": { ZYTCompute: C.ZYTCompute },
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const coder = AbiCoder.defaultAbiCoder();
const manifest = [];
for (const name of ORDER) {
  const addr = C[name];
  if (!addr) throw new Error(`部署记录缺少 ${name}`);
  // 载荷：完整 input（Etherscan 接受含多余源文件的 standard-json）
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(input));
  // 构造参数编码（无 0x 前缀）
  const types = TYPES[name] || [];
  const values = VALUES[name] || [];
  const argsHex = types.length
    ? coder.encode(types, values).slice(2)
    : "";
  fs.writeFileSync(path.join(OUT, `${name}.args`), argsHex);
  manifest.push({
    name,
    address: addr,
    contractName: `contracts/${name}.sol:${name}`,
    compilerVersion: `v${bi.solcLongVersion}`,
    argsFile: `${name}.args`,
    jsonFile: `${name}.json`,
  });
  console.log(`  ${name.padEnd(20)} ${addr} | 构造参数 ${argsHex.length / 2} 字节`);
}

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\n载荷已生成到 verify-json/（${manifest.length} 个合约）`);
console.log("下一步：node scripts/verify-submit.cjs 提交验证");
