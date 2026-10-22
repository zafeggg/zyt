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
 * v9.2b：与合约定档同口径的「减少量占固定基准 2.1 万 U 的百分比」。
 * 判据 = (上次 08:01 快照池U − 当前池U) ÷ 21,000 U；达 0.2/0.6/1.2/2.4% → 滑点 10/20/40/80%（当日 08:01 锁定）。
 * 展示值仅作参考，真实档位以链上 getCurrentSlippage() 为准（poolStats.slippage 直读链上）。
 */
const SLIPPAGE_DROP_BASE = 21000;
const reductionPct = computed(() => {
  const cur = parseFloat(poolStats.value.poolUSDT || "0") || 0;
  const snap = parseFloat(poolStats.value.snapshotPoolUSDT || "0") || 0;
  if (snap <= 0 || cur >= snap) return "0";
  const pct = ((snap - cur) / SLIPPAGE_DROP_BASE) * 100;
  return pct > 0 ? pct.toFixed(2) : "0";
});

onMounted(() => refresh());
</script>

<style scoped lang="scss">
.migrate-entry {
  margin-bottom: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: rgba(245, 193, 93, 0.12);
  border: 1px solid rgba(245, 193, 93, 0.35);
  color: var(--gold);
  font-size: 12px;
  text-align: center;
  cursor: pointer;
}
.hint {
  text-align: center;
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 6px;
}
</style>
