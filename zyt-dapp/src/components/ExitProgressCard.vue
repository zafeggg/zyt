<template>
  <div class="panel exit-card">
    <div class="panel-title">{{ $t("home.exitTitle") }}</div>

    <!-- 静态出局（2 倍）：累计到账 vs 出局线 -->
    <div class="exit-block">
      <div class="exit-head">
        <span>{{ $t("home.staticExitTitle") }}</span>
        <span class="exit-pct" :class="{ done: staticDone }">{{ staticPct }}%</span>
      </div>
      <div class="exit-bar">
        <div class="bar-fill static" :style="{ width: staticPct + '%' }" />
      </div>
      <div class="exit-meta">
        <span>{{ $t("home.exitReceived") }}: {{ fmtU(user.withdrawTotal) }} U</span>
        <span>{{ $t("home.exitCap") }}: {{ fmtU(user.withdrawCap) }} U</span>
      </div>
      <div v-if="user.isExited" class="exit-flag">{{ $t("home.staticExitedFlag") }}</div>
    </div>

    <!-- 动态出局（5 倍）：推荐额度消耗 -->
    <div class="exit-block">
      <div class="exit-head">
        <span>{{ $t("home.dynamicExitTitle") }}</span>
        <span class="exit-pct" :class="{ done: dynamicDone }">{{ dynamicPct }}%</span>
      </div>
      <div class="exit-bar">
        <div class="bar-fill dynamic" :style="{ width: dynamicPct + '%' }" />
      </div>
      <div class="exit-meta">
        <span>{{ $t("home.dynamicUsed") }}: {{ fmtU(user.dynamicWithdrawn) }} U</span>
        <span>{{ $t("home.dynamicTotal") }}: {{ fmtU(user.dynamicQuota) }} U</span>
      </div>
      <div v-if="user.dynamicExited" class="exit-flag warn">
        {{ $t("home.dynamicExhaustedFlag") }}
      </div>
      <div v-else class="exit-note">{{ $t("home.dynamicNote") }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { UserStats } from "../composables/usePoolData";

/** v9.1 出局进度卡：静态 2 倍（累计到账/出局线）+ 动态 5 倍（推荐额度消耗） */
const props = defineProps<{ user: UserStats }>();

const num = (v?: string) => parseFloat(v || "0") || 0;
const fmtU = (v?: string) => num(v).toFixed(2);

const staticPct = computed(() => {
  const cap = num(props.user.withdrawCap);
  if (cap <= 0) return "0.0";
  return Math.min(100, (num(props.user.withdrawTotal) / cap) * 100).toFixed(1);
});
const staticDone = computed(() => parseFloat(staticPct.value) >= 100 || props.user.isExited);

const dynamicPct = computed(() => {
  const quota = num(props.user.dynamicQuota);
  if (quota <= 0) return "0.0";
  return Math.min(100, (num(props.user.dynamicWithdrawn) / quota) * 100).toFixed(1);
});
const dynamicDone = computed(() => parseFloat(dynamicPct.value) >= 100 || props.user.dynamicExited);
</script>

<style scoped lang="scss">
.exit-card {
  .exit-block {
    padding: 8px 0;
    & + .exit-block {
      border-top: 1px dashed var(--border);
      margin-top: 6px;
      padding-top: 12px;
    }
    .exit-head {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-primary);
      .exit-pct {
        font-weight: 700;
        color: var(--gold);
        &.done {
          color: #f47a77;
        }
      }
    }
    .exit-bar {
      height: 6px;
      background: var(--bg-card);
      border-radius: 3px;
      margin: 8px 0;
      overflow: hidden;
      .bar-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.4s;
        &.static {
          background: linear-gradient(90deg, #f5c15d, #e8954a);
        }
        &.dynamic {
          background: linear-gradient(90deg, #7ee0a3, #3bb273);
        }
      }
    }
    .exit-meta {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-secondary);
    }
    .exit-flag {
      margin-top: 6px;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      background: rgba(226, 75, 74, 0.1);
      border: 1px solid rgba(226, 75, 74, 0.3);
      color: #f47a77;
      &.warn {
        background: rgba(245, 193, 93, 0.1);
        border-color: rgba(245, 193, 93, 0.3);
        color: var(--gold);
      }
    }
    .exit-note {
      margin-top: 6px;
      font-size: 10px;
      line-height: 1.5;
      color: var(--text-tertiary);
    }
  }
}
</style>
