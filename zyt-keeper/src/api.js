import http from "node:http";
import { CONFIG } from "./config.js";
import { getDb } from "./db.js";
import { Ledger } from "./ledger.js";
import { JsonRpcProvider, Contract } from "ethers";
import { POOL_VIEW_ABI, CREATOR_VIEW_ABI, MINING_USERINFO_ABI } from "./abis.js";
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

let npCache = { at: 0, value: "" };
/** v9：Creator（锁仓合约）累计数据缓存（60s；未接线或读取失败为 null） */
let creatorCache = { at: 0, value: null };

/**
 * v9：读取锁仓合约累计数据（初始建池 + 每日通缩报销）。
 * - CREATOR_ADDR 未配置或读取失败 → null（前端展示 -- ，不以 0 冒充）
 * - 60s 缓存，避免每次 /stats 都打 5 个 RPC 调用
 */
async function readCreator(creator) {
  if (Date.now() - creatorCache.at <= 60_000) return creatorCache.value;
  let value = null;
  if (creator) {
    try {
      const [locked, zytSeeded, usdtSeeded, deflZyt, deflUsdt] = await Promise.all([
        creator.lockedLiquidity(),
        creator.totalZytSeeded(),
        creator.totalUsdtSeeded(),
        creator.totalDeflationZytOut(),
        creator.totalDeflationUsdtOut(),
      ]);
      value = {
        lockedLiquidity: String(locked),
        totalZytSeeded: String(zytSeeded),
        totalUsdtSeeded: String(usdtSeeded),
        totalDeflationZytOut: String(deflZyt),
        totalDeflationUsdtOut: String(deflUsdt),
      };
    } catch {
      value = null; // 下一轮重试
    }
  }
  creatorCache = { at: Date.now(), value };
  return value;
}

export function startApi() {
  const provider = new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
  const pool = new Contract(CONFIG.contracts.pool, POOL_VIEW_ABI, provider);
  const zyt = new Contract(CONFIG.contracts.zyt, ["function getUserCount() view returns (uint256)", "function getUserAt(uint256) view returns (address)", "function totalSupply() view returns (uint256)"], provider);
  const mining = new Contract(CONFIG.contracts.mining, MINING_USERINFO_ABI, provider);
  // v9.1：config 实例（/stats 读 zytMaxSupply 计算累计销毁 = 上限 − 现存）
  const config = new Contract(
    CONFIG.contracts.config,
    ["function zytMaxSupply() view returns (uint256)"],
    provider
  );
  // v17：底池创建合约（未配置地址时为 null，/stats 的 creator 字段返回 null）
  const creator = CONFIG.contracts.creator ? new Contract(CONFIG.contracts.creator, CREATOR_VIEW_ABI, provider) : null;
  const ledger = new Ledger(provider, { pool, zyt, mining });
  /** v9.1：分红预估缓存（30s；键=地址，防前端轮询打爆公共 RPC） */
  const divCache = new Map();
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
        // v9.1：burned 改链上直读（上限 − 现存 = 累计销毁），不再依赖 Deflated 事件聚合
        // 原因：公共 RPC（publicnode/官方）对老区块 getLogs 剪枝，历史事件会丢失导致 burned 恒为 0
        let burned = "0";
        let lpBurned = "0";
        try {
          const [cap, supply, lpB] = await Promise.all([
            config.zytMaxSupply(),
            zyt.totalSupply(),
            pool.totalLpBurned(),
          ]);
          burned = (BigInt(cap) - BigInt(supply)).toString();
          lpBurned = lpB.toString();
        } catch {
          burned = "0";
          lpBurned = "0";
        }
        const todayUTC = new Date().toISOString().slice(0, 10);
        const depRows = await db.all("SELECT amount, created_at FROM events WHERE name='Deposited'");
        let todayDeposit = 0n;
        for (const r of depRows) {
          const ca = String(r.created_at || "");
          // created_at 兼容两种存储：unix 秒（数值）→ 转 ISO 日期；ISO 字符串 → 直接取前 10 位
          // （2026-09-24 修复：原实现对 unix 秒直接 slice，恒不等于 YYYY-MM-DD，todayDeposit 恒为 0）
          const day = ca.includes("-")
            ? ca.slice(0, 10)
            : new Date(Number(ca) * 1000).toISOString().slice(0, 10);
          if (day === todayUTC) todayDeposit += BigInt(r.amount || "0");
        }
        // networkPower：全网算力 = Σ 链上 mining.powerOf（权威值，含日复利 1%）
        // v19 修复：链上 userList（zyt.getUserCount/getUserAt）完全可信，但必须用「链上 powerOf」
        //   而非「账本 ledger.powerOf」——后者依赖 DB 事件索引，历史事件缺失时恒为 0（服务器曾出现 100% 不一致）
        //   每个地址独立 try/catch：pair 等非用户地址（power=0）或个别 RPC 抖动不影响整体
        let networkPower;
        if (Date.now() - (npCache.at || 0) > 60_000) {
          try {
            const n = Number(await zyt.getUserCount());
            let sum = 0n;
            for (let i = 0; i < n; i++) {
              const a = await zyt.getUserAt(i);
              try {
                sum += BigInt(await mining.powerOf(a));
              } catch {
                /* 单地址读取失败（如已出局/非用户地址）：跳过，不影响总和 */
              }
            }
            npCache.value = String(sum);
            npCache.at = Date.now();
          } catch {
            /* 链上遍历整体失败：沿用旧缓存 */
          }
        }
        networkPower = npCache.value || "0";
        // v17：底池创建累计（未接线 → null）
        const creatorData = await readCreator(creator);
        res.end(
          JSON.stringify({
            pool: poolRow,
            lastSnapshot: snap,
            burned: String(burned),
            lpBurned: String(lpBurned ?? "0"),
            todayDeposit: String(todayDeposit),
            networkPower: String(networkPower),
            creator: creatorData,
          })
        );
        return;
      }
      if (path.startsWith("/user/")) {
        const addr = path.slice(6).toLowerCase();
        const row = await db.get("SELECT * FROM users WHERE address=?", [addr]);
        const power = row ? await ledger.powerOf(row.address) : 0n;
        // 2026-09-24：补充买入额度（userInfo[5] = buyQuota - buyUsed，前端 QuotaCard 展示）
        // users 表无买额列（买额纯链上状态），失败回退空串由前端显示 --
        // 同批补充：静态出局线 withdraw_cap = depositTotal×2 + 受赠（transferValueOf 链上口径）
        let buyQuotaLeft = "";
        let withdrawCap = "";
        try {
          const info = await mining.userInfo(addr);
          buyQuotaLeft = info[5]?.toString() ?? "";
        } catch {
          buyQuotaLeft = "";
        }
        try {
          const tv = await mining.transferValueOf(addr);
          withdrawCap = tv[1]?.toString() ?? "";
        } catch {
          withdrawCap = "";
        }
        res.end(
          JSON.stringify({
            address: addr,
            ...(row || {}),
            power: String(power),
            buy_quota_left: buyQuotaLeft,
            withdraw_cap: withdrawCap,
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
        // tx_hash AS hash：前端 KeeperRecord 读 hash 字段；created_at 兜底行时间
        const rows = await db.all(
          "SELECT name, from_addr, to_addr, amount, extra, block, tx_hash AS hash, created_at FROM events WHERE from_addr=? OR to_addr=? ORDER BY block DESC LIMIT 100",
          [addr, addr]
        );
        res.end(JSON.stringify(rows));
        return;
      }
      if (path.startsWith("/dividend/")) {
        const addr = path.slice(10).toLowerCase();
        // 2026-09-25：分红预估（与合约 _settleDividend 同公式，链下预演，含今日待结算）
        // - claimable：链上 pendingDividend（已结算未提取）
        // - settleable：游标..昨日 之间尚未结算的份额（点击提取即可入账）
        // - todayAccrual：今日份额（合约按日隔离，次日后才可结算）
        const cacheKey = `${addr}`;
        const hit = divCache.get(cacheKey);
        if (hit && Date.now() - hit.at < 30_000) {
          res.end(JSON.stringify(hit.value));
          return;
        }
        try {
          const today = Math.floor(Date.now() / 86400000);
          const [dv, row, info] = await Promise.all([
            mining.dividendOf(addr),
            db.get("SELECT power_day FROM users WHERE address=?", [addr]),
            mining.userInfo(addr),
          ]);
          const claimable = BigInt(dv[0]);
          let cursor = Number(dv[1]);
          const powerDay = row ? Number(row.power_day || 0) : 0;
          if (cursor === 0) cursor = powerDay; // 与合约一致：未初始化游标时从入金日起算
          if (cursor < powerDay) cursor = powerDay;
          // 算力口径：用链上 userInfo.power（当日现值，权威）反向复利推历史日，
          // 避免链下账本用「入库时间」近似 power_day 造成 1% 量级偏差
          const ONE = 10n ** 18n;
          const powerToday = BigInt(info[2]);
          let settleable = 0n;
          let todayAccrual = 0n;
          // 上限 40 天（MAX_SETTLE_DAYS 口径的保守展开），防极端游标导致 RPC 风暴
          const from = Math.max(cursor, today - 40);
          for (let d = from; d <= today; d++) {
            const di = await mining.dailyInfo(d);
            const divAmt = BigInt(di[1]);
            const dayPower = BigInt(di[0]);
            if (divAmt === 0n || dayPower === 0n || powerToday === 0n) continue;
            const elapsed = today - d;
            const up =
              elapsed <= 0 ? powerToday : (powerToday * ONE) / ledger._compound(ONE, elapsed);
            if (up === 0n) continue;
            const share = (divAmt * up) / dayPower;
            if (d < today) settleable += share;
            else todayAccrual += share;
          }
          const value = {
            address: addr,
            claimable: claimable.toString(),
            settleable: settleable.toString(),
            todayAccrual: todayAccrual.toString(),
            total: (claimable + settleable + todayAccrual).toString(),
            cursorDay: cursor,
            today,
          };
          divCache.set(cacheKey, { at: Date.now(), value });
          res.end(JSON.stringify(value));
        } catch (e) {
          res.end(JSON.stringify({ address: addr, error: String(e.message).slice(0, 120) }));
        }
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
