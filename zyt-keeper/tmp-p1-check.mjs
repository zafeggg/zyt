/** 临时验证：P1-7 转账折算重放 + P1-12 固化口径（内存库，跑完即删） */
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

const A = "0xaaaa";
await ev("Deposited", A, { user: A, usdt: (1000n * E18).toString(), zytMinted: "0", power: (1000n * E18).toString(), quota: "0" });
await ev("TransferLedger", A, { user: A, zytAmount: (1000n * E18).toString(), usdtValue: (100n * E18).toString(), isOut: true });
await ev("Converted", A, { user: A, usdtValue: (200n * E18).toString(), zytOut: "0" });
await ev("Sold", A, { user: A, zytIn: "0", usdtOut: (300n * E18).toString(), rate: "500" });

const B = "0xbbbb";
await ev("TransferLedger", B, { user: B, zytAmount: (1000n * E18).toString(), usdtValue: (100n * E18).toString(), isOut: false });

const l = new Ledger(null, {});
await l.rebuild();
const rows = await db.all("SELECT address, deposit_total, withdraw_total, converted_total, received_value, power_base FROM users ORDER BY address");
for (const r of rows) {
  const h = (v) => (Number(v) / 1e18).toString();
  console.log(r.address, "| deposit", h(r.deposit_total), "| withdraw", h(r.withdraw_total), "| converted", h(r.converted_total), "| received", h(r.received_value), "| powerBase", h(r.power_base));
}

const expect = {
  "0xaaaa": { deposit: 1000, withdraw: 600, converted: 200, received: 0 },
  "0xbbbb": { deposit: 0, withdraw: 0, converted: 0, received: 100 },
};
let fail = 0;
for (const [addr, e] of Object.entries(expect)) {
  const r = rows.find((x) => x.address === addr);
  const got = r && { deposit: Number(r.deposit_total) / 1e18, withdraw: Number(r.withdraw_total) / 1e18, converted: Number(r.converted_total) / 1e18, received: Number(r.received_value) / 1e18 };
  const ok = got && JSON.stringify(got) === JSON.stringify(e);
  console.log(ok ? "PASS" : "FAIL", addr, got ? JSON.stringify(got) : "missing", ok ? "" : "expected " + JSON.stringify(e));
  if (!ok) fail++;
}
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
