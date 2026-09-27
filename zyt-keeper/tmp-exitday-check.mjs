/** 临时验证：出局日（exitDay）与算力停发口径（内存库，跑完即删） */
process.env.DB_URL = ":memory:";
process.env.CHAIN_ID = "31337";
process.env.STATIC_EXIT_MUL = "2";

const { getDb } = await import("./src/db.js");
const { Ledger } = await import("./src/ledger.js");

const E18 = 10n ** 18n;
const db = await getDb();
let block = 1;
async function ev(name, addr, args) {
  await db.run(
    "INSERT OR IGNORE INTO events (chain_id, block, tx_hash, log_index, name, from_addr, to_addr, amount, extra, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [31337, block, "0xtx" + block, 0, name, addr, "", "0", JSON.stringify(args), Math.floor(Date.now() / 1000)]
  );
  block++;
}

// A：入金 1000 → 卖出 2000（达 2 倍）→ 出局
const A = "0xaaaa";
await ev("Deposited", A, { user: A, usdt: (1000n * E18).toString(), power: (1000n * E18).toString() });
await ev("Sold", A, { user: A, usdtOut: (2000n * E18).toString() });
await ev("StaticExited", A, { user: A });

// B：入金 1000，无出局
const B = "0xbbbb";
await ev("Deposited", B, { user: B, usdt: (1000n * E18).toString(), power: (1000n * E18).toString() });

const l = new Ledger(null, {});
await l.rebuild();

const rows = await db.all("SELECT address, deposit_total, withdraw_total, power_base, is_exited, exit_day FROM users ORDER BY address");
for (const r of rows) {
  console.log(r.address, "| deposit", Number(r.deposit_total) / 1e18, "| withdraw", Number(r.withdraw_total) / 1e18, "| exited", r.is_exited, "| exitDay", r.exit_day);
}

let fail = 0;
const a = rows.find((r) => r.address === A);
const b = rows.find((r) => r.address === B);

const checks = [
  ["A 已出局", Number(a.is_exited) === 1],
  ["A 记出局日", Number(a.exit_day) > 0],
  ["A 出局后算力为 0", (await l.powerOf(A)) === 0n],
  ["B 未出局", Number(b.is_exited) === 0],
  ["B 出局日为 0", Number(b.exit_day) === 0],
  ["B 算力正常（1000e18）", (await l.powerOf(B)) === 1000n * E18],
];
for (const [name, ok] of checks) {
  console.log(ok ? "PASS" : "FAIL", name);
  if (!ok) fail++;
}
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
