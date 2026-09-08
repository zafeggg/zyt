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
import { formatEther } from "ethers";
import SlippageBadge from "./SlippageBadge.vue";
import type { PoolStats, UserStats } from "../composables/usePoolData";

const props = defineProps<{
  pool: PoolStats;
  user: UserStats | null;
}>();

// v14：真值接入（keeper /stats 扩展）；链上直连降级分支无此数据 → 保持 "--" 不冒充 0
function weiToHuman(wei?: string): string {
  if (!wei || wei === "0" || wei === "0x") return "";
  return formatEther(BigInt(wei));
}
const burned = computed(() => {
  const h = weiToHuman(props.pool.burned);
  return h ? fmtCompact(h) : "--";
});
const today = computed(() => {
  const h = weiToHuman(props.pool.todayDeposit);
  return h ? fmtNum(h, 2) : "--";
});
const networkPower = computed(() => {
  const h = weiToHuman(props.pool.networkPower);
  return h ? fmtCompact(h) : "--";
});

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
