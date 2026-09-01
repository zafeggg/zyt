import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN";
import zhTW from "./zh-TW";
import en from "./en";

const saved = localStorage.getItem("zyt-lang") || "zh-CN";

export const i18n = createI18n({
  legacy: false,
  locale: saved,
  fallbackLocale: "zh-CN",
  messages: {
    "zh-CN": zhCN,
    "zh-TW": zhTW,
    en,
  },
});

export function setLocale(locale: string) {
  i18n.global.locale.value = locale as any;
  localStorage.setItem("zyt-lang", locale);
}
