<template>
  <div class="swap-page">
    <WalletHeader />
    <SwapPanel :slippage="poolStats.slippage" :reduction-pct="reductionPct" :refresh="refresh" />
    <div class="hint">{{ $t("swap.depositRange", { min: "100", max: "500" }) }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import WalletHeader from "../components/WalletHeader.vue";
import SwapPanel from "../components/SwapPanel.vue";
import { usePoolData } from "../composables/usePoolData";

const { poolStats, refresh } = usePoolData();

/**
 * v9：与合约 getCurrentSlippage 同口径的「池 USDT 较峰值基准回落比例」。
 * 基准 = max(初始 2.1 万 U, 历史峰值)；当前池 U 回落达 1/2/3/4% → 滑点 10/20/40/80%。
 */
const reductionPct = computed(() => {
  const cur = parseFloat(poolStats.value.poolUSDT || "0") || 0;
  const peak = parseFloat(poolStats.value.peakPoolUSDT || "0") || 0;
  if (peak <= 0 || cur >= peak) return "0";
  const pct = ((peak - cur) / peak) * 100;
  return pct > 0 ? pct.toFixed(1) : "0";
});

onMounted(() => refresh());
</script>

<style scoped lang="scss">
.hint {
  text-align: center;
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 6px;
}
</style>
