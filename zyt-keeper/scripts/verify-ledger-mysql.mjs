/**
 * 主网账本 v16 对齐验证（2026-09-28，只读）
 * 做法：从生产 MySQL events 表读主网事件 → 复制进内存 SQLite → 用【新版】ledger.js 重放 →
 *       与链上 mining.powerOf / launchDay 逐用户比对，并输出补跑分母 totalPower(20724)。
 * 安全性：对 MySQL 只 SELECT；对链只调 view；DB 强制 :memory:；不触碰生产文件。
 * 运行（服务器临时目录）：node scripts/verify-ledger-mysql.mjs
 * 退出码：0 = 全部一致；1 = 存在偏差
 */
process.env.DB_URL = ":memory:"; // 强制内存库（dotenv 不覆盖已存在键，挡住 .env 的 MySQL）

import fs from "node:fs";
const { Ledger } = await import("../src/ledger.js");
const { getDb } = await import("../src/db.js");
const { CONFIG } = await import("../src/config.js");

// 从 .env 取 DB_URL 仅作只读连接（不经过 config/db 层，避免误写生产库）
const envText = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const DB_URL = envText.match(/^DB_URL=(.*)$/m)?.[1]?.trim();
if (!DB_URL || !DB_URL.startsWith("mysql")) {
  console.error("未找到 MySQL DB_URL，终止（避免误在内存库上做无意义验证）");
  process.exit(2);
}

const mysql = (await import("mysql2/promise")).default;
const { Contract, JsonRpcProvider, formatEther } = await import("ethers");

// 1) 只读拉取生产 events（主网）
const conn = await mysql.createConnection(DB_URL);
const [rows] = await conn.query(
  "SELECT chain_id, block, tx_hash, log_index, name, from_addr, to_addr, amount, extra, created_at, block_time FROM events WHERE chain_id=? ORDER BY block, log_index",
  [CONFIG.chainId]
);
await conn.end();
console.log("生产 MySQL events 行数（chain_id=" + CONFIG.chainId + "）:", rows.length);

// 2) 复制进内存库
const db = await getDb();
for (const r of rows) {
  await db.run(
    "INSERT OR IGNORE INTO events (chain_id, block, tx_hash, log_index, name, from_addr, to_addr, amount, extra, created_at, block_time) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [r.chain_id, r.block, r.tx_hash, r.log_index, r.name, r.from_addr, r.to_addr, r.amount, r.extra, Number(r.created_at), Number(r.block_time || 0)]
  );
}

// 3) 新版账本重放 + 链上权威值比对
const provider = new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true, timeout: 15000 });
const mining = new Contract(CONFIG.contracts.mining, [
  "function powerOf(address) view returns (uint256)",
  "function launchDay() view returns (uint64)",
], provider);
const ledger = new Ledger(provider, { mining });
await ledger.rebuild();

const launchDay = await ledger._getLaunchDay();
console.log("launchDay（链上权威 / 兜底推导）:", launchDay);

const users = await db.all("SELECT address, power_base, power_day FROM users");
console.log("账本用户数:", users.length, "\n=== 逐用户对比（账本 vs 链上）===");
let allOk = true;
for (const r of users) {
  const local = await ledger.powerOf(r.address);
  let chain;
  try {
    chain = await mining.powerOf(r.address);
  } catch (e) {
    console.log("  ? " + r.address + " 链上读取失败: " + String(e.message).slice(0, 60));
    allOk = false;
    continue;
  }
  const diff = local > chain ? local - chain : chain - local;
  const ok = diff <= 1n;
  if (!ok) allOk = false;
  console.log(
    (ok ? "  ✔ " : "  ✘ ") +
      r.address +
      " | base=" + formatEther(r.power_base) +
      " power_day=" + r.power_day +
      " | 账本=" + formatEther(local) +
      " 链上=" + formatEther(chain)
  );
}

console.log("\n=== 补跑分母 ===");
console.log("totalPower(day=20724) =", formatEther(await ledger.totalPower(20724)));
console.log(allOk ? "\n✔ 全部用户算力与链上一致（v16 口径对齐成功）" : "\n✘ 存在偏差，需排查");
process.exit(allOk ? 0 : 1);
