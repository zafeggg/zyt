<template>
  <!-- v14：邀请制入口——无邀请码（且无 skipInvite=1）时全屏 gate，不渲染主应用 -->
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
import { useInvite } from "./composables/useInvite";

// URL ?ref= 优先覆盖已存邀请码；无任何邀请 → gate
const { syncFromUrl, hasInvite } = useInvite();
syncFromUrl();
const gated = ref(!hasInvite());
</script>

<style scoped lang="scss">
.app-shell {
  min-height: 100vh;
  // 底部导航固定占位：tabbar 50px + iPhone 安全区（非 iOS 环境 env() 为 0，不影响布局）
  padding-bottom: calc(50px + env(safe-area-inset-bottom));
  background: var(--bg-page);
}
</style>
