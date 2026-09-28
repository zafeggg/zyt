/**
 * ledger v16 对齐验证（2026-09-28）
 * 目的：验证账本算力口径与合约 ZYTMining._powerOf（:290-298）严格一致——
 *   ① power_base 存原始算力累计（追加入金不再逐人固化重置，合约 :131-134）
 *   ② 全网统一 launchDay 复利基准（后入金者入金即按 1.01^(day-launchDay) 补偿，合约 :126-127）
 *   ③ power_day 仅作分红起算门控（仅首次入金写入，合约 :129）
 * 用内存 SQLite 种入与主网现状一致的 6 用户事件（4 老 @day20723 + 2 新 @day20724，
 * powerRate=100% 便于心算），断言快照分母 totalPower 与单用户 powerOf 的精确 wei 值。
 * 运行：node scripts/verify-ledger-v16.mjs（强制 :memory:，无任何副作用）
 * 退出码：0 = 全部通过；1 = 存在偏差
 */
process.env.DB_URL = ":memory:";
process.env.CHAIN_ID = process.env.CHAIN_ID || "31337";

// 动态 import：确保上面的 env 覆盖先于 config.js 的 dotenv 读取生效
const { Ledger } = await import("../src/ledger.js");
const { getDb } = await import("../src/db.js");
const { CONFIG } = await import("../src/config.js");

const W18 = 10n ** 18n;
const U = (i) => "0x" + String(i).padStart(40, "0"); // 测试地址
const DAY = (d, off) => d * 86400 + off; // 事件区块时间戳（秒）→ _dayOf 换算 UTC 天
let fail = 0;
const eq = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: got=${got} want=${want}`);
};

const db = await getDb();
const seedLi = { n: 0 };
async function seed(rows) {
  for (const [to, usdt, ts] of rows) {
    seedLi.n++;
    await db.run(
      "INSERT INTO events (chain_id, block, tx_hash, log_index, name, from_addr, to_addr, amount, extra, created_at, block_time) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [
        CONFIG.chainId,
        1000 + seedLi.n,
        "0xtest" + String(seedLi.n).padStart(4, "0"),
        seedLi.n,
        "Deposited",
        to,
        to,
        String(usdt),
        JSON.stringify({ usdt: String(usdt), power: String(usdt), user: to }),
        ts,
        ts,
      ]
    );
  }
}

// ---- 场景 1：主网现状复刻（4 老 @day20723 + 2 新 @day20724）----
await seed([
  [U(1), 500n * W18, DAY(20723, 100)],
  [U(2), 500n * W18, DAY(20723, 200)],
  [U(3), 200n * W18, DAY(20723, 300)],
  [U(4), 500n * W18, DAY(20723, 400)],
  [U(5), 100n * W18, DAY(20724, 3600)],
  [U(6), 100n * W18, DAY(20724, 7200)],
]);

const ledger = new Ledger(null, null); // contracts=null → launchDay 走账本推导兜底（主网上走链上权威值）
await ledger.rebuild();

console.log("---- 场景 1：6 用户现状（4 老 @day20723 + 2 新 @day20724）----");
eq("launchDay 兜底推导 = 20723", await ledger._getLaunchDay(), 20723);
eq("totalPower(day=20723)", (await ledger.totalPower(20723)).toString(), (1700n * W18).toString());
eq("totalPower(day=20724) 快照分母", (await ledger.totalPower(20724)).toString(), (1919n * W18).toString());
eq("powerOf(老用户, day=20724)", (await ledger.powerOf(U(1), 20724)).toString(), (505n * W18).toString());
eq("powerOf(新用户, day=20724) 含 v16 补偿", (await ledger.powerOf(U(5), 20724)).toString(), (101n * W18).toString());
eq("totalPower(day=20722 未启动) = 0", (await ledger.totalPower(20722)).toString(), "0");

// ---- 场景 2：老用户 U1 追加入金 100U @day20724（验证不再固化重置）----
await seed([[U(1), 100n * W18, DAY(20724, 9000)]]);
await ledger.rebuild();
const row1 = await db.get("SELECT power_base, power_day FROM users WHERE address=?", [U(1)]);
console.log("---- 场景 2：老用户 U1 追加入金 100U @day20724 ----");
eq("U1 power_base 原始累计 = 600e18（未固化）", row1.power_base, (600n * W18).toString());
eq("U1 power_day 保持首次入金日 20723", Number(row1.power_day), 20723);
eq("powerOf(U1, day=20724)", (await ledger.powerOf(U(1), 20724)).toString(), (606n * W18).toString());
eq("totalPower(day=20724) 更新", (await ledger.totalPower(20724)).toString(), (2020n * W18).toString());

console.log(
  fail === 0
    ? "\n全部通过 ✓ ledger v16 口径与合约 _powerOf 严格一致"
    : `\n${fail} 项失败 ✗`
);
process.exit(fail === 0 ? 0 : 1);
