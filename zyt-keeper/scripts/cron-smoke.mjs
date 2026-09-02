// node-cron 冒烟：每分钟任务 70 秒观察（验证调度器在本机正常触发）
import cron from "node-cron";
let fired = 0;
cron.schedule("* * * * *", () => { fired++; console.log(`cron fired #${fired} at ${new Date().toISOString()}`); }, { timezone: "UTC" });
setTimeout(() => { console.log(`result: fired=${fired} in 70s -> ${fired > 0 ? "PASS" : "FAIL"}`); process.exit(fired > 0 ? 0 : 1); }, 70000);
