/**
 * 从链上权威状态重建 keeper 账本（users 表）
 *
 * 用途：当 keeper 启动时遇到 RPC 剪枝（历史事件缺失）导致账本用户不全时，
 *       用链上 userInfo / powerOf / dividendOf 直接恢复用户资产数据。
 *
 * 原理：v9.1 ZYTToken 有 userList（getUserCount/getUserAt），可枚举全部用户；
 *       mining.userInfo(addr) 给出权威状态（入金/提取/算力/额度/出局标记）。
 *       记录页的历史明细（逐笔事件）无法由此恢复，但用户资产与对账口径可恢复。
 *
 * 用法（在目标环境的 zyt-keeper 目录执行）：
 *   node scripts/rebuild-ledger-from-chain.mjs            # 预览（不写库）
 *   node scripts/rebuild-ledger-from-chain.mjs --apply    # 写入 DB
 *   node scripts/rebuild-ledger-from-chain.mjs --apply --sql   # 同时打印 SQL（便于在别处执行）
 */
import { JsonRpcProvider, Contract } from "ethers";
import { getDb } from "../src/db.js";
import { CONFIG } from "../src/config.js";

const APPLY = process.argv.includes("--apply");
const PRINT_SQL = process.argv.includes("--sql");

const DAY = 86400000;
const today = Math.floor(Date.now() / DAY);

const provider = new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
const zyt = new Contract(
  CONFIG.contracts.zyt,
  ["function getUserCount() view returns (uint256)", "function getUserAt(uint256) view returns (address)", "function balanceOf(address) view returns (uint256)"],
  provider
);
const mining = new Contract(
  CONFIG.contracts.mining,
  [
    "function userInfo(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)",
    "function powerOf(address) view returns (uint256)",
    "function dividendOf(address) view returns (uint256,uint256)",
  ],
  provider
);

const n = Number(await zyt.getUserCount());
console.log(`=== 链上 userList 枚举（count=${n}） ===`);

// ⚠️ 重要：ZYTToken.userList 只收录「发生过卖出/转账」的地址（_update 普通转账路径才调 _onReceive），
//    纯入金用户不在其中。因此地址来源必须是「链上 userList ∪ 本地 events 里出现过的地址」。
const addrSet = new Set();
for (let i = 0; i < n; i++) addrSet.add(String(await zyt.getUserAt(i)).toLowerCase());
try {
  const db0 = await getDb();
  const rows = await db0.all(
    "SELECT DISTINCT from_addr AS a FROM events WHERE from_addr IS NOT NULL UNION SELECT DISTINCT to_addr AS a FROM events WHERE to_addr IS NOT NULL"
  );
  for (const r of rows) {
    const a = String(r.a || "").toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(a)) addrSet.add(a);
  }
  console.log(`本地 events 补充地址后，候选地址 ${addrSet.size} 个（含纯入金用户）`);
} catch {
  /* 无 DB 时只用链上列表 */
}

const rows = [];
for (const addr of addrSet) {
  try {
    const [ui, pw, dv, bal] = await Promise.all([
      mining.userInfo(addr),
      mining.powerOf(addr),
      mining.dividendOf(addr),
      zyt.balanceOf(addr),
    ]);
    // 跳过从未入金且无算力的地址（如 pair 合约、营销/技术地址等非用户）
    if (BigInt(ui[0]) === 0n && BigInt(pw) === 0n && BigInt(ui[1]) === 0n && BigInt(ui[3]) === 0n) continue;
    const rec = {
      address: addr,
      deposit_total: ui[0],
      withdraw_total: ui[1],
      dynamic_quota: ui[3],
      dynamic_withdrawn: ui[4],
      power: pw,
      power_base: pw, // 近似：以当前算力为基数，power_day 设为今天（后续复利从今天起算）
      power_day: today,
      is_exited: ui[6] ? 1 : 0,
      pending_dividend: dv[0],
      zyt_balance: bal,
    };
    rows.push(rec);
    console.log(
      `  ${addr}\n    deposit=${Number(ui[0]) / 1e18} withdraw=${Number(ui[1]) / 1e18} power=${Number(pw) / 1e18} ` +
        `dynQuota=${Number(ui[3]) / 1e18} dynUsed=${Number(ui[4]) / 1e18} staticExited=${ui[6]} dynExited=${ui[7]}\n` +
        `    ZYT余额=${Number(bal) / 1e18} 待领分红=${Number(dv[0]) / 1e18}`
    );
  } catch (e) {
    console.log(`  ${addr}  ✗ 读取失败: ${(e.shortMessage || e.message || "").slice(0, 60)}`);
  }
}

const now = Math.floor(Date.now() / 1000);
const sqls = rows.map(
  (r) =>
    `INSERT OR REPLACE INTO users (address, deposit_total, withdraw_total, dynamic_quota, dynamic_withdrawn, converted_total, received_value, exit_day, power_base, power_day, is_exited, updated_at) VALUES ('${r.address}', '${r.deposit_total}', '${r.withdraw_total}', '${r.dynamic_quota}', '${r.dynamic_withdrawn}', '0', '0', 0, '${r.power_base}', ${r.power_day}, ${r.is_exited}, ${now});`
);

if (PRINT_SQL) {
  console.log("\n=== SQL（可在目标 DB 直接执行） ===");
  for (const s of sqls) console.log(s);
}

if (!APPLY) {
  console.log(`\n预览模式（未写库）。共 ${rows.length} 条。加 --apply 写入。`);
  process.exit(0);
}

const db = await getDb();
for (const s of sqls) await db.run(s);
console.log(`\n✔ 已写入 ${sqls.length} 条 users 记录`);
const [cnt] = await db.all("SELECT COUNT(*) AS c FROM users");
console.log("users 表现有记录数:", cnt.c);
process.exit(0);
