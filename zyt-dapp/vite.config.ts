import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  base: "./", // GitHub Pages 子路径部署
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 1500,
  },
});
