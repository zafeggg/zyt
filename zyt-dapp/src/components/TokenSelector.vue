<template>
  <van-popup
    :show="show"
    @update:show="(v: boolean) => emit('update:show', v)"
    position="bottom"
    round
    class="token-selector"
  >
    <div class="ts-title">{{ $t("swap.selectToken") }}</div>
    <van-cell-group inset>
      <van-cell
        v-for="tk in tokens"
        :key="tk.symbol"
        clickable
        :title="tk.name"
        :label="tk.symbol"
        :value="tk.disabled ? $t('swap.bnbDisabled') : ''"
        @click="choose(tk)"
      >
        <template #icon>
          <div class="tk-icon" :class="tk.color">{{ tk.symbol[0] }}</div>
        </template>
        <template #right-icon>
          <van-icon v-if="tk.symbol === selected" name="success" color="#f5c15d" />
        </template>
      </van-cell>
    </van-cell-group>
  </van-popup>
</template>

<script setup lang="ts">
export interface TokenOption {
  symbol: string;
  name: string;
  color: string;
  disabled?: boolean;
}

const props = defineProps<{
  show: boolean;
  selected: string;
}>();
const emit = defineEmits<{
  (e: "update:show", v: boolean): void;
  (e: "select", token: TokenOption): void;
}>();

const tokens: TokenOption[] = [
  { symbol: "ZYT", name: "众赢币", color: "#f5c15d" },
  { symbol: "USDT", name: "USDT", color: "#26a17b" },
  { symbol: "GST", name: "古水币", color: "#378add", disabled: true },
  { symbol: "BNB", name: "BNB", color: "#f0b90b", disabled: true },
];

function choose(tk: TokenOption) {
  if (tk.disabled) return;
  emit("select", tk);
  emit("update:show", false);
}
</script>

<style scoped lang="scss">
.token-selector {
  padding: 12px 0 20px;
  .ts-title {
    text-align: center;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    padding: 6px 0 12px;
  }
  .tk-icon {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    margin-right: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    color: #141823;
  }
}
</style>
