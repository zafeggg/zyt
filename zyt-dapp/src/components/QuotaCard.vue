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
        <span>{{ $t("home.quotaUsed") }}: {{ used }} U</span>
        <span>{{ $t("home.quotaRemain") }}: {{ remain }} U</span>
      </div>
      <div v-if="exhausted" class="exhaust-tip">
        ⚠️ {{ $t("home.quotaExhausted") }}
        <van-button size="mini" type="primary" round @click="$emit('reinvest')">
          {{ $t("home.reinvest") }}
        </van-button>
      </div>
    </div>

    <!-- #7 强制卖出进度（keeper API 数据） -->
    <div v-if="forceSell && forceSell.status === 'ok'" class="fs-body">
      <div class="fs-title">
        <span>{{ $t("home.forceSellTitle") }}</span>
        <span class="fs-window" :class="{ risk: forceSell.atRisk }">
          {{ forceSell.currentWindow === 0 ? $t("home.forceSellWindow0") : $t("home.forceSellWindow", { n: forceSell.currentWindow }) }}
        </span>
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
        <span>{{ $t("home.forceSellRequired", { n: fmtZyt(forceSell.requiredSell) }) }}</span>
      </div>
      <div v-if="forceSell.atRisk" class="fs-risk">
        {{ $t("home.forceSellRisk") }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { formatEther } from "ethers";
import type { KeeperForceSell } from "../composables/useKeeperApi";

const props = defineProps<{
  quota: string;
  used: string;
  forceSell?: KeeperForceSell | null;
}>();

const emit = defineEmits<{ (e: "reinvest"): void }>();

const remain = computed(() => {
  const q = parseFloat(props.quota) || 0;
  const u = parseFloat(props.used) || 0;
  return Math.max(0, q - u).toFixed(2);
});
const exhausted = computed(() => parseFloat(remain.value) <= 0 && parseFloat(props.quota) > 0);
const pct = computed(() => {
  const q = parseFloat(props.quota) || 0;
  const u = parseFloat(props.used) || 0;
  if (q <= 0) return 0;
  return Math.min(100, (u / q) * 100);
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
