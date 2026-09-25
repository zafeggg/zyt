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
        <div class="num red">{{ lpBurned }}</div>
        <div class="label">{{ $t("home.lpBurned") }}</div>
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
// 2026-09-25 修复：原实现对 "0" 也判空（显示 --），导致「总销毁数 / 今日入单」在有真实 0 值时误显示无数据。
//   现按「无数据（undefined/null/空串）→ --；有值（含 0）→ 正常格式化」处理。
function humanOf(wei?: string): string | null {
  if (wei === undefined || wei === null || wei === "") return null;
  try {
    return formatEther(BigInt(wei));
  } catch {
    return null;
  }
}
const burned = computed(() => {
  const h = humanOf(props.pool.burned);
  return h === null ? "--" : fmtCompact(h);
});
const today = computed(() => {
  const h = humanOf(props.pool.todayDeposit);
  return h === null ? "--" : fmtNum(h, 2);
});
const networkPower = computed(() => {
  const h = humanOf(props.pool.networkPower);
  return h === null ? "--" : fmtCompact(h);
});
// v9：累计销毁 LP 凭证（入金 60% 组 LP 后销毁；两个分支均已在 usePoolData 转 human）
const lpBurned = computed(() => {
  const h = props.pool.totalLpBurned;
  return h === undefined || h === null || h === "" ? "--" : fmtCompact(h);
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
