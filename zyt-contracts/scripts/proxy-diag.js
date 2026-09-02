// 诊断：curl vs undici ProxyAgent 到 api.etherscan.io 的差异
const { ProxyAgent } = require("undici");
const URL_ = "https://api.etherscan.io/v2/api?chainid=97&module=stats&action=supply";
async function main() {
  // 1. 项目 undici 5.29.0 的 fetch + ProxyAgent
  try {
    const agent = new ProxyAgent("http://127.0.0.1:7890");
    const r = await fetch(URL_, { dispatcher: agent });
    const t = await r.text();
    console.log("undici5 fetch+ProxyAgent:", r.status, t.slice(0, 100));
  } catch (e) {
    console.log("undici5 fetch+ProxyAgent FAIL:", e.message, "| cause:", e.cause ? e.cause.message : "");
  }
  // 2. 项目 undici 的 request + ProxyAgent
  try {
    const { request } = require("undici");
    const r = await request(URL_, { dispatcher: new ProxyAgent("http://127.0.0.1:7890") });
    const t = await r.body.text();
    console.log("undici5 request+ProxyAgent:", r.statusCode, t.slice(0, 100));
  } catch (e) {
    console.log("undici5 request+ProxyAgent FAIL:", e.message, "| cause:", e.cause ? e.cause.message : "");
  }
}
main();
