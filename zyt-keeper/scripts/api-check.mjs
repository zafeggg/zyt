/**
 * API 加固验证脚本（#6）
 * 主脚本：CORS / 预检 / 管理端点鉴权 / 公开端点 / 限流器单元测试
 * 运行：node scripts/api-check.mjs
 * 注意：动态 import（ESM 顶层 import 提升会让 env 晚于 config 加载）
 */
process.env.DB_URL = ":memory:";
process.env.API_PORT = "8090"; // 独立端口，不影响 8080 运行中的 keeper
process.env.API_ADMIN_TOKEN = "test-secret";
process.env.API_RATE_LIMIT = "100";
process.env.CORS_ORIGIN = "https://zyt.example.com,https://m.zyt.example.com";

const { startApi, createRateLimiter } = await import("../src/api.js");
const { CONFIG } = await import("../src/config.js");

let pass = 0,
  fail = 0;
const check = (n, c, e) => {
  c ? (pass++, console.log("  [PASS] " + n + (e ? " " + e : ""))) : (fail++, console.log("  [FAIL] " + n + (e ? " " + e : "")));
};

startApi();
await new Promise((r) => setTimeout(r, 500)); // 等 listen

const BASE = "http://127.0.0.1:8090";
async function req(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  const body = await r.text();
  return { status: r.status, headers: r.headers, body };
}

console.log("【CORS 可配置】");
{
  // 允许来源（精确匹配）
  let r = await req("/health", { headers: { Origin: "https://zyt.example.com" } });
  check("允许来源放行", r.status === 200 && r.headers.get("access-control-allow-origin") === "https://zyt.example.com");
  // 未允许来源：不放行（无 ACAO 头）
  r = await req("/health", { headers: { Origin: "https://evil.com" } });
  check("未允许来源不放行", r.headers.get("access-control-allow-origin") === null);
  // OPTIONS 预检：204 + 允许 Authorization 头
  r = await req("/reconcile", { method: "OPTIONS", headers: { Origin: "https://m.zyt.example.com" } });
  const h = r.headers.get("access-control-allow-headers") || "";
  check("预检 204 + 允许 Authorization", r.status === 204 && h.includes("Authorization"));
}

console.log("【管理端点鉴权】");
{
  // 无 token → 401
  let r = await req("/reconcile");
  check("无 token 返回 401", r.status === 401, "status=" + r.status);
  // 错误 token → 401
  r = await req("/reconcile", { headers: { Authorization: "Bearer wrong-token" } });
  check("错误 token 返回 401", r.status === 401);
  // 正确 Bearer token → 200（真实对账）
  r = await req("/reconcile", { headers: { Authorization: "Bearer test-secret" } });
  check("正确 Bearer 放行", r.status === 200, "status=" + r.status);
  // query token 也支持
  r = await req("/reconcile?token=test-secret");
  check("query token 放行", r.status === 200);
  // 未配置 token → 端点禁用 403
  const saved = CONFIG.api.adminToken;
  CONFIG.api.adminToken = "";
  r = await req("/reconcile");
  check("未配置 token 端点禁用 403", r.status === 403, "status=" + r.status);
  CONFIG.api.adminToken = saved;
  // 恢复后正常
  r = await req("/reconcile", { headers: { Authorization: "Bearer test-secret" } });
  check("恢复 token 后放行", r.status === 200);
}

console.log("【公开端点无需鉴权】");
{
  const r = await req("/user/0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
  check("/user 公开可访问", r.status === 200);
  const r2 = await req("/stats");
  check("/stats 公开可访问", r2.status === 200);
}

console.log("【限流器单元测试】");
{
  const lim = createRateLimiter(3);
  const ip = "1.2.3.4";
  const a1 = lim.check(ip);
  const a2 = lim.check(ip);
  const a3 = lim.check(ip);
  const a4 = lim.check(ip);
  check("前 3 次放行", a1.allowed && a2.allowed && a3.allowed);
  check("第 4 次被限", !a4.allowed, "retryAfter=" + a4.retryAfter);
  check("不同 IP 互不影响", lim.check("5.6.7.8").allowed === true);
  lim.reset(ip);
  check("窗口重置后可再通过", lim.check(ip).allowed === true);
}

console.log("");
console.log("结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
