/**
 * 强制卖出追踪验证脚本（#7）
 * 纯函数单测（窗口计算/应卖量/风险判定）+ 追踪器 stub 集成验证
 * 运行：node scripts/forcesell-check.mjs
 */
process.env.DB_URL = ":memory:";

const { windowInfo, computeForceSell, FS_WINDOW_SEC } = await import("../src/forcesell.js");
const { ForceSellTracker } = await import("../src/forcesell.js");
const { getDb } = await import("../src/db.js");

let pass = 0,
  fail = 0;
const check = (n, c, e) => {
  c ? (pass++, console.log("  [PASS] " + n + (e ? " " + e : ""))) : (fail++, console.log("  [FAIL] " + n + (e ? " " + e : "")));
};
const DAY = 86400;

console.log("【windowInfo 窗口判定】");
{
  check("第 0 天：窗口 0 无义务", windowInfo(0).window === 0 && windowInfo(0).cumBps === 0);
  check("第 14.9 天：窗口 0", windowInfo(14 * DAY + 86000).window === 0);
  check("第 15 天：窗口 1 目标 20%", windowInfo(15 * DAY).window === 1 && windowInfo(15 * DAY).cumBps === 2000);
  check("第 30 天：窗口 2 累计 30%", windowInfo(30 * DAY).window === 2 && windowInfo(30 * DAY).cumBps === 3000);
  check("第 45 天：窗口 3 累计 40%", windowInfo(45 * DAY).window === 3 && windowInfo(45 * DAY).cumBps === 4000);
  check("第 60 天：窗口 4 累计 60%", windowInfo(60 * DAY).window === 4 && windowInfo(60 * DAY).cumBps === 6000);
  check("第 100 天：仍窗口 4", windowInfo(100 * DAY).window === 4);
}

console.log("【computeForceSell 应卖量/风险判定】");
{
  const now = 1_000_000_000;
  // 场景：余额 10000 ZYT，未到期（第 5 天），卖 0 → 无风险
  let cs = computeForceSell(10000n * 10n ** 18n, 0n, now - 5 * DAY, now);
  check("未到期无风险", cs.atRisk === false && cs.required === 0n);
  // 场景：第 20 天（窗口1 目标20%），余额 10000，卖 1500（< 2000）→ 有风险
  cs = computeForceSell(10000n * 10n ** 18n, 1500n * 10n ** 18n, now - 20 * DAY, now);
  check("窗口1 卖 15% 未达 20% → 风险", cs.atRisk === true);
  check("应卖量 = 余额×20%", cs.required === 2000n * 10n ** 18n, "required=" + cs.required);
  // 场景：第 20 天，卖 2500（≥ 2000）→ 无风险
  cs = computeForceSell(10000n * 10n ** 18n, 2500n * 10n ** 18n, now - 20 * DAY, now);
  check("窗口1 卖 25% 达标 → 无风险", cs.atRisk === false);
  // 场景：第 35 天（窗口2 累计 30%），余额 10000，卖 2500（< 3000）→ 风险
  cs = computeForceSell(10000n * 10n ** 18n, 2500n * 10n ** 18n, now - 35 * DAY, now);
  check("窗口2 累计 25% 未达 30% → 风险", cs.atRisk === true && cs.required === 3000n * 10n ** 18n);
  // 场景：第 70 天（窗口4 累计 60%），余额 10000，卖 6000 → 达标；卖 5000 → 风险
  cs = computeForceSell(10000n * 10n ** 18n, 6000n * 10n ** 18n, now - 70 * DAY, now);
  check("窗口4 卖 60% 达标", cs.atRisk === false && cs.progressBps === 10000);
  cs = computeForceSell(10000n * 10n ** 18n, 5000n * 10n ** 18n, now - 70 * DAY, now);
  check("窗口4 卖 50% → 风险", cs.atRisk === true && cs.progressBps === 8333);
}

console.log("【ForceSellTracker stub 集成（同步入库 + 预警）】");
{
  // 捕获 [ALERT]
  const alerts = [];
  const origWarn = console.warn;
  console.warn = (m) => {
    if (typeof m === "string" && m.includes("[ALERT]")) alerts.push(m);
    origWarn(m);
  };
  // stub 链上数据：2 个用户
  const users = [
    { addr: "0x1111111111111111111111111111111111111111", firstReceive: 1_000_000_000 - 20 * DAY, sold: 1000n * 10n ** 18n, bal: 10000n * 10n ** 18n, sellCount: 1, totalSell: 1000n * 10n ** 18n }, // 窗口1 卖10% < 20% → 风险
    { addr: "0x2222222222222222222222222222222222222222", firstReceive: 1_000_000_000 - 5 * DAY, sold: 0n, bal: 5000n * 10n ** 18n, sellCount: 0, totalSell: 0n }, // 未到期 → 无风险
  ];
  const now = Math.floor(Date.now() / 1000);
  // 注意：stub 的 firstReceive 用相对 now 计算，避免时间漂移
  const stubProvider = {};
  const stubForceSell = {
    firstReceiveTime: async (a) =>
      BigInt(a === users[0].addr.toLowerCase() ? now - 20 * DAY : now - 5 * DAY),
    soldAmount: async (a) => (a === users[0].addr.toLowerCase() ? users[0].sold : 0n),
    initialized: async () => true,
  };
  const stubZyt = {
    getUserCount: async () => 2n,
    getUserAt: async (i) => users[Number(i)].addr,
    balanceOf: async (a) => (a === users[0].addr.toLowerCase() ? users[0].bal : users[1].bal),
    sellInfo: async (a) =>
      a === users[0].addr.toLowerCase() ? [1n, users[0].totalSell, 0n, 0n, 0n, 0n] : [0n, 0n, 0n, 0n, 0n, 0n],
  };
  const tracker = new ForceSellTracker({ provider: stubProvider });
  tracker.forceSell = stubForceSell; // 注入 stub
  tracker.zyt = stubZyt;
  const r = await tracker.syncOnce();
  check("同步 2 用户", r.users === 2, "users=" + r.users);
  check("识别 1 个风险用户", r.atRisk === 1, "atRisk=" + r.atRisk);
  // 查库
  const db = await getDb();
  const row = await db.get("SELECT * FROM force_sell WHERE address=?", ["0x1111111111111111111111111111111111111111"]);
  check("风险用户入库 current_window=1", row && row.current_window === 1, "window=" + (row && row.current_window));
  check("风险用户 at_risk=1", row && row.at_risk === 1);
  check("应卖量记录正确", row && row.required_sell === "2000000000000000000000", "required=" + (row && row.required_sell));
  // 预警触发
  const alerted = await tracker.checkAlerts();
  check("预警触发 1 条", alerted === 1 && alerts.filter((a) => a.includes("ForceSell")).length === 1);
  // 冷却：立即再查 → 不重复
  const alerted2 = await tracker.checkAlerts();
  check("冷却期内不重复预警", alerted2 === 0);
  // 冷却过期（模拟）后重新预警
  tracker.cooldown.clear();
  const alerted3 = await tracker.checkAlerts();
  check("冷却过期后可再预警", alerted3 === 1);
}

console.log("");
console.log("结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
