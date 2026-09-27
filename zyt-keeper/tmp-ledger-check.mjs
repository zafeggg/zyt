/**
 * 临时验证脚本：v17 账本口径（不入库，仅内存 SQLite）
 * 运行：node tmp-ledger-check.mjs
 */
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
    [31337, block, "0xtx" + block, 0, name, addr, "", "0", JSON.stringify(args), 0]
  );
  block++;
}

// A：入金 1000 → 兑换 500 → 卖出 600（累计提取 1100 < 2000，未出局）
const A = "0xaaaa";
await ev("Deposited", A, { user: A, usdt: (1000n * E18).toString(), zytMinted: "0", power: (1000n * E18).toString(), quota: "0" });
await ev("Converted", A, { user: A, usdtValue: (500n * E18).toString(), zytOut: (50000000n * E18).toString() });
await ev("Sold", A, { user: A, zytIn: (1000n * E18).toString(), usdtOut: (600n * E18).toString(), rate: "500" });

// B：入金 1000 → 兑换 1500 → 卖出 600（累计 2100 ≥ 2000，出局）
const B = "0xbbbb";
await ev("Deposited", B, { user: B, usdt: (1000n * E18).toString(), zytMinted: "0", power: (1000n * E18).toString(), quota: "0" });
await ev("Converted", B, { user: B, usdtValue: (1500n * E18).toString(), zytOut: "0" });
await ev("Sold", B, { user: B, zytIn: "0", usdtOut: (600n * E18).toString(), rate: "500" });

// C：二次入金（算力累加，deposit_total 累加）
const C = "0xcccc";
await ev("Deposited", C, { user: C, usdt: (1000n * E18).toString(), power: (1000n * E18).toString() });
await ev("Deposited", C, { user: C, usdt: (500n * E18).toString(), power: (500n * E18).toString() });

// D：推荐奖励（RefPaid）与底池创建（BasePoolFunded）不得影响账本字段
const D = "0xdddd";
await ev("RefPaid", D, { receiver: D, usdtAmount: (70n * E18).toString(), level: "1" });
await ev("BasePoolFunded", D, { user: D, usdtIn: (600n * E18).toString(), liquidity: (600n * E18).toString() });

const l = new Ledger(null, {});
await l.rebuild();

const rows = await db.all("SELECT address, deposit_total, withdraw_total, converted_total, power_base, is_exited FROM users ORDER BY address");
const h = (v) => (Number(v) / 1e18).toString();
for (const r of rows) {
  console.log(
    r.address,
    "| deposit", h(r.deposit_total),
    "| withdraw", h(r.withdraw_total),
    "| converted", h(r.converted_total),
    "| powerBase", h(r.power_base),
    "| exited", r.is_exited
  );
}

const expect = {
  "0xaaaa": { deposit: 1000, withdraw: 1100, converted: 500, exited: 0 },
  "0xbbbb": { deposit: 1000, withdraw: 2100, converted: 1500, exited: 1 },
  "0xcccc": { deposit: 1500, withdraw: 0, converted: 0, exited: 0 },
};
let fail = 0;
// 0xdddd 不应进入账本（RefPaid / BasePoolFunded 不写用户字段）
if (rows.find((x) => x.address === "0xdddd")) {
  console.log("FAIL 0xdddd 不应入账（RefPaid/BasePoolFunded 不得写账本字段）");
  fail++;
} else {
  console.log("PASS 0xdddd 未入账（仅 Deposited 建立用户记录）");
}
for (const [addr, e] of Object.entries(expect)) {
  const r = rows.find((x) => x.address === addr);
  const got = r && {
    deposit: Number(r.deposit_total) / 1e18,
    withdraw: Number(r.withdraw_total) / 1e18,
    converted: Number(r.converted_total) / 1e18,
    exited: r.is_exited,
  };
  const ok = got && JSON.stringify(got) === JSON.stringify(e);
  console.log(ok ? "PASS" : "FAIL", addr, got ? JSON.stringify(got) : "missing", ok ? "" : "expected " + JSON.stringify(e));
  if (!ok) fail++;
}
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
