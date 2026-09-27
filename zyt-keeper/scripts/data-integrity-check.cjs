/** 数据完整性核查（2026-09-27）：入金明细 / 用户账本 / 快照执行情况 / 对账 */
require("dotenv").config();
const mysql = require("mysql2/promise");
(async () => {
  const c = await mysql.createConnection(process.env.DB_URL);

  console.log("════ 1. 业务事件（入金/买/卖/推荐）════");
  const [d] = await c.query(
    "SELECT name, block, from_addr, to_addr, amount FROM events WHERE name IN ('Deposited','Bought','Sold','RefPaid','FirstReceive') ORDER BY block"
  );
  for (const r of d) {
    const amt = r.amount ? (Number(r.amount) / 1e18).toFixed(2) : "-";
    console.log(
      `  ${r.name.padEnd(14)} 块${r.block} | ${String(r.from_addr).slice(0, 10)}…→${String(r.to_addr).slice(0, 10)}… | ${amt}`
    );
  }

  console.log("════ 2. 用户账本（链下）════");
  const [u] = await c.query(
    "SELECT address, deposit_total, power_base, withdraw_total, is_exited FROM users"
  );
  for (const r of u) {
    console.log(
      `  ${String(r.address).slice(0, 14)}… | 入金 ${Number(r.deposit_total) / 1e18} | 算力 ${Number(r.power_base) / 1e18} | 已提 ${Number(r.withdraw_total) / 1e18} | 出局 ${r.is_exited}`
    );
  }

  console.log("════ 3. 今日 keeper 快照相关记录 ════");
  const [k] = await c.query(
    "SELECT type, status, detail, created_at FROM keeper_runs WHERE type='keeper' AND created_at >= UNIX_TIMESTAMP(CURDATE()) ORDER BY id DESC LIMIT 5"
  );
  if (!k.length) console.log("  （今日无 keeper 记录）");
  for (const r of k)
    console.log(
      `  ${r.type}/${r.status} | ${String(r.detail).slice(0, 72)} | ${new Date(Number(r.created_at) * 1000).toISOString()}`
    );

  console.log("════ 4. 最新对账 ════");
  const [rc] = await c.query(
    "SELECT status, total_users, diff_users, max_diff_pct, detail, checked_at FROM reconcile_results ORDER BY id DESC LIMIT 1"
  );
  for (const r of rc)
    console.log(
      `  ${r.status} | 用户 ${r.total_users} | 差异 ${r.diff_users} | max=${Number(r.max_diff_pct)}% | ${new Date(Number(r.checked_at) * 1000).toISOString()}`
    );

  console.log("════ 5. 快照表 ════");
  const [sn] = await c.query("SELECT * FROM snapshots ORDER BY id DESC LIMIT 2");
  for (const r of sn)
    console.log(`  ${JSON.stringify(r).slice(0, 220)}`);

  await c.end();
})().catch((e) => {
  console.log("ERR:", String(e.message).slice(0, 200));
  process.exit(1);
});
