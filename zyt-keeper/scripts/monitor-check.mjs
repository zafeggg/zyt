/**
 * 监控规则引擎验证脚本（stub 方式，确定性验证 5 规则 + 冷却机制）
 * 运行：node scripts/monitor-check.mjs
 * 通过 console.warn 捕获 [ALERT] 告警输出做断言
 */
// 环境隔离：内存库 + 缩小 R4 阈值便于触发
// 注意：必须用动态 import（顶层 import 会提升，导致 config.js 先于 env 赋值加载）
process.env.DB_URL = ":memory:";
process.env.MONITOR_INDEX_LAG_BLOCKS = "10";

const { Monitor } = await import("../src/monitor.js");
const { getDb } = await import("../src/db.js");

let pass = 0,
  fail = 0;
const check = (n, c, e) => {
  c ? (pass++, console.log("  [PASS] " + n + (e ? " " + e : ""))) : (fail++, console.log("  [FAIL] " + n + (e ? " " + e : "")));
};

// 捕获 [ALERT] 输出
const alerts = [];
const origWarn = console.warn;
console.warn = (m) => {
  if (typeof m === "string" && m.includes("[ALERT]")) alerts.push(m);
  origWarn(m);
};

// 可变 stub（两次 checkOnce 之间改值模拟变化）
// 注意：合约 view 返回 uint256 → ethers 解析为 BigInt，stub 必须返回 BigInt 模拟真实类型
function makePool() {
  return {
    usdt: 1000n * 10n ** 18n,
    slip: 500n, // 5%（BigInt，与 getCurrentSlippage 返回类型一致）
    poolUSDT: async function () {
      return this.usdt;
    },
    getCurrentSlippage: async function () {
      return this.slip;
    },
  };
}
const providerStub = { getBlockNumber: async () => 100 };

console.log("【R1 底池突变】");
{
  const pool = makePool();
  const m = new Monitor({ pool, provider: providerStub });
  await m.checkOnce(); // 基线：仅记录，不告警
  check("首次运行只记基线不告警", alerts.filter((a) => a.includes("R1-POOL-MOVE")).length === 0);
  pool.usdt = 800n * 10n ** 18n; // 跌 20% > 10%
  m.cooldown.clear(); // 用例隔离（冷却是独立机制，单测场景互不干扰）
  await m.checkOnce();
  check("下跌 20% 触发 R1", alerts.filter((a) => a.includes("R1-POOL-MOVE")).length === 1);
  pool.usdt = 900n * 10n ** 18n; // 相对 800 涨 12.5% > 10%
  m.cooldown.clear();
  await m.checkOnce();
  check("上涨 12.5% 触发 R1", alerts.filter((a) => a.includes("R1-POOL-MOVE")).length === 2);
  // 冷却验证：不 clear，立即再变 → 不应重复告警
  pool.usdt = 700n * 10n ** 18n; // 相对 900 跌 22% > 10%
  await m.checkOnce();
  check("冷却期内不重复告警", alerts.filter((a) => a.includes("R1-POOL-MOVE")).length === 2);
  // 冷却过期（模拟）后可再触发
  m.cooldown.clear();
  pool.usdt = 600n * 10n ** 18n;
  await m.checkOnce();
  check("冷却过期后可再触发", alerts.filter((a) => a.includes("R1-POOL-MOVE")).length === 3);
}

console.log("【R2 大额卖出（事件实时）】");
{
  const pool = makePool(); // 底池 1000U
  const m = new Monitor({ pool, provider: providerStub });
  await m.checkOnce(); // 初始化 lastPoolUsdt = 1000U
  await m.onEvent("Sold", { user: "0xAbC123", zytIn: 1n, usdtOut: 600n * 10n ** 18n }); // 60U = 6% > 5%
  check("卖出 6% 底池触发 R2", alerts.filter((a) => a.includes("R2-BIG-SELL")).length === 1);
  await m.onEvent("Sold", { user: "0xAbC123", zytIn: 1n, usdtOut: 30n * 10n ** 18n }); // 3% < 5%
  check("卖出 3% 底池不触发 R2", alerts.filter((a) => a.includes("R2-BIG-SELL")).length === 1);
  // 首次无基线（lastPoolUsdt=null）时跳过
  const m2 = new Monitor({ pool: makePool(), provider: providerStub });
  await m2.onEvent("Sold", { user: "0x", zytIn: 1n, usdtOut: 999n * 10n ** 18n });
  check("无基线时 R2 跳过", alerts.filter((a) => a.includes("R2-BIG-SELL")).length === 1);
}

console.log("【R3 滑点档位跳变】");
{
  const pool = makePool();
  const m = new Monitor({ pool, provider: providerStub });
  await m.checkOnce(); // 基线 5%
  pool.slip = 8000n; // 5% → 80%
  await m.checkOnce();
  check("滑点 5%→80% 触发 R3", alerts.filter((a) => a.includes("R3-SLIPPAGE-JUMP")).length === 1);
  pool.slip = 8000n; // 不变
  await m.checkOnce();
  check("滑点不变不触发", alerts.filter((a) => a.includes("R3-SLIPPAGE-JUMP")).length === 1);
}

console.log("【R4 索引延迟】");
{
  const m = new Monitor({ pool: makePool(), provider: providerStub }); // latest=100
  m.setIndexer({ lastBlock: 50 }); // lag=50 > 10 → 触发
  await m.checkOnce();
  check("索引延迟 50 块触发 R4", alerts.filter((a) => a.includes("R4-INDEX-LAG")).length === 1);
  m.cooldown.delete("R4-INDEX-LAG");
  m.setIndexer({ lastBlock: 95 }); // lag=5 < 10 → 不触发
  await m.checkOnce();
  check("索引延迟 5 块不触发", alerts.filter((a) => a.includes("R4-INDEX-LAG")).length === 1);
  const m2 = new Monitor({ pool: makePool(), provider: providerStub });
  await m2.checkOnce(); // 无 indexer → 跳过
  check("无 indexer 时 R4 跳过", alerts.filter((a) => a.includes("R4-INDEX-LAG")).length === 1);
}

console.log("【R5 调用失败率】");
{
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  // 造 12 条 error 记录（最近窗口内，类型属于统计范围）
  for (let i = 0; i < 12; i++) {
    await db.run("INSERT INTO keeper_runs (type, status, detail, created_at) VALUES (?,?,?,?)", [
      "indexer",
      "error",
      "test",
      now - i * 10,
    ]);
  }
  const m = new Monitor({ pool: makePool(), provider: providerStub });
  await m.checkOnce();
  check("12/12 失败触发 R5", alerts.filter((a) => a.includes("R5-ERROR-RATE")).length === 1);
  // 冷却过期后恢复正常（清库）
  await db.run("DELETE FROM keeper_runs");
  for (let i = 0; i < 15; i++) {
    await db.run("INSERT INTO keeper_runs (type, status, detail, created_at) VALUES (?,?,?,?)", [
      "indexer",
      i < 2 ? "error" : "ok",
      "test",
      now - i * 10,
    ]);
  }
  m.cooldown.delete("R5-ERROR-RATE");
  await m.checkOnce();
  check("2/15 失败（13.3%）不触发 R5", alerts.filter((a) => a.includes("R5-ERROR-RATE")).length === 1);
  // 样本过小不判定
  m.cooldown.delete("R5-ERROR-RATE");
  await db.run("DELETE FROM keeper_runs");
  await db.run("INSERT INTO keeper_runs (type, status, detail, created_at) VALUES (?,?,?,?)", ["keeper", "error", "x", now]);
  await m.checkOnce();
  check("样本 <10 不触发 R5", alerts.filter((a) => a.includes("R5-ERROR-RATE")).length === 1);
}

console.log("");
console.log("结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
