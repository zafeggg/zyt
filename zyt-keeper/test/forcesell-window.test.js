/**
 * v9.2 卖币窗口链下口径单测（node:test，零依赖）
 *
 * 重点：日历换算必须与合约 ZYTForceSell._beijingDate（Hinnant civil_from_days）完全一致，
 *       否则链上判定「今日是卖币日」而链下算出「不是」，预警与结算预判整体错位。
 *       用例时间锚与合约侧用例 test 12（2026-11-14 → 窗口 id 20261114）对齐。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beijingDate,
  windowIdOf,
  beijingDayStart,
  beijingDayEnd,
  pendingSettleWindowId,
  nextWindowFrom,
  windowPhase,
  computeWindowQuota,
  computeForceSell,
  TIER_FIRST_BPS,
  TIER_STEP_BPS,
  TIER_AFTER60_BPS,
} from "../src/forcesell.js";

/** 北京时间 y-m-d hh:mm 对应的 UTC 秒 */
const bj = (y, m, d, hh = 0, mm = 0) => Math.floor(Date.UTC(y, m - 1, d, hh - 8, mm) / 1000);
const E18 = 10n ** 18n;

test("beijingDate：北京日换算（跨日/跨月/闰年）", () => {
  assert.deepEqual(beijingDate(bj(2026, 11, 14, 0, 0)), { y: 2026, m: 11, d: 14 });
  assert.deepEqual(beijingDate(bj(2026, 11, 14, 23, 59)), { y: 2026, m: 11, d: 14 });
  assert.deepEqual(beijingDate(bj(2026, 11, 15, 0, 0)), { y: 2026, m: 11, d: 15 });
  assert.deepEqual(beijingDate(bj(2026, 3, 1, 0, 0)), { y: 2026, m: 3, d: 1 });
  assert.deepEqual(beijingDate(bj(2026, 1, 1, 0, 0)), { y: 2026, m: 1, d: 1 });
  assert.deepEqual(beijingDate(bj(2024, 2, 29, 12, 0)), { y: 2024, m: 2, d: 29 }); // 闰年
});

test("windowIdOf：仅 14/28 日为卖币日，其余为 0", () => {
  assert.equal(windowIdOf(bj(2026, 11, 14, 0, 0)), 20261114); // 与合约用例 test 12 对齐
  assert.equal(windowIdOf(bj(2026, 11, 14, 23, 59)), 20261114);
  assert.equal(windowIdOf(bj(2026, 11, 28, 12, 0)), 20261128);
  assert.equal(windowIdOf(bj(2026, 11, 15, 0, 0)), 0);
  assert.equal(windowIdOf(bj(2026, 11, 13, 23, 59)), 0);
  assert.equal(windowIdOf(bj(2026, 12, 14, 0, 0)), 20261214);
});

test("日边界：北京日 00:00 与 24:00（UTC 秒）", () => {
  const t = bj(2026, 11, 14, 9, 30);
  assert.equal(beijingDayStart(t), bj(2026, 11, 14, 0, 0));
  assert.equal(beijingDayEnd(t), bj(2026, 11, 15, 0, 0));
});

test("pendingSettleWindowId：昨日为卖币日则返回其 id（与合约 _previousWindowId 同口径）", () => {
  assert.equal(pendingSettleWindowId(bj(2026, 11, 15, 0, 30)), 20261114);
  assert.equal(pendingSettleWindowId(bj(2026, 11, 15, 23, 59)), 20261114);
  assert.equal(pendingSettleWindowId(bj(2026, 11, 29, 1, 0)), 20261128);
  assert.equal(pendingSettleWindowId(bj(2026, 11, 16, 0, 0)), 0);
  assert.equal(pendingSettleWindowId(bj(2026, 11, 14, 12, 0)), 0); // 昨天是 13 日
});

test("windowPhase：open / pending / idle 三态与下一窗口", () => {
  const open = windowPhase(bj(2026, 11, 14, 10, 0));
  assert.equal(open.phase, "open");
  assert.equal(open.windowId, 20261114);
  assert.equal(open.endSec, bj(2026, 11, 15, 0, 0));
  // nextWindowFrom 语义为「含当日」：窗口开放中时 next = 今日（daysUntil 0）
  assert.equal(open.nextWindowId, 20261114);
  assert.equal(open.daysUntilNext, 0);

  const pending = windowPhase(bj(2026, 11, 15, 0, 30));
  assert.equal(pending.phase, "pending");
  assert.equal(pending.windowId, 20261114); // 待结算窗口
  assert.equal(pending.nextWindowId, 20261128);

  const idle = windowPhase(bj(2026, 11, 16, 12, 0));
  assert.equal(idle.phase, "idle");
  assert.equal(idle.windowId, 0);
  assert.equal(idle.nextWindowId, 20261128);
  assert.equal(idle.daysUntilNext, 12);
});

test("nextWindowFrom：命中当日与向后查找", () => {
  assert.equal(nextWindowFrom(bj(2026, 11, 14, 10, 0)).daysUntil, 0);
  const n = nextWindowFrom(bj(2026, 11, 16, 10, 0));
  assert.equal(n.windowId, 20261128);
  assert.equal(n.daysUntil, 12);
  assert.equal(n.startSec, bj(2026, 11, 28, 0, 0));
});

test("computeWindowQuota：锁存命中用锁存值，未命中用余额 × 档位", () => {
  const bal = 1_000n * E18;
  // 命中锁存：quota=200、sold=50 → 欠 150
  const l = computeWindowQuota({
    balance: bal,
    tierBps: TIER_FIRST_BPS,
    latchedWindowId: 20261114,
    latchedQuota: 200n * E18,
    latchedSold: 50n * E18,
    targetWindowId: 20261114,
  });
  assert.equal(l.latched, true);
  assert.equal(l.quota, 200n * E18);
  assert.equal(l.sold, 50n * E18);
  assert.equal(l.deficit, 150n * E18);
  assert.equal(l.progressBps, 2500); // 50/200

  // 未命中（该窗口无活动）：quota = 余额 × 20%，sold = 0，欠 = quota
  const n = computeWindowQuota({
    balance: bal,
    tierBps: TIER_FIRST_BPS,
    latchedWindowId: 0,
    latchedQuota: 0n,
    latchedSold: 0n,
    targetWindowId: 20261114,
  });
  assert.equal(n.latched, false);
  assert.equal(n.quota, 200n * E18);
  assert.equal(n.deficit, 200n * E18);

  // 已超额度卖出（转账视同卖出不受额度阻断）→ 欠账为 0，进度 > 100%
  const over = computeWindowQuota({
    balance: bal,
    tierBps: TIER_STEP_BPS,
    latchedWindowId: 20261114,
    latchedQuota: 100n * E18,
    latchedSold: 500n * E18,
    targetWindowId: 20261114,
  });
  assert.equal(over.deficit, 0n);
  assert.ok(over.progressBps > 10000);
});

test("computeForceSell：窗口日无活动 → 首期 20% 全额欠账且 atRisk", () => {
  const bal = 500n * E18;
  const cs = computeForceSell({
    balance: bal,
    tierBps: TIER_FIRST_BPS,
    latchedWindowId: 0,
    latchedQuota: 0n,
    latchedSold: 0n,
    nowSec: bj(2026, 11, 14, 10, 0),
  });
  assert.equal(cs.phase, "open");
  assert.equal(cs.targetWindowId, 20261114);
  assert.equal(cs.quota, 100n * E18); // 500 × 20%
  assert.equal(cs.deficit, 100n * E18);
  assert.equal(cs.atRisk, true);
  assert.equal(cs.deadlineSec, bj(2026, 11, 15, 0, 0));
});

test("computeForceSell：非卖币日 → 无目标窗口、不产生风险", () => {
  const cs = computeForceSell({
    balance: 500n * E18,
    tierBps: TIER_STEP_BPS,
    latchedWindowId: 0,
    latchedQuota: 0n,
    latchedSold: 0n,
    nowSec: bj(2026, 11, 16, 10, 0),
  });
  assert.equal(cs.phase, "idle");
  assert.equal(cs.targetWindowId, 0);
  assert.equal(cs.atRisk, false);
  assert.equal(cs.deadlineSec, 0);
  assert.equal(cs.daysUntilNext, 12);
});

test("computeForceSell：结算日评估刚结束窗口（pending 阶段 atRisk）", () => {
  const cs = computeForceSell({
    balance: 500n * E18,
    tierBps: TIER_FIRST_BPS,
    latchedWindowId: 0,
    latchedQuota: 0n,
    latchedSold: 0n,
    nowSec: bj(2026, 11, 15, 0, 30),
  });
  assert.equal(cs.phase, "pending");
  assert.equal(cs.targetWindowId, 20261114);
  assert.equal(cs.deficit, 100n * E18); // 首期 20% 未卖足 → 待销毁
  assert.equal(cs.atRisk, true);
});

test("computeForceSell：已卖足 → 零欠账、不告警", () => {
  const cs = computeForceSell({
    balance: 500n * E18,
    tierBps: TIER_FIRST_BPS,
    latchedWindowId: 20261114,
    latchedQuota: 100n * E18,
    latchedSold: 100n * E18,
    nowSec: bj(2026, 11, 14, 20, 0),
  });
  assert.equal(cs.deficit, 0n);
  assert.equal(cs.atRisk, false);
  assert.equal(cs.progressBps, 10000);
});

test("档位常量与合约一致（后端兜底展示用）", () => {
  assert.equal(TIER_FIRST_BPS, 2000);
  assert.equal(TIER_STEP_BPS, 1000);
  assert.equal(TIER_AFTER60_BPS, 200);
});
