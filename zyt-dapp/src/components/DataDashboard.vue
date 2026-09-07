<template>
  <div class="panel dashboard">
    <div class="panel-title">
      <span>{{ $t("home.title") }}</span>
      <SlippageBadge :slippage="pool.slippage" />
    </div>

    <div class="stat-grid">
      <div class="col">
        <div class="num">{{ fmtCompact(pool.poolZYT) }}</div>
        <div class="label">{{ $t("home.currentSupply") }}</div>
      </div>
      <div class="col">
        <div class="num red">{{ burned }}</div>
        <div class="label">{{ $t("home.totalBurned") }}</div>
      </div>
      <div class="col">
        <div class="num">{{ today }}</div>
        <div class="label">{{ $t("home.todayDeposit") }}</div>
      </div>
      <div class="col">
        <div class="num gold">{{ user ? fmtCompact(user.power) : "--" }}</div>
        <div class="label">{{ $t("home.myPower") }}</div>
      </div>
      <div class="col">
        <div class="num">{{ networkPower }}</div>
        <div class="label">{{ $t("home.networkPower") }}</div>
      </div>
      <div class="col">
        <div class="num">{{ user ? fmtNum(user.lpQuota, 0) : "--" }}</div>
        <div class="label">{{ $t("home.myLp") }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import SlippageBadge from "./SlippageBadge.vue";
import type { PoolStats, UserStats } from "../composables/usePoolData";

const props = defineProps<{
  pool: PoolStats;
  user: UserStats | null;
}>();

// 占位统计：keeper /stats 尚未返回 burned/todayDeposit/networkPower，待 #8 扩展后接入真值。
// 显示 "--" 避免 0 冒充真实统计（v13）
const burned = computed(() => "--");
const today = computed(() => "--");
const networkPower = computed(() => "--");

function fmtCompact(n: string, d = 2): string {
  const v = parseFloat(n);
  if (isNaN(v)) return "0";
  if (v >= 1e8) return (v / 1e8).toFixed(d) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(d) + "万";
  return v.toFixed(0);
}
function fmtNum(n: string, d = 4): string {
  const v = parseFloat(n);
  if (isNaN(v)) return "0";
  return v >= 1000 ? v.toFixed(2) : v.toFixed(d);
}
</script>

<style scoped lang="scss">
.red {
  color: var(--red-up) !important;
}
.gold {
  color: var(--gold) !important;
}
</style>
