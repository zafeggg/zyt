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
        :loading="connecting"
        @click="handleConnect"
      >
        {{ $t("common.connect") }}
      </van-button>
      <div v-else class="addr-chip" @click="copyAddr">
        <span class="dot" />
        {{ shortAddress }}
      </div>
    </div>
    <!-- 多钱包选择弹窗（v12：MetaMask / TokenPocket 并存时由用户点选） -->
    <WalletSelectModal
      :show="showSelect"
      :loading="connecting"
      :wallets="wallets"
      @select="onSelectWallet"
      @close="closeSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { showToast } from "vant";
import { useI18n } from "vue-i18n";
import { useWallet, type WalletOption } from "../composables/useWallet";
import WalletSelectModal from "./WalletSelectModal.vue";
import { copyText } from "../composables/useClipboard";
import { setLocale } from "../i18n";

const { t } = useI18n();
const { address, shortAddress, connect, connectWith, listWallets, restoreSession, listenAccountChange } =
  useWallet();

// v12：多钱包选择状态
const showSelect = ref(false);
const connecting = ref(false);
const wallets = ref<WalletOption[]>([]);

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
    // v12：先列举可选钱包——多个则弹选择框（MetaMask/TokenPocket 并存时让用户点选），
    // 单个或零个走原自动逻辑（连接报错由下方统一提示）
    connecting.value = true;
    const opts = await listWallets();
    connecting.value = false;
    if (opts.length > 1) {
      wallets.value = opts;
      showSelect.value = true;
      return;
    }
    await connect();
    showToast({ type: "success", message: t("common.connected") });
  } catch (e: any) {
    connecting.value = false;
    const msg =
      e?.message === "NO_WALLET" ? t("common.noWallet")
      : e?.message === "USER_REJECTED" ? t("common.rejected")
      : e?.message === "WRONG_CHAIN" ? t("common.wrongChain")
      : t("common.noWallet");
    showToast({ type: "fail", message: msg });
  }
}

/** 用户在弹窗中点选钱包 */
async function onSelectWallet(w: WalletOption) {
  showSelect.value = false;
  connecting.value = true;
  try {
    await connectWith(w);
    showToast({ type: "success", message: t("common.connected") });
  } catch (e: any) {
    const msg =
      e?.message === "USER_REJECTED" ? t("common.rejected")
      : e?.message === "WRONG_CHAIN" ? t("common.wrongChain")
      : t("common.noWallet");
    showToast({ type: "fail", message: msg });
  } finally {
    connecting.value = false;
  }
}

function closeSelect() {
  showSelect.value = false;
}

async function copyAddr() {
  // v14：HTTP 环境（testnet IP 直访）navigator.clipboard 不存在 → useClipboard 兼容回退
  const ok = await copyText(address.value);
  if (ok) showToast({ type: "success", message: t("common.copied") });
  else showToast({ type: "fail", message: t("common.copyFail") });
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
