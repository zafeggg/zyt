<template>
  <div class="wallet-header">
    <div class="left">
      <div class="logo">{{ $t("home.title") }}</div>
      <div class="sub">GST · ZYT</div>
    </div>
    <div class="right">
      <van-dropdown-menu class="lang-menu" active-color="#f5c15d">
        <van-dropdown-item :title="langLabel">
          <van-cell v-for="l in langs" :key="l.value" :title="l.label" @click="changeLang(l.value)" />
        </van-dropdown-item>
      </van-dropdown-menu>
      <van-button
        v-if="!address"
        size="small"
        type="primary"
        class="connect-btn"
        @click="handleConnect"
      >
        {{ $t("common.connect") }}
      </van-button>
      <div v-else class="addr-chip" @click="copyAddr">
        <span class="dot" />
        {{ shortAddress }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { showToast } from "vant";
import { useI18n } from "vue-i18n";
import { useWallet } from "../composables/useWallet";
import { setLocale } from "../i18n";

const { t } = useI18n();
const { address, shortAddress, connect, restoreSession, listenAccountChange } = useWallet();

const langs = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
];

const langLabel = computed(() => {
  const cur = useI18n().locale.value;
  return langs.find((l) => l.value === cur)?.label || "简体中文";
});

function changeLang(v: string) {
  setLocale(v);
}

async function handleConnect() {
  try {
    await connect();
    showToast({ type: "success", message: t("common.connected") });
  } catch (e: any) {
    const msg =
      e?.message === "NO_WALLET" ? t("common.noWallet") : e?.message === "USER_REJECTED" ? t("common.rejected") : t("common.noWallet");
    showToast({ type: "fail", message: msg });
  }
}

async function copyAddr() {
  try {
    await navigator.clipboard.writeText(address.value);
    showToast({ type: "success", message: t("common.copied") });
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  listenAccountChange();
  // 静默恢复已授权会话（TP/MetaMask 内置浏览器再打开时自动连接）
  restoreSession().then(() => listenAccountChange());
});
</script>

<style scoped lang="scss">
.wallet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 6px;
}
.left {
  .logo {
    font-size: 18px;
    font-weight: 600;
    color: var(--gold);
    letter-spacing: 1px;
  }
  .sub {
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: 2px;
  }
}
.right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.connect-btn {
  border-radius: 20px;
  padding: 0 14px;
}
.addr-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #2ecc71;
  }
}
.lang-menu {
  :deep(.van-dropdown-menu__bar) {
    background: transparent;
    box-shadow: none;
  }
  :deep(.van-dropdown-menu__title) {
    color: var(--text-secondary);
    font-size: 12px;
  }
}
</style>
