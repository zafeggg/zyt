/**
 * BSC RPC 可用性探测：检查各公共节点对「历史日志 eth_getLogs」的支持
 * 用途：keeper indexer 需要拉取历史事件，部分免费节点（如 publicnode）对 archive 请求返回 403
 * 用法：node scripts/rpc-probe.mjs [合约地址] [参照区块号]
 *   默认：试运行版 ZYTMining 地址 + 部署区块 121785500
 */
const CANDIDATES = [
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.defibit.io",
  "https://binance.llamarpc.com",
  "https://rpc.ankr.com/bsc",
  "https://bsc.blockrazor.xyz",
  "https://1rpc.io/bnb",
  "https://bsc.drpc.org",
  "https://bsc-mainnet.public.blastapi.io",
  "https://bsc.publicnode.com",
  "https://bsc-rpc.publicnode.com",
];

const ADDR = process.argv[2] || "0xFC97Bf17243C2ef9A8442c190A1897B61745C830";
const BASE_BLOCK = Number(process.argv[3] || 121785500);
const hex = (n) => "0x" + n.toString(16);

/** 探测单个 RPC 在指定区块深度下的 eth_getLogs 支持 */
async function probe(rpc, fromBlock, span) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getLogs",
    params: [{ fromBlock: hex(fromBlock), toBlock: hex(fromBlock + span), address: ADDR }],
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  const t0 = Date.now();
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    const json = await res.json();
    const ms = Date.now() - t0;
    if (Array.isArray(json.result)) return { ok: true, note: `logs=${json.result.length}`, ms };
    const msg = JSON.stringify(json.error || json).slice(0, 90);
    return { ok: false, note: msg, ms };
  } catch (e) {
    return { ok: false, note: String(e.message).slice(0, 70), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log(`探测地址: ${ADDR}`);
  // 深度 1：老区块（约 20 万块前，需 archive 能力）
  // 深度 2：近期区块（约 1000 块前，普通节点即可）
  let latest = BASE_BLOCK + 200000;
  try {
    const r = await fetch(CANDIDATES[0], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    latest = parseInt((await r.json()).result, 16);
  } catch { /* 用默认值 */ }
  const recent = latest - 1000;
  console.log(`参照区块: 历史=${BASE_BLOCK} / 近期=${recent}（latest≈${latest}）\n`);

  console.log("RPC".padEnd(46) + "历史日志".padEnd(34) + "近期日志");
  for (const rpc of CANDIDATES) {
    const [oldR, newR] = [await probe(rpc, BASE_BLOCK, 100), await probe(rpc, recent, 100)];
    const fmt = (r) => (r.ok ? "OK " + r.note : "FAIL " + r.note).slice(0, 32).padEnd(34);
    console.log(rpc.padEnd(46) + fmt(oldR) + (newR.ok ? "OK " + newR.note : "FAIL " + newR.note).slice(0, 32) + ` [${newR.ms}ms]`);
  }
})();
