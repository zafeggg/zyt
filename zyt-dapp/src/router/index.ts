import { createRouter, createWebHashHistory } from "vue-router";

const routes = [
  { path: "/", name: "home", component: () => import("../views/HomeView.vue") },
  { path: "/swap", name: "swap", component: () => import("../views/SwapView.vue") },
  { path: "/records", name: "records", component: () => import("../views/RecordsView.vue") },
  { path: "/community", name: "community", component: () => import("../views/CommunityView.vue") },
];

// hash 路由：与 NBDAO 一致（GitHub Pages 友好），支持 ?ref=0x... 推荐链接
const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
