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

const reductionPct = computed(() => {
  const gst = parseFloat(poolStats.value.poolGST) || 0;
  const snap = parseFloat(poolStats.value.snapshotGST) || 0;
  if (snap <= 0) return "0";
  return ((snap - gst) / snap) * 100 >= 0 ? (((snap - gst) / snap) * 100).toFixed(1) : "0";
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
