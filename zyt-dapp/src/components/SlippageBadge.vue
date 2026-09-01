<template>
  <div class="slippage-badge" :class="{ high: slippage >= 20 }">
    <span class="label">{{ $t("home.slippage") }}</span>
    <span class="value">{{ rateText }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ slippage: number }>();

const rateText = computed(() => `${props.slippage}%`);
</script>

<style scoped lang="scss">
.slippage-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(245, 193, 93, 0.1);
  border: 1px solid rgba(245, 193, 93, 0.35);
  border-radius: 20px;
  padding: 4px 12px;
  .label {
    font-size: 11px;
    color: var(--text-secondary);
  }
  .value {
    font-size: 13px;
    font-weight: 600;
    color: var(--gold);
  }
  &.high {
    background: rgba(226, 75, 74, 0.12);
    border-color: rgba(226, 75, 74, 0.4);
    .value {
      color: #f47a77;
    }
  }
}
</style>
