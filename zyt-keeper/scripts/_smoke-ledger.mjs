process.env.DB_URL = "";
process.env.CHAIN_ID = "31337";
const { getDb } = await import("../src/db.js").then(m => ({ getDb: m.getDb }));
const { Ledger } = await import("../src/ledger.js");
const { CONFIG } = await import("../src/config.js");

const db = await getDb();
await db.exec("DELETE FROM events; DELETE FROM users; DELETE FROM pool_state;");
const now = Math.floor(Date.now() / 1000);
const ins = "INSERT INTO events (chain_id, block, tx_hash, log_index, name, from_addr, to_addr, amount, extra, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)";
const ev = (i, name, from, to, amount, extra) => [31337, 100 + i, "0xtx" + i, i, name, from, to, amount, JSON.stringify(extra), now];

// 场景：alice 入金 500U（无推荐）→ root 收 RefPaid 35U（bob 入金推 alice）→ alice 卖 100U → carol 转账入 50U 等值 → alice 静态出局触发判定
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const R = "0xrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr1";
const C = "0xcccccccccccccccccccccccccccccccccccccccc3";
const rows = [
  ev(0, "Deposited", "", A, "500000000000000000000", { user: A, usdt: "500000000000000000000", power: "500000000000000000000", quota: "500000000000000000000", ref: "0x0" }),
  ev(1, "Deposited", "", R, "500000000000000000000", { user: R, usdt: "500000000000000000000", power: "500000000000000000000", quota: "500000000000000000000", ref: "0x0" }),
  ev(2, "RefPaid", A, "", "35000000000000000000", { receiver: A, usdtAmount: "35000000000000000000", level: 1 }),
  ev(3, "Sold", A, "", "100000000000000000000", { user: A, zytIn: "1000000000000000000000", usdtOut: "100000000000000000000", rate: 500 }),
  ev(4, "TransferLedger", C, "", "50000000000000000000", { user: C, zytAmount: "5000000000000000000000", usdtValue: "50000000000000000000", isOut: false }),
  ev(5, "Deflated", "", "", "10000000000000000000", { burned: "10000000000000000000", dividend: "10000000000000000000", usdtResynced: "10000000000000000000" }),
];
for (const r of rows) await db.run(ins, r);

const ledger = new Ledger(null, {});
await ledger.rebuild();

const a = await db.get("SELECT * FROM users WHERE address=?", [A]);
const r = await db.get("SELECT * FROM users WHERE address=?", [R]);
const c = await db.get("SELECT * FROM users WHERE address=?", [C]);
const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok:", msg); };

assert(BigInt(a.deposit_total) === 500n * 10n ** 18n, "alice deposit_total=500U");
assert(BigInt(a.power_base) === 500n * 10n ** 18n, "alice power_base=500");
assert(BigInt(a.dynamic_quota) === 2500n * 10n ** 18n, "alice dynamic_quota=2500U (5x)");
assert(BigInt(a.dynamic_withdrawn) === 35n * 10n ** 18n, "alice dynamic_withdrawn=35U (RefPaid 消耗)");
assert(BigInt(a.withdraw_total) === 100n * 10n ** 18n, "alice withdraw_total=100U (Sold)");
assert(BigInt(r.dynamic_quota) === 2500n * 10n ** 18n, "root dynamic_quota=2500U");
assert(BigInt(c.received_value) === 50n * 10n ** 18n, "carol received_value=50U (TransferLedger in)");
assert(Number(a.is_exited) === 0, "alice 未出局 (100 < 1000)");

// 出局边界：alice 再卖 950U → withdraw=1050 ≥ 2×500 → exit
await db.run(ins, ev(6, "Sold", A, "", "950000000000000000000", { user: A, zytIn: "1", usdtOut: "950000000000000000000", rate: 500 }));
await ledger.rebuild();
const a2 = await db.get("SELECT * FROM users WHERE address=?", [A]);
assert(Number(a2.is_exited) === 1 && Number(a2.exit_day) > 0, "alice 静态出局触发 (withdraw 1050 ≥ 2×500)");

console.log("--- ledger smoke ALL PASS ---");
process.exit(0);
