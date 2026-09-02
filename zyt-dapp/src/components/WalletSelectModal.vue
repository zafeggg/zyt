<template>
  <van-popup
    :show="show"
    position="bottom"
    round
    closeable
    @update:show="$emit('close')"
    class="wallet-modal"
  >
    <div class="wallet-modal-inner">
      <div class="title">{{ $t("wallet.selectWallet") }}</div>
      <div v-if="loading" class="empty">{{ $t("wallet.detecting") }}</div>
      <template v-else>
        <div v-if="wallets.length === 0" class="empty">{{ $t("wallet.notFound") }}</div>
        <div
          v-for="w in wallets"
          :key="w.rdns + w.name"
          class="wallet-item"
          @click="$emit('select', w)"
        >
          <img v-if="w.icon" :src="w.icon" class="wallet-icon" alt="" />
          <div v-else class="wallet-icon wallet-icon-text">{{ w.name.charAt(0).toUpperCase() }}</div>
          <div class="wallet-name">{{ w.name }}</div>
          <van-icon name="arrow" class="wallet-arrow" />
        </div>
        <div v-if="wallets.length > 0" class="hint">{{ $t("wallet.hint") }}</div>
      </template>
    </div>
  </van-popup>
</template>

<script setup lang="ts">
import type { WalletOption } from "../composables/useWallet";

defineProps<{
  show: boolean;
  loading: boolean;
  wallets: WalletOption[];
}>();
defineEmits<{
  (e: "select", w: WalletOption): void;
  (e: "close"): void;
}>();
</script>

<style scoped lang="scss">
.wallet-modal {
  background: var(--bg-page) !important;
  .wallet-modal-inner {
    padding: 20px 16px calc(24px + env(safe-area-inset-bottom));
    .title {
      text-align: center;
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 16px;
    }
    .empty {
      text-align: center;
      color: var(--text-tertiary);
      font-size: 13px;
      padding: 24px 0;
    }
    .wallet-item {
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 13px 14px;
      margin-bottom: 10px;
      cursor: pointer;
      &:active {
        opacity: 0.75;
      }
      .wallet-icon {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        object-fit: contain;
      }
      .wallet-icon-text {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--gold);
        color: #1a1206;
        font-weight: 700;
        font-size: 16px;
      }
      .wallet-name {
        flex: 1;
        font-size: 15px;
        color: var(--text-primary);
      }
      .wallet-arrow {
        color: var(--text-tertiary);
      }
    }
    .hint {
      text-align: center;
      color: var(--text-tertiary);
      font-size: 11px;
      margin-top: 4px;
    }
  }
}
</style>
