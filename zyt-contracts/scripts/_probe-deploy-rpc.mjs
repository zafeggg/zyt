/**
 * 主网部署 RPC 探测（临时工具，2026-09-26）
 * 用途：筛选能完整支撑「部署 + 等待交易确认」全链路的 BSC 主网节点
 *
 * 背景：本次部署连续踩两个节点的坑
 *   - bsc.blockrazor.xyz      → 单请求无响应挂起（undici HeadersTimeoutError）
 *   - bsc-rpc.publicnode.com  → 等待确认时返回 403 "Archive requests require a personal token"
 * 因此需要逐项验证候选节点对各类请求的支持情况。
 *
 * 用法：node scripts/_probe-deploy-rpc.mjs
 */
const TX = "0xe009e9e40adc74e89993a131bac46e12942e4af6cc777b663969834f28b8769d"; // 本次已广播的一笔
const DEPLOYER = "0x65851a66d806d797C25f2B2F0C766e731D70347c";
const CFG = "0x4FEFe79A90Bf7C9BD2699030Ee1ad0360f4B1B22";
const CAND = [
  "https://bsc.blockrazor.xyz",
  "https://bsc.drpc.org",
  "https://bsc-mainnet.public.blastapi.io",
  "https://1rpc.io/bnb",
  "https://rpc.ankr.com/bsc",
  "https://bsc.meowrpc.com",
];

const call = async (url, method, params, ms = 9000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.error) return "ERR:" + String(j.error.message).slice(0, 34);
    return "OK " + (Date.now() - t0) + "ms";
  } catch (e) {
    return "FAIL:" + String(e.message).slice(0, 22);
  } finally {
    clearTimeout(t);
  }
};

(async () => {
  console.log("请求类型对照（receipt = 等待交易确认的关键调用）");
  for (const url of CAND) {
    const [receipt, block, nonce, call2, code] = [
      await call(url, "eth_getTransactionReceipt", [TX]),
      await call(url, "eth_getBlockByNumber", ["latest", false]),
      await call(url, "eth_getTransactionCount", [DEPLOYER, "latest"]),
      await call(url, "eth_call", [{ to: CFG, data: "0x8da5cb5b" }, "latest"]),
      await call(url, "eth_getCode", [CFG, "latest"]),
    ];
    const ok = [receipt, block, nonce, call2, code].every((x) => x.startsWith("OK"));
    console.log(`${ok ? "★" : " "} ${url.padEnd(42)}`);
    console.log(`    receipt=${receipt} | block=${block} | nonce=${nonce} | call=${call2} | code=${code}`);
  }
})();
