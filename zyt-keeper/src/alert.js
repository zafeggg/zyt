import { CONFIG } from "./config.js";
import { getDb } from "./db.js";

/** 记录运行日志（入库 + 控制台；入库为 fire-and-forget，不阻塞调用方） */
export function logRun(type, status, detail = "") {
  getDb()
    .then((db) =>
      db.run("INSERT INTO keeper_runs (type, status, detail, created_at) VALUES (?,?,?,?)", [
        type,
        status,
        typeof detail === "string" ? detail : JSON.stringify(detail),
        Math.floor(Date.now() / 1000),
      ])
    )
    .catch(() => {
      /* 日志写入失败不阻断主流程 */
    });
  const tag = status === "ok" ? "✔" : "✘";
  console.log(`[${new Date().toISOString()}] ${tag} ${type}: ${status} ${detail}`);
}

/** 告警通知（可选 webhook；无配置则仅日志） */
export async function notify(message) {
  const url = CONFIG.alert.webhookUrl;
  console.warn(`[ALERT] ${message}`);
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    if (!res.ok) console.warn("[ALERT] webhook failed:", res.status);
  } catch (e) {
    console.warn("[ALERT] webhook error:", e.message);
  }
}
