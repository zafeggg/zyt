<template>
  <!-- v14：邀请制入口 gate（全屏不可关闭，无邀请码无法进入主页面） -->
  <div class="invite-gate">
    <div class="gate-card">
      <div class="gate-logo">Z</div>
      <div class="gate-title">{{ $t("invite.title") }}</div>
      <div class="gate-sub">{{ $t("invite.subtitle") }}</div>
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
      <div class="gate-tip">{{ $t("invite.tip") }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { parseInvite, useInvite } from "../composables/useInvite";

const emit = defineEmits<{ (e: "pass"): void }>();
const { t } = useI18n();
const { setInvite } = useInvite();

const input = ref("");
const errMsg = ref("");
const checking = ref(false);

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
.gate-tip {
  font-size: 10px;
  color: var(--text-tertiary);
  margin-top: 12px;
  line-height: 1.6;
}
</style>
