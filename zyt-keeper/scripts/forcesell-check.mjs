/**
 * v9.2 卖币窗口追踪自检（#7）
 *
 * 两层验证：
 *   ① 纯函数日历口径（与合约 ZYTForceSell 同算法）——完整用例见 test/forcesell-window.test.js
 *   ② ForceSellTracker 集成（stub 链上数据 → syncOnce 入库 → checkAlerts 预警）
 *
 * 时间锚固定为「2026-11-14 10:00 北京」（卖币日），并显式传给 syncOnce，
 * 使自检结果不随运行当天日期漂移。
 *
 * 运行：node scripts/forcesell-check.mjs（或 npm run check:forcesell）
 */
process.env.DB_URL = ":memory:";

const { windowIdOf, pendingSettleWindowId, windowPhase, computeForceSell, ForceSellTracker } = await import(
  "../src/forcesell.js"
);
const { getDb } = await import("../src/db.js");

let pass = 0,
  fail = 0;
const check = (n, c, e) => {
  c ? (pass++, console.log("  [PASS] " + n + (e ? " " + e : ""))) : (fail++, console.log("  [FAIL] " + n + (e ? " " + e : "")));
};
const E18 = 10n ** 18n;
/** 北京时间 y-m-d hh:mm 的 UTC 秒 */
const bj = (y, m, d, hh = 0, mm = 0) => Math.floor(Date.UTC(y, m - 1, d, hh - 8, mm) / 1000);

console.log("【① 日历口径（与合约 _beijingDate 同算法）】");
{
  const winDay = bj(2026, 11, 14, 10, 0);
  check("2026-11-14 10:00 北京 → 卖币日 20261114", windowIdOf(winDay) === 20261114);
  check("2026-11-15 00:30 北京 → 昨日窗口 20261114", pendingSettleWindowId(bj(2026, 11, 15, 0, 30)) === 20261114);
  check("2026-11-16 → 非卖币日", windowIdOf(bj(2026, 11, 16, 10, 0)) === 0);
  const ph = windowPhase(bj(2026, 11, 16, 10, 0));
  check("2026-11-16 → idle 且下一窗口为 11-28", ph.phase === "idle" && ph.nextWindowId === 20261128, `daysUntil=${ph.daysUntilNext}`);
}

console.log("【② computeForceSell（当期额度 / 欠账 / 风险）】");
{
  const now = bj(2026, 11, 14, 10, 0);
  // 首期未卖出：额度 = 余额 × 20%
  let cs = computeForceSell({
    balance: 10000n * E18,
    tierBps: 2000,
    latchedWindowId: 0,
    latchedQuota: 0n,
    latchedSold: 0n,
    nowSec: now,
  });
  check("首期额度 = 余额 × 20%", cs.quota === 2000n * E18, "quota=" + cs.quota);
  check("零卖出 → 全额欠账且 atRisk", cs.atRisk === true && cs.deficit === 2000n * E18);
  // 已卖足：无欠账、不告警
  cs = computeForceSell({
    balance: 10000n * E18,
    tierBps: 2000,
    latchedWindowId: 20261114,
    latchedQuota: 2000n * E18,
    latchedSold: 2000n * E18,
    nowSec: now,
  });
  check("卖足 → 零欠账不告警", cs.atRisk === false && cs.deficit === 0n && cs.progressBps === 10000);
  // 非卖币日：无目标窗口
  cs = computeForceSell({
    balance: 10000n * E18,
    tierBps: 1000,
    latchedWindowId: 0,
    latchedQuota: 0n,
    latchedSold: 0n,
    nowSec: bj(2026, 11, 16, 10, 0),
  });
  check("非卖币日无目标窗口", cs.targetWindowId === 0 && cs.atRisk === false);
}

console.log("【③ ForceSellTracker 集成（stub 链上数据 → 入库 → 预警）】");
{
  const alerts = [];
  const origWarn = console.warn;
  console.warn = (m) => {
    if (typeof m === "string" && m.includes("[ALERT]")) alerts.push(m);
    origWarn(m);
  };

  const now = bj(2026, 11, 14, 10, 0); // 卖币日锚点，显式传入 syncOnce
  const u1 = "0x1111111111111111111111111111111111111111"; // 当期零活动 → 应卖 20%
  const u2 = "0x2222222222222222222222222222222222222222"; // 当期已卖足 → 无风险
  const latched = {
    [u1]: [0n, 0n, 0n], // 无锁存
    [u2]: [20261114n, 2000n * E18, 2000n * E18], // 已锁存且卖足
  };
  const tracker = new ForceSellTracker({ provider: {} });
  tracker.forceSell = {
    currentWindow: async () => [20261114n, true],
    pendingSettleWindow: async () => 0n,
    windows: async (a) => latched[a.toLowerCase()],
    tierBpsOf: async () => 2000n,
    windowSettled: async () => false,
    keeper: async () => "0x0000000000000000000000000000000000000000",
  };
  const bals = { [u1]: 10000n * E18, [u2]: 10000n * E18 };
  tracker.zyt = {
    getUserCount: async () => 2n,
    getUserAt: async (i) => [u1, u2][Number(i)],
    balanceOf: async (a) => bals[a.toLowerCase()],
    sellInfo: async () => [1n, 0n, 0n, 0n, 0n, 0n],
  };

  const r = await tracker.syncOnce({ nowSec: now });
  check("同步 2 用户", r.users === 2, "users=" + r.users);
  check("阶段判定 = open", r.phase === "open", "phase=" + r.phase);
  check("识别 1 个风险用户", r.atRisk === 1, "atRisk=" + r.atRisk);

  const db = await getDb();
  const row = await db.get("SELECT * FROM force_sell WHERE address=?", [u1]);
  check("风险用户 window_id=20261114", row && Number(row.window_id) === 20261114, "window_id=" + (row && row.window_id));
  check("风险用户 phase=open", row && row.phase === "open");
  check("额度 = 余额 × 20%", row && row.quota === (2000n * E18).toString(), "quota=" + (row && row.quota));
  check("欠账 = 额度", row && row.deficit === (2000n * E18).toString());
  check("at_risk=1", row && Number(row.at_risk) === 1);
  check(
    "窗口截止 = 次日 00:00 北京",
    row && Number(row.deadline_sec) === bj(2026, 11, 15, 0, 0),
    "deadline=" + (row && row.deadline_sec)
  );

  const row2 = await db.get("SELECT * FROM force_sell WHERE address=?", [u2]);
  check("卖足用户不告警", row2 && Number(row2.at_risk) === 0);

  const alerted = await tracker.checkAlerts();
  check("预警触发 1 条", alerted === 1 && alerts.filter((a) => a.includes("ForceSell")).length === 1);
  const alerted2 = await tracker.checkAlerts();
  check("冷却期内不重复预警", alerted2 === 0);
  tracker.cooldown.clear();
  const alerted3 = await tracker.checkAlerts();
  check("冷却过期后可再预警", alerted3 === 1);
}

console.log("");
console.log("结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
