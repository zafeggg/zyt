<template>
  <div class="community">
    <WalletHeader />
    <div class="panel">
      <div class="panel-title">{{ $t("community.referralLink") }}</div>
      <div class="ref-box">
        <div class="ref-url">{{ refLink }}</div>
        <van-button size="small" type="primary" round @click="copyRef">{{ $t("common.copy") }}</van-button>
      </div>
      <van-button block type="primary" class="share-btn" @click="share">{{ $t("community.share") }}</van-button>
    </div>
    <div class="panel">
      <div class="panel-title">{{ $t("community.title") }}</div>
      <van-cell-group inset>
        <van-cell :title="$t('community.telegram')" icon="chat-o" is-link @click="open('https://t.me/')" />
        <van-cell :title="$t('community.twitter')" icon="star-o" is-link @click="open('https://twitter.com/')" />
        <van-cell :title="$t('community.docs')" icon="description-o" is-link @click="open(docsUrl)" />
      </van-cell-group>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { showToast } from "vant";
import WalletHeader from "../components/WalletHeader.vue";
import { useWallet } from "../composables/useWallet";

const { address } = useWallet();
const docsUrl = "https://example.com/whitepaper";

const refLink = computed(() => {
  const base = `${location.origin}${location.pathname}#/`;
  const ref = address.value || "";
  return ref ? `${base}?ref=${ref}` : base;
});

async function copyRef() {
  try {
    await navigator.clipboard.writeText(refLink.value);
    showToast({ type: "success", message: "copied" });
  } catch {
    /* ignore */
  }
}

function share() {
  const url = encodeURIComponent(refLink.value);
  const text = encodeURIComponent("Join me on ZYT!");
  window.open(`https://t.me/share/url?url=${url}&text=${text}`, "_blank");
}

function open(u: string) {
  window.open(u, "_blank");
}
</script>

<style scoped lang="scss">
.ref-box {
  display: flex;
  gap: 10px;
  align-items: center;
  .ref-url {
    flex: 1;
    background: var(--bg-card);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    font-size: 12px;
    color: var(--text-secondary);
    word-break: break-all;
  }
}
.share-btn {
  margin-top: 12px;
  border-radius: 10px;
}
</style>
