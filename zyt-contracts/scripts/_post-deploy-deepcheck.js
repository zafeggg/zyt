/**
 * 部署后深度校验（临时工具，2026-09-26）
 *
 * 用途一：解释 preflight 报的 3 项「字节码与本地编译不一致」
 *   - ZYTLiquidityCreator：4 个 immutable 变量，值在部署时写入 runtime code → 预期差异
 *   - ZYTMining：3 处 library 链接占位符，链上是真实库地址 → 预期差异
 *   - ZYTCompute：library 本体，无 immutable 无链接 → 必须严格一致，否则是真问题
 * 本脚本逐字符 diff，给出不匹配区间的精确位置与长度，用于区分「预期差异」与「真不一致」。
 *
 * 用途二：定位真实部署块，修正 keeper 的 indexerStartBlock
 *
 * 用法：node scripts/_post-deploy-deepcheck.js
 */
const { JsonRpcProvider } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = "https://bsc-mainnet.public.blastapi.io";
const DEPLOYER = "0x65851a66d806d797C25f2B2F0C766e731D70347c";
const ADDR = {
  ZYTConfig: "0x4FEFe79A90Bf7C9BD2699030Ee1ad0360f4B1B22",
  ZYTToken: "0xa64E6ab9A8a61f55eE9B1521312783AE033fd546",
  ZYTLiquidityCreator: "0x41799040658764d91C94AF16b8B461f2fc1A040F",
  ZYTPoolManager: "0x57d8Ec0D9Ef0822dFc5D08Db686D182351580028",
  ZYTReferral: "0x43018AF273296064991c018955c636fB45eB0dad",
  ZYTForceSell: "0xaE0EeD16e6f7ca4736294a6c2E4a5b87d02672C8",
  ZYTMining: "0x0119cf2eac935447f2Dd60C457190fAEa116fd22",
  ZYTDeflation: "0xF44fE232d26F4E845Be75960bc0a65aB12898D73",
  ZYTCompute: "0xf6Cc1617C480D1a412549c8a11618FF30c31f048",
};

/** 读 artifacts 的 deployedBytecode */
function artifactCode(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts");
  const dirs = fs.readdirSync(p);
  for (const d of dirs) {
    const f = path.join(p, d, `${name}.json`);
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      return j.deployedBytecode;
    }
  }
  return null;
}

/** 逐字符 diff，返回不匹配区间（hex 字符索引） */
function diffRanges(a, b) {
  const n = Math.min(a.length, b.length);
  const ranges = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      ranges.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, n - 1]);
  return ranges;
}

(async () => {
  const provider = new JsonRpcProvider(RPC, 56, { staticNetwork: true, timeout: 25000 });

  console.log("═".repeat(78));
  console.log("【一】字节码深度比对（本地 artifacts vs 链上 runtime code）");
  console.log("═".repeat(78));
  for (const [name, addr] of Object.entries(ADDR)) {
    const local = artifactCode(name);
    if (!local) {
      console.log(`${name.padEnd(20)} 无 artifacts，跳过`);
      continue;
    }
    const chain = await provider.getCode(addr);
    const l = local.replace(/^0x/, "");
    const c = chain.replace(/^0x/, "");
    const sameLen = l.length === c.length;

    // 归一化 library 链接占位符（40 hex 字符），使占位符位置不参与判定
    const norm = (s) => s.replace(/__\$[0-9a-fA-F]{34}\$__/g, (m) => "X".repeat(m.length));
    const ln = norm(l);
    const cn = norm(c);
    const ranges = diffRanges(ln, cn);
    const diffChars = ranges.reduce((acc, r) => acc + (r[1] - r[0] + 1), 0);

    console.log(`\n${name}  ${addr}`);
    console.log(`  本地长度 ${l.length} | 链上长度 ${c.length} | ${sameLen ? "长度一致 ✓" : "长度不一致 ✗"}`);
    console.log(`  归一化后不匹配字符数: ${diffChars}（占 ${((diffChars / l.length) * 100).toFixed(2)}%）`);
    if (diffChars > 0) {
      const shown = ranges.slice(0, 8).map((r) => `${r[0]}-${r[1]}(${r[1] - r[0] + 1}字符)`);
      console.log(`  不匹配区间: ${shown.join(", ")}${ranges.length > 8 ? ` …共 ${ranges.length} 段` : ""}`);
      // 展示第一段差异的内容，便于判断是否为 immutable 值
      const r0 = ranges[0];
      console.log(`    本地: ${ln.slice(r0[0], Math.min(r0[1] + 1, r0[0] + 64))}`);
      console.log(`    链上: ${cn.slice(r0[0], Math.min(r0[1] + 1, r0[0] + 64))}`);
    }
  }

  console.log("\n" + "═".repeat(78));
  console.log("【二】定位真实部署块（用于 keeper indexerStartBlock）");
  console.log("═".repeat(78));
  const latest = await provider.getBlockNumber();
  console.log("链头:", latest);
  const FROM = 124123000;
  const TO = 124126500;
  for (const [name, addr] of [["ZYTConfig", ADDR.ZYTConfig], ["ZYTToken", ADDR.ZYTToken]]) {
    try {
      const logs = await provider.getLogs({ address: addr, fromBlock: FROM, toBlock: TO });
      if (!logs.length) {
        console.log(`  ${name}: 区间内无事件`);
        continue;
      }
      const bl = logs.map((x) => x.blockNumber);
      console.log(`  ${name}: ${logs.length} 条事件 | 最早块 ${Math.min(...bl)} | 最晚块 ${Math.max(...bl)}`);
    } catch (e) {
      console.log(`  ${name}: getLogs 失败 - ${String(e.message).slice(0, 80)}`);
    }
  }
  // 事件定位（串行，仅查 2 个合约：并行 getLogs 会触发公共节点限速而挂起）
  console.log("  说明：用 ZYTConfig 的最早事件块反推，部署块 = 最早事件块 − 20");
  let safeStart = Number.MAX_SAFE_INTEGER;
  for (const [name, addr] of [["ZYTConfig", ADDR.ZYTConfig], ["ZYTToken", ADDR.ZYTToken]]) {
    try {
      const logs = await provider.getLogs({ address: addr, fromBlock: FROM, toBlock: TO });
      if (!logs.length) {
        console.log(`  ${name}: 区间内无事件`);
        continue;
      }
      const bl = logs.map((x) => x.blockNumber);
      const mn = Math.min(...bl);
      console.log(`  ${name}: ${logs.length} 条事件 | 最早块 ${mn} | 最晚块 ${Math.max(...bl)}`);
      if (mn < safeStart) safeStart = mn;
    } catch (e) {
      console.log(`  ${name}: getLogs 失败 - ${String(e.message).slice(0, 80)}`);
    }
  }
  if (safeStart !== Number.MAX_SAFE_INTEGER) {
    console.log(`  建议 indexerStartBlock = ${safeStart - 20}（留 20 块重组余量）`);
  } else {
    console.log("  未取到事件，需人工核对部署块");
  }
})().catch((e) => console.log("失败:", String(e.message).slice(0, 200)));
