<template>
  <div class="panel quota-card" :class="{ exhausted }">
    <div class="panel-title">
      <span>{{ $t("home.dynamicQuota") }}</span>
    </div>
    <div class="quota-body">
      <div class="quota-num">
        <span class="big">{{ remain }}</span>
        <span class="unit">U</span>
      </div>
      <div class="quota-bar">
        <div class="bar-inner" :style="{ width: pct + '%' }" />
      </div>
      <div class="quota-meta">
        <span>{{ $t("home.quotaTotal") }}: {{ totalFmt }} U</span>
        <span>{{ $t("home.quotaUsed") }}: {{ usedFmt }} U</span>
      </div>
      <!-- v17：额度用尽优先提示（卖出亦可消耗额度，阶段 1 也可能出现）；否则提示阶段 1 不可兑换 -->
      <div v-if="exhausted" class="exhaust-tip">
        {{ $t("home.quotaExhausted") }}
        <van-button size="mini" type="primary" round @click="$emit('reinvest')">
          {{ $t("home.reinvest") }}
        </van-button>
      </div>
      <div v-else-if="stageBlocked" class="stage-tip">{{ $t("home.stage1ConvertTip") }}</div>
    </div>

    <!-- v9.2 卖币窗口进度（keeper API 数据；每月 14/28 日历窗 + 档位额度） -->
    <div v-if="forceSell && forceSell.status === 'ok'" class="fs-body">
      <div class="fs-title">
        <span>{{ $t("home.forceSellTitle") }}</span>
        <span class="fs-window" :class="{ risk: forceSell.atRisk }">{{ phaseText }}</span>
      </div>
      <!-- 卖币日前 3 天强提醒 -->
      <div v-if="showAdvance" class="fs-reminder">
        {{ $t("home.forceSellAdvance", { n: forceSell.daysUntilNext }) }}
      </div>
      <div class="fs-bar">
        <div
          class="fs-bar-inner"
          :class="{ risk: forceSell.atRisk }"
          :style="{ width: Math.min(forceSell.progressPct, 100) + '%' }"
        />
      </div>
      <div class="fs-meta">
        <span>{{ $t("home.forceSellSold", { n: fmtZyt(forceSell.soldAmount) }) }}</span>
        <span>{{ $t("home.forceSellQuota", { n: fmtZyt(forceSell.quota) }) }}</span>
      </div>
      <div v-if="deficitWei > 0n" class="fs-diff">
        {{ $t("home.forceSellDiff", { n: fmtZyt(deficitWei.toString()) }) }}
      </div>
      <div class="fs-meta fs-sub">
        <span>{{ $t("home.forceSellTier", { n: tierPct }) }}</span>
        <span>{{ $t("home.forceSellDeadline") }}: {{ fmtDeadline(forceSell) }}</span>
      </div>
      <div class="fs-note">{{ $t("home.forceSellBase") }}</div>
      <div v-if="forceSell.atRisk" class="fs-risk">
        {{ $t("home.forceSellRisk") }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { formatEther } from "ethers";
import type { KeeperForceSell } from "../composables/useKeeperApi";

/**
 * v9.1 买入额度卡（2026-09-24 语义修正：v8 的「算力兑换」已删除，买入消耗买额 buyQuota 1:1）：
 * - 可用买额 = 合约 userInfo[5]（buyQuota - buyUsed，keeper /user 补充链上读）
 * - 累计买额 = 入金累计（buyQuotaRate 当前 1:1，费率调整后此处需同步）
 * - 已用买额 = 累计买额 − 可用买额
 */
const props = defineProps<{
  /** 可用买入额度（human，userInfo[5]） */
  buyQuotaLeft: string;
  /** 入金累计（human；当前 buyQuotaRate=100% 时等于累计买额） */
  depositTotal: string;
  /** 当前阶段（1/2/3），阶段 1 禁买 */
  stage: number;
  forceSell?: KeeperForceSell | null;
}>();

const emit = defineEmits<{ (e: "reinvest"): void }>();

const { t } = useI18n();

const leftNum = computed(() => parseFloat(props.buyQuotaLeft) || 0);
const totalNum = computed(() => parseFloat(props.depositTotal) || 0);

const remain = computed(() => leftNum.value.toFixed(2));
const usedFmt = computed(() => Math.max(0, totalNum.value - leftNum.value).toFixed(2));
const totalFmt = computed(() => totalNum.value.toFixed(2));
const stageBlocked = computed(() => props.stage === 1);
const exhausted = computed(() => totalNum.value > 0 && leftNum.value <= 0);
const pct = computed(() => {
  if (totalNum.value <= 0) return 0;
  return Math.min(100, ((totalNum.value - leftNum.value) / totalNum.value) * 100);
});

/** 压缩显示 ZYT 数量（wei → 亿/万） */
function fmtZyt(wei: string): string {
  try {
    const v = parseFloat(formatEther(BigInt(wei || "0")));
    if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
    if (v >= 1e4) return (v / 1e4).toFixed(2) + "万";
    return v.toFixed(2);
  } catch {
    return "0";
  }
}

/** v9.2：阶段文案（open=今日卖币日 / pending=今日结算中 / idle=非卖币日） */
const phaseText = computed(() => {
  const p = props.forceSell?.phase;
  if (p === "open") return t("home.forceSellPhaseOpen");
  if (p === "pending") return t("home.forceSellPhasePending");
  return t("home.forceSellPhaseIdle");
});

/** 卖币日前 3 天强提醒：非卖币日且距下一次卖币日 1~3 天 */
const showAdvance = computed(() => {
  const fs = props.forceSell;
  if (!fs || fs.phase !== "idle") return false;
  const d = Number(fs.daysUntilNext ?? -1);
  return d >= 1 && d <= 3;
});

/** 当期欠额（v9.2 后端直出 deficit；兼容旧后端时回退 quota − soldAmount） */
const deficitWei = computed(() => {
  const fs = props.forceSell;
  if (!fs) return 0n;
  try {
    if (fs.deficit !== undefined) return BigInt(fs.deficit || "0");
    const req = BigInt(fs.quota || fs.requiredSell || "0");
    const sold = BigInt(fs.soldAmount || "0");
    return req > sold ? req - sold : 0n;
  } catch {
    return 0n;
  }
});

/** 档位展示（bps → %）：2000→20%、1000→10%、200→2% */
const tierPct = computed(() => `${Number(props.forceSell?.tierBps ?? 0) / 100}%`);

function fmtTs(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 截止时间显示
 *  v21 教训保留：deadlineSec 是「剩余秒数」，windowEndAt 才是「绝对时间戳」，二者不可混用。
 *  v9.2：卖币日窗口结束（open/pending）显示窗口截止；非卖币日显示下一次窗口时间。
 */
function fmtDeadline(fs: KeeperForceSell): string {
  const abs = Number(fs.windowEndAt || 0);
  if (abs > 0) return fmtTs(abs);
  const next = Number(fs.nextWindowAt || 0);
  if (next > 0) return fmtTs(next);
  return "-";
}
</script>

<style scoped lang="scss">
.quota-card {
  .quota-body {
    .quota-num {
      display: flex;
      align-items: baseline;
      gap: 4px;
      .big {
        font-size: 26px;
        font-weight: 700;
        color: var(--gold);
      }
      .unit {
        font-size: 13px;
        color: var(--text-secondary);
      }
    }
    .quota-bar {
      height: 6px;
      background: var(--bg-card);
      border-radius: 3px;
      margin: 10px 0 8px;
      overflow: hidden;
      .bar-inner {
        height: 100%;
        background: linear-gradient(90deg, #f5c15d, #e8954a);
        border-radius: 3px;
        transition: width 0.4s;
      }
    }
    .quota-meta {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-secondary);
    }
    .stage-tip {
      margin-top: 10px;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      background: rgba(245, 193, 93, 0.1);
      border: 1px solid rgba(245, 193, 93, 0.3);
      color: var(--gold);
      font-size: 12px;
      line-height: 1.5;
    }
    .exhaust-tip {
      margin-top: 10px;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      background: rgba(226, 75, 74, 0.1);
      border: 1px solid rgba(226, 75, 74, 0.3);
      color: #f47a77;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
  }
  // #7 强制卖出
  .fs-body {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px dashed var(--border);
    .fs-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: var(--text-primary);
      .fs-window {
        font-size: 11px;
        color: var(--text-secondary);
        &.risk {
          color: #f47a77;
        }
      }
    }
    .fs-bar {
      height: 6px;
      background: var(--bg-card);
      border-radius: 3px;
      margin: 8px 0;
      overflow: hidden;
      .fs-bar-inner {
        height: 100%;
        background: linear-gradient(90deg, #6ec6ff, #3b9eff);
        border-radius: 3px;
        transition: width 0.4s;
        &.risk {
          background: linear-gradient(90deg, #f47a77, #e24b4a);
        }
      }
    }
    .fs-meta {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-secondary);
      &.fs-sub {
        margin-top: 2px;
        color: var(--text-tertiary);
      }
    }
    .fs-diff {
      margin-top: 4px;
      font-size: 11px;
      color: #f47a77;
      font-weight: 600;
    }
    // v9.2：卖币日前 3 天强提醒
    .fs-reminder {
      margin-top: 8px;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      background: rgba(245, 193, 93, 0.12);
      border: 1px solid rgba(245, 193, 93, 0.35);
      color: var(--gold);
      font-size: 11px;
      line-height: 1.5;
    }
    .fs-note {
      margin-top: 6px;
      font-size: 10px;
      line-height: 1.5;
      color: var(--text-tertiary);
    }
    .fs-risk {
      margin-top: 8px;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      background: rgba(226, 75, 74, 0.1);
      border: 1px solid rgba(226, 75, 74, 0.3);
      color: #f47a77;
      font-size: 11px;
    }
  }
}
</style>
