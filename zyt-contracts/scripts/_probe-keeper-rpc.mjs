/**
 * keeper 主网 RPC 探测（临时工具，2026-09-26）
 *
 * 用途：keeper 与「部署脚本」对 RPC 的要求不同，需分别选型。
 *   部署脚本：eth_call / eth_getCode / eth_getTransactionReceipt —— 见 _probe-deploy-rpc.mjs
 *   keeper  ：额外需要 eth_getLogs 拉历史事件（indexer 核心）+ eth_sendRawTransaction（快照）
 *
 * 背景：测试链曾因 publicnode 剪枝（只保留近 5000 块）导致 keeper 漏索引 32 万块，
 *       账本归零。主网选型必须先测清 getLogs 的历史深度与单次区间上限。
 *
 * 用法：node scripts/_probe-keeper-rpc.mjs
 */
const ADDR = "0x4FEFe79A90Bf7C9BD2699030Ee1ad0360f4B1B22"; // ZYTConfig（有 setAddress 事件）
const LATEST_HINT = 124127840; // 参考链头（实测时）
const CAND = [
  "https://bsc-mainnet.public.blastapi.io",
  "https://bsc.blockrazor.xyz",
  "https://1rpc.io/bnb",
  "https://bsc-rpc.publicnode.com",
];
// 区间由小到大：先测单次上限，再测历史深度
const SPANS = [25, 500, 2000, 10000];

const call = async (url, method, params, ms = 12000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.error) return { ok: false, msg: String(j.error.message).slice(0, 52) };
    return { ok: true, result: j.result };
  } catch (e) {
    return { ok: false, msg: String(e.message).slice(0, 40) };
  } finally {
    clearTimeout(t);
  }
};

(async () => {
  for (const url of CAND) {
    console.log("\n" + "═".repeat(72));
    console.log(url);
    // 1) 链头
    const bn = await call(url, "eth_blockNumber", []);
    if (!bn.ok) {
      console.log("  eth_blockNumber 失败:", bn.msg, "→ 节点不可用");
      continue;
    }
    const latest = parseInt(bn.result, 16);
    console.log("  链头:", latest);

    // 2) getLogs 区间上限（近期块，避开剪枝干扰）
    for (const span of SPANS) {
      const from = latest - span + 1;
      const r = await call(url, "eth_getLogs", [{ address: ADDR, fromBlock: "0x" + from.toString(16), toBlock: "0x" + latest.toString(16) }]);
      console.log(`  近期 ${String(span).padStart(5)} 块 getLogs: ${r.ok ? "OK logs=" + r.result.length : "FAIL " + r.msg}`);
    }

    // 3) 历史深度（查部署期区块附近，验证是否会剪枝）
    const histFrom = LATEST_HINT - 3000;
    const r2 = await call(url, "eth_getLogs", [{ address: ADDR, fromBlock: "0x" + histFrom.toString(16), toBlock: "0x" + (histFrom + 25).toString(16) }]);
    console.log(`  历史块 ${histFrom} 附近 25 块: ${r2.ok ? "OK logs=" + r2.result.length : "FAIL " + r2.msg}`);
  }
})();
