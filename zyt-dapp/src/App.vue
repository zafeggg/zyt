<template>
  <!-- v15：注册门禁——gate 内完成钱包连接与链上注册判定（已注册直进，未注册填邀请码注册） -->
  <InviteGate v-if="gated" @pass="gated = false" />
  <div v-else class="app-shell">
    <router-view v-slot="{ Component }">
      <keep-alive>
        <component :is="Component" />
      </keep-alive>
    </router-view>
    <!-- 移动端风格底部导航：首页 / 兑换 / 记录 / 社区（独立组件，便于复用与维护） -->
    <BottomNav />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import BottomNav from "./components/BottomNav.vue";
import InviteGate from "./components/InviteGate.vue";

// v15：注册门禁常开（判定逻辑在 InviteGate 内：链上 referrerOf 强校验 + localStorage 降级）。
// 测试逃生：URL 带 skipInvite=1 跳过 gate（不对外宣传）。改 false 即整体关闭门禁。
const INVITE_GATE_ENABLED = true;
const escape =
  location.search.includes("skipInvite=1") || location.hash.includes("skipInvite=1");

const gated = ref(INVITE_GATE_ENABLED && !escape);
</script>

<style scoped lang="scss">
.app-shell {
  min-height: 100vh;
  // 底部导航固定占位：tabbar 50px + iPhone 安全区（非 iOS 环境 env() 为 0，不影响布局）
  padding-bottom: calc(50px + env(safe-area-inset-bottom));
  background: var(--bg-page);
}
</style>
