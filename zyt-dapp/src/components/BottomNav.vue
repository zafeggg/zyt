<!--
  BottomNav.vue — 移动端风格底部导航栏
  - 4 个 tab：首页 / 兑换 / 记录 / 社区（i18n 三语：zh-CN / zh-TW / en）
  - 深色毛玻璃 + 金色激活态（贴合全局 --bg-panel 深色主题）
  - iPhone 安全区适配（safe-area-inset-bottom）
  - 激活项：图标上浮微放大 + 顶部金色指示条
-->
<template>
  <van-tabbar
    route
    class="bottom-nav"
    active-color="#f5c15d"
    inactive-color="#8a92a8"
    safe-area-inset-bottom
    :border="false"
  >
    <van-tabbar-item replace to="/" :icon="homeIcon" :text="$t('tab.home')" />
    <van-tabbar-item replace to="/swap" :icon="swapIcon" :text="$t('tab.swap')" />
    <van-tabbar-item replace to="/records" :icon="recordsIcon" :text="$t('tab.records')" />
    <van-tabbar-item replace to="/community" :icon="communityIcon" :text="$t('tab.community')" />
  </van-tabbar>
</template>

<script setup lang="ts">
// NBDAO 风格底部导航：首页 / 兑换 / 记录 / 社区
const homeIcon = "wap-home-o";
const swapIcon = "exchange";
const recordsIcon = "bars";
const communityIcon = "friends-o";
</script>

<style scoped lang="scss">
.bottom-nav {
  // 深色毛玻璃：半透明面板色 + 背景模糊，沉浸式移动端质感
  background: rgba(20, 24, 35, 0.88);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  border-top: 1px solid var(--border);
  // 悬浮阴影：与页面内容形成层次
  box-shadow: 0 -6px 20px rgba(0, 0, 0, 0.35);

  // 文字标签
  :deep(.van-tabbar-item) {
    font-size: 11px;

    .van-tabbar-item__icon {
      font-size: 22px;
      line-height: 1;
      transition: transform 0.18s ease;
    }
  }

  // 激活态：图标上浮 + 微放大 + 顶部金色指示条
  :deep(.van-tabbar-item--active) {
    .van-tabbar-item__icon {
      transform: translateY(-2px) scale(1.1);
    }

    &::before {
      content: "";
      position: absolute;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      width: 20px;
      height: 3px;
      border-radius: 0 0 3px 3px;
      background: #f5c15d;
    }
  }
}
</style>
