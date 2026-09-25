<template>
  <!-- v15：注册门禁——连接钱包 → 链上注册判定 → 未注册填邀请码注册 / 已注册直接进入 -->
  <div class="invite-gate">
    <div class="gate-card">
      <div class="gate-logo">Z</div>

      <!-- 态1：未连接钱包 -->
      <template v-if="state === 'connect'">
        <div class="gate-title">{{ $t("invite.title") }}</div>
        <div class="gate-sub">{{ $t("invite.subtitle") }}</div>
        <div v-if="errMsg" class="gate-err">{{ errMsg }}</div>
        <van-button
          block
          type="primary"
          class="gate-btn"
          :loading="connecting"
          @click="handleConnect"
        >
          {{ $t("common.connect") }}
        </van-button>
        <div class="gate-tip">{{ $t("invite.tip") }}</div>
      </template>

      <!-- 态2：链上注册校验中 -->
      <template v-else-if="state === 'checking'">
        <div class="gate-title">{{ $t("invite.checkingHint") }}</div>
        <div v-if="shortAddress" class="gate-addr">{{ shortAddress }}</div>
        <van-loading size="28" class="gate-loading" vertical />
      </template>

      <!-- 态3：未注册 → 邀请码表单 -->
      <template v-else>
        <div class="gate-title">{{ $t("invite.title") }}</div>
        <div class="gate-sub">{{ $t("invite.subtitle") }}</div>
        <div v-if="shortAddress" class="gate-addr">{{ shortAddress }}</div>
        <input
          v-model="input"
          class="gate-input"
          :placeholder="$t('invite.placeholder')"
          :disabled="checking"
          @keyup.enter="confirm"
        />
        <div v-if="errMsg" class="gate-err">{{ errMsg }}</div>
        <van-button
          block
          type="primary"
          class="gate-btn"
          :loading="checking"
          :disabled="!input.trim()"
          @click="confirm"
        >
          {{ $t("invite.confirm") }}
        </van-button>
        <div class="gate-link" @click="goCheck">{{ $t("invite.retry") }}</div>
        <div class="gate-tip">{{ $t("invite.riskTip") }}</div>
      </template>

      <!-- 多钱包选择弹窗（v12 复用：MetaMask / TokenPocket 并存时由用户点选） -->
      <WalletSelectModal
        :show="showSelect"
        :loading="connecting"
        :wallets="wallets"
        @select="onSelectWallet"
        @close="showSelect = false"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { parseInvite, useInvite, fetchOnchainReferrer, markRegistered, isRegistered } from "../composables/useInvite";
import { useWallet, type WalletOption } from "../composables/useWallet";
import WalletSelectModal from "./WalletSelectModal.vue";

const emit = defineEmits<{ (e: "pass"): void }>();
const { t } = useI18n();
const { getSaved, syncFromUrl, setInvite } = useInvite();
const { address, shortAddress, connect, connectWith, listWallets, restoreSession, listenAccountChange } =
  useWallet();

type GateState = "connect" | "checking" | "form";
const state = ref<GateState>("connect");
const input = ref("");
const errMsg = ref("");
const checking = ref(false); // 表单确认按钮 loading
const connecting = ref(false); // 钱包连接 loading
const urlRefHit = ref(false); // 本次打开是否命中 URL ?ref= 邀请链接（仅此场景自动填充输入框）
let checkedAddr = ""; // 已发起链上判定的地址（同一地址防重复查询）

// 多钱包选择状态（v12）
const showSelect = ref(false);
const wallets = ref<WalletOption[]>([]);

onMounted(async () => {
  // URL ?ref= 优先入库（覆盖旧值，跟随最新分享链接）；命中则注册页自动填充
  urlRefHit.value = syncFromUrl();
  listenAccountChange();
  // 静默恢复已授权会话（TP/MetaMask 内置浏览器二次打开不弹窗）
  await restoreSession();
  if (address.value) goCheck();
});

// 账户切换 / 断开：重新判定（gate 内自管，主应用挂载后由 WalletHeader 接管事件）
watch(address, (v) => {
  if (!v) {
    checkedAddr = "";
    state.value = "connect";
    errMsg.value = "";
    return;
  }
  if (v.toLowerCase() !== checkedAddr) goCheck();
});

/** 连接钱包：多钱包弹选择框，单/零钱包走自动连接 */
async function handleConnect() {
  errMsg.value = "";
  connecting.value = true;
  try {
    const opts = await listWallets();
    if (opts.length > 1) {
      wallets.value = opts;
      showSelect.value = true;
      connecting.value = false;
      return;
    }
    await connect();
    connecting.value = false;
    // 成功后 watch(address) 触发 goCheck
  } catch (e: any) {
    connecting.value = false;
    errMsg.value =
      e?.message === "USER_REJECTED" ? t("common.rejected")
      : e?.message === "WRONG_CHAIN" ? t("common.wrongChain")
      : t("common.noWallet");
  }
}

/** 用户在选择弹窗中点选钱包 */
async function onSelectWallet(w: WalletOption) {
  showSelect.value = false;
  try {
    await connectWith(w);
    // 成功后 watch(address) 触发 goCheck
  } catch (e: any) {
    errMsg.value = e?.message === "WRONG_CHAIN" ? t("common.wrongChain") : t("common.rejected");
  }
}

/**
 * 链上注册判定：
 * 1) referrerOf(钱包) ≠ 0 → 已注册，回填邀请码（保证入金 ref 不断链）并直接放行
 * 2) 未注册 → 表单态，预填 URL 邀请码或根邀请码（营销地址）
 * 3) RPC 失败 → 本机有注册记录则降级放行，否则进表单可手输/重试
 */
async function goCheck() {
  if (!address.value) {
    state.value = "connect";
    return;
  }
  const target = address.value.toLowerCase();
  checkedAddr = target;
  state.value = "checking";
  errMsg.value = "";
  try {
    const onchain = await fetchOnchainReferrer(target);
    // 查询期间用户切了账户：丢弃本次结果，watch 已对新地址重查
    if (address.value.toLowerCase() !== target) return;
    if (onchain) {
      setInvite(onchain);
      emit("pass");
      return;
    }
    // 链上未绑定：本机已点击过注册 → 直接放行（刷新/重开免重复注册）
    if (isRegistered()) {
      emit("pass");
      return;
    }
    // 首次注册 → 表单：仅 URL 邀请链接命中时自动填充，其余情况留空由用户自己输入
    state.value = "form";
    if (urlRefHit.value && !input.value) input.value = getSaved();
  } catch {
    if (address.value.toLowerCase() !== target) return;
    if (isRegistered()) {
      // 降级：本机注册记录视为有效，避免老用户因 RPC 抖动被拦
      emit("pass");
      return;
    }
    state.value = "form";
    if (urlRefHit.value && !input.value) input.value = getSaved();
    errMsg.value = t("invite.checkFail");
  }
}

/** 点击注册：校验并保存邀请码（链上绑定在首次入金时随 deposit 提交） */
function confirm() {
  errMsg.value = "";
  const code = parseInvite(input.value);
  if (!code) {
    errMsg.value = t("invite.invalid");
    return;
  }
  checking.value = true;
  // 轻微延迟保持 loading 反馈（本地无网络请求）
  setTimeout(() => {
    setInvite(code);
    markRegistered(); // v15：落本机注册标记，刷新/重开免重复注册
    checking.value = false;
    emit("pass");
  }, 200);
}
</script>

<style scoped lang="scss">
.invite-gate {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-page);
  padding: 24px;
}
.gate-card {
  width: 100%;
  max-width: 360px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 28px 22px;
  text-align: center;
}
.gate-logo {
  width: 52px;
  height: 52px;
  margin: 0 auto 14px;
  border-radius: 14px;
  background: var(--gold);
  color: #141823;
  font-size: 26px;
  font-weight: 800;
  line-height: 52px;
}
.gate-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}
.gate-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 8px 0 18px;
  line-height: 1.6;
}
.gate-addr {
  font-size: 11px;
  color: var(--text-tertiary);
  margin: -10px 0 12px;
}
.gate-loading {
  margin: 18px auto 6px;
}
.gate-input {
  width: 100%;
  background: var(--bg-page);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 12px;
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  &::placeholder {
    color: var(--text-tertiary);
  }
  &:focus {
    border-color: var(--gold);
  }
}
.gate-err {
  text-align: left;
  font-size: 11px;
  color: #e05b5b;
  margin-top: 6px;
}
.gate-btn {
  margin-top: 14px;
  border-radius: 10px;
  height: 44px;
}
.gate-link {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 12px;
  cursor: pointer;
  &:active {
    opacity: 0.7;
  }
}
.gate-tip {
  font-size: 10px;
  color: var(--text-tertiary);
  margin-top: 12px;
  line-height: 1.6;
}
</style>
