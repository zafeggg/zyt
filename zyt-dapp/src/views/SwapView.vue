<template>
  <div class="swap-page">
    <WalletHeader />
    <!-- v9.2 迁移期入口：仅在已接线 ZYTSwap 地址时展示（避免未迁移时误导） -->
    <div v-if="swapWired" class="migrate-entry" @click="$router.push('/migrate')">
      {{ $t("swap.migrateEntry") }}
    </div>
    <SwapPanel :slippage="poolStats.slippage" :reduction-pct="reductionPct" :refresh="refresh" />
    <div class="hint">{{ $t("swap.depositRange", { min: "100", max: "500" }) }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import WalletHeader from "../components/WalletHeader.vue";
import SwapPanel from "../components/SwapPanel.vue";
import { usePoolData } from "../composables/usePoolData";
import { currentChain } from "../config";

const { poolStats, refresh } = usePoolData();

/** v9.2 迁移兑换入口：仅当已接线 ZYTSwap 地址时展示 */
const swapWired = computed(() => !!currentChain().contracts.swap);

/**
 * v9.2：与合约 getCurrentSlippage 同口径的「池 USDT 较基准回落比例」。
 * 基准 = 当日 08:01 快照池 U（合约 snapshotPoolUSDT）；当前池 U 回落达 1/2/3/4% → 滑点 10/20/40/80%。
 * 峰值 peakPoolUSDT 自 v9.2 起降级为纯统计，不再参与档位判定。
 */
const reductionPct = computed(() => {
  const cur = parseFloat(poolStats.value.poolUSDT || "0") || 0;
  const base = parseFloat(poolStats.value.snapshotPoolUSDT || "0") || 0;
  if (base <= 0 || cur >= base) return "0";
  const pct = ((base - cur) / base) * 100;
  return pct > 0 ? pct.toFixed(1) : "0";
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
