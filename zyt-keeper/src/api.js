import http from "node:http";
import { CONFIG } from "./config.js";
import { getDb } from "./db.js";
import { Ledger } from "./ledger.js";
import { JsonRpcProvider, Contract } from "ethers";
import { POOL_VIEW_ABI } from "./abis.js";
import { logRun } from "./alert.js";
import { computeForceSell } from "./forcesell.js";

/**
 * 轻量数据 API（node:http 内置，生产缺口 #6 加固版）：
 * 三层中间件：CORS（可配置来源）→ 限流（按 IP 滑动窗口）→ 路由（管理端点鉴权）
 *
 * GET /health         健康检查（限流豁免，供监控探活）
 * GET /stats          池状态 + 最近快照
 * GET /user/:addr     用户账本
 * GET /power/:addr    用户当前算力
 * GET /records/:addr  用户事件记录
 * GET /reconcile      触发链上对账（管理端点：需 Bearer token 或 ?token=；未配置 token 则禁用）
 */

/**
 * 内存限流器（滑动窗口按 IP）
 * @param {number} limitPerMin 每 IP 每分钟最大请求数
 */
export function createRateLimiter(limitPerMin) {
  const buckets = new Map(); // ip -> { count, resetAt }
  return {
    /**
     * @param {string} ip
     * @returns {{ allowed: boolean, retryAfter: number }}
     */
    check(ip) {
      const now = Date.now();
      let b = buckets.get(ip);
      if (!b || now >= b.resetAt) {
        b = { count: 0, resetAt: now + 60000 };
        buckets.set(ip, b);
      }
      b.count++;
      return { allowed: b.count <= limitPerMin, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
    },
    /** 测试/重置用 */
    reset(ip) {
      buckets.delete(ip);
    },
  };
}

/** 取客户端 IP（透传代理场景优先 x-forwarded-for 首值） */
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

/** CORS 中间件：按 CORS_ORIGIN 配置放行（支持逗号分隔多域名） */
function applyCors(req, res) {
  const origin = CONFIG.api.corsOrigin;
  if (origin !== "*") {
    const allowed = origin.split(",").map((s) => s.trim()).filter(Boolean);
    const reqOrigin = req.headers.origin;
    if (reqOrigin && allowed.includes(reqOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", reqOrigin);
      res.setHeader("Vary", "Origin");
    }
    // 来源不匹配：不放行（浏览器侧跨域请求被拒）
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/** 管理端点鉴权：Bearer token 或 query token；未配置 token = 端点禁用 */
function checkAdmin(req) {
  const token = CONFIG.api.adminToken;
  if (!token) return { ok: false, status: 403, msg: "admin endpoint disabled" };
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const queryToken = new URL(req.url, "http://internal").searchParams.get("token");
  if ((m && m[1] === token) || queryToken === token) return { ok: true };
  return { ok: false, status: 401, msg: "unauthorized" };
}

export function startApi() {
  const provider = new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
  const pool = new Contract(CONFIG.contracts.pool, POOL_VIEW_ABI, provider);
  const zyt = new Contract(CONFIG.contracts.zyt, ["function getUserCount() view returns (uint256)", "function getUserAt(uint256) view returns (address)"], provider);
  const mining = new Contract(CONFIG.contracts.mining, ["function userInfo(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool)"], provider);
  const ledger = new Ledger(provider, { pool, zyt, mining });
  const limiter = createRateLimiter(CONFIG.api.rateLimitPerMin);

  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // 1. CORS
    applyCors(req, res);
    // 2. 预检
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }
    // 3. 限流（/health 豁免：监控探活不能被打挂）
    if (req.method === "GET") {
      const reqPath = new URL(req.url, "http://internal").pathname;
      if (reqPath !== "/health") {
        const ip = clientIp(req);
        const { allowed, retryAfter } = limiter.check(ip);
        if (!allowed) {
          res.statusCode = 429;
          res.setHeader("Retry-After", String(retryAfter));
          res.end(JSON.stringify({ error: "rate limited", retryAfter }));
          return;
        }
      }
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const db = await getDb();
    try {
      if (path === "/health") {
        res.end(JSON.stringify({ ok: true, ts: Date.now() }));
        return;
      }
      if (path === "/stats") {
        const poolRow = await db.get("SELECT * FROM pool_state WHERE id=1");
        const snap = await db.get("SELECT * FROM snapshots ORDER BY day DESC LIMIT 1");
        // v14：统计指标扩展（burned/todayDeposit/networkPower）——burned/today 从 events 聚合（快照表 burned 列未入库）
        const burnedRows = await db.all("SELECT amount FROM events WHERE name='PoolBurned'");
        let burned = 0n;
        for (const r of burnedRows) burned += BigInt(r.amount || "0");
        const todayUTC = new Date().toISOString().slice(0, 10);
        const depRows = await db.all("SELECT amount, created_at FROM events WHERE name='Deposited'");
        let todayDeposit = 0n;
        for (const r of depRows) {
          const ca = String(r.created_at || "");
          if (ca.slice(0, 10) === todayUTC) todayDeposit += BigInt(r.amount || "0");
        }
        // networkPower：遍历链上 userList 用 ledger.powerOf 精确累计（含日复利）
        let networkPower = 0n;
        try {
          const n = Number(await zyt.getUserCount());
          for (let i = 0; i < n; i++) {
            const a = await zyt.getUserAt(i);
            networkPower += await ledger.powerOf(a);
          }
        } catch {
          /* 链上遍历失败返回 0，不阻塞 */
        }
        res.end(
          JSON.stringify({
            pool: poolRow,
            lastSnapshot: snap,
            burned: String(burned),
            todayDeposit: String(todayDeposit),
            networkPower: String(networkPower),
          })
        );
        return;
      }
      if (path.startsWith("/user/")) {
        const addr = path.slice(6).toLowerCase();
        const row = await db.get("SELECT * FROM users WHERE address=?", [addr]);
        const power = row ? await ledger.powerOf(row.address) : 0n;
        res.end(
          JSON.stringify({
            address: addr,
            ...(row || {}),
            power: String(power),
          })
        );
        return;
      }
      if (path.startsWith("/power/")) {
        const addr = path.slice(7).toLowerCase();
        res.end(JSON.stringify({ address: addr, power: String(await ledger.powerOf(addr)) }));
        return;
      }
      if (path.startsWith("/records/")) {
        const addr = path.slice(9).toLowerCase();
        const rows = await db.all(
          "SELECT name, from_addr, to_addr, amount, extra, block, tx_hash FROM events WHERE from_addr=? OR to_addr=? ORDER BY block DESC LIMIT 100",
          [addr, addr]
        );
        res.end(JSON.stringify(rows));
        return;
      }
      if (path.startsWith("/force-sell/")) {
        const addr = path.slice(12).toLowerCase();
        const row = await db.get("SELECT * FROM force_sell WHERE address=?", [addr]);
        if (!row) {
          res.end(JSON.stringify({ address: addr, status: "no-data" }));
          return;
        }
        // 实时重算窗口状态（基于表内快照数据 + 当前时间）
        const cs = computeForceSell(
          BigInt(row.balance || "0"),
          BigInt(row.sold_amount || "0"),
          Number(row.first_receive_at || 0),
          Math.floor(Date.now() / 1000)
        );
        res.end(
          JSON.stringify({
            address: addr,
            status: "ok",
            firstReceiveAt: Number(row.first_receive_at),
            currentWindow: cs.window,
            cumTargetPct: cs.cumBps / 100,
            requiredSell: String(cs.required),
            soldAmount: row.sold_amount,
            balance: row.balance,
            sellCount: Number(row.sell_count),
            atRisk: cs.atRisk,
            progressPct: Math.min(cs.progressBps / 100, 100),
            deadlineSec: cs.deadline,
            updatedAt: Number(row.updated_at),
          })
        );
        return;
      }
      if (path === "/reconcile") {
        // 4. 管理端点鉴权（未配置 token 时整个端点禁用）
        const auth = checkAdmin(req);
        if (!auth.ok) {
          res.statusCode = auth.status;
          res.end(JSON.stringify({ error: auth.msg }));
          return;
        }
        const r = await ledger.reconcile();
        res.end(JSON.stringify({ ok: true, ...r }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.listen(CONFIG.api.port, () => {
    logRun("api", "start", `http://0.0.0.0:${CONFIG.api.port} cors=${CONFIG.api.corsOrigin} rateLimit=${CONFIG.api.rateLimitPerMin}/min adminToken=${CONFIG.api.adminToken ? "set" : "disabled"}`);
  });
}
