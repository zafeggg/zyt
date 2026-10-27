// 分红池补足（迁移第 7 步）：按 snapshot 实测的 totalPendingDividend 补 seedDividend
//
// 为什么不能写死金额：未领分红按日累积（实测约 1.1 万 ZYT/天），
// 迁移当天必须以 snapshot 的实数为准，否则会出现「补多浪费 / 补少领不到」。
//
// 用法：
//   RPC_URL=... NEW_POOL=0x.. node scripts/seed-dividend.mjs                 # 只算不执行（默认 dry-run）
//   RPC_URL=... NEW_POOL=0x.. PRIVATE_KEY=.. node scripts/seed-dividend.mjs --execute
//
// 可选环境变量：
//   SNAPSHOT_FILE   指定快照 JSON（默认取 output/migration/users-<chainId>.json 最新一份）
//   AMOUNT          手工指定补足数量（wei，覆盖快照计算；仅应急）
//   BUFFER_BPS      在缺口上额外留的缓冲基点（默认 0；建议 0，因按实数补即可）
import "dotenv/config";
import { JsonRpcProvider, Wallet, Contract, formatEther } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const RPC = env.RPC_URL || "http://127.0.0.1:8545";
const CHAIN_ID = Number(env.CHAIN_ID || 56);
const NEW_POOL = env.NEW_POOL || "";
const EXECUTE = process.argv.includes("--execute");
const BUFFER_BPS = BigInt(env.BUFFER_BPS || 0);

const die = (m) => {
  console.error("✗", m);
  process.exit(1);
};
const f = (v) => Number(formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 4 });
if (!NEW_POOL) die("缺少 NEW_POOL（新 ZYTPoolManager 地址）");

/** 取快照文件：优先 SNAPSHOT_FILE，否则 output/migration/users-<chainId>.json */
function loadSnapshot() {
  if (env.SNAPSHOT_FILE) {
    const p = path.isAbsolute(env.SNAPSHOT_FILE) ? env.SNAPSHOT_FILE : path.join(ROOT, env.SNAPSHOT_FILE);
    if (!fs.existsSync(p)) die(`找不到快照：${p}`);
    return { file: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
  }
  const p = path.join(ROOT, "output", "migration", `users-${CHAIN_ID}.json`);
  if (!fs.existsSync(p)) die(`找不到快照：${p}（先跑 migrate.mjs snapshot，或用 SNAPSHOT_FILE 指定）`);
  return { file: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
}

async function main() {
  const { file, data } = loadSnapshot();
  // 优先用 meta 汇总；没有则按记录逐户求和（双源交叉校验）
  const fromMeta = data.meta?.totalPendingDividend ? BigInt(data.meta.totalPendingDividend) : null;
  const fromUsers = (data.users || []).reduce((s, u) => s + BigInt(u.pendingDividend || "0"), 0n);
  const need = env.AMOUNT ? BigInt(env.AMOUNT) : fromMeta ?? fromUsers;

  console.log(`快照：${file}`);
  console.log(`  用户数：${(data.users || []).length}  ｜ createdAt：${data.meta?.createdAt || "-"}`);
  console.log(`  meta.totalPendingDividend：${fromMeta === null ? "（缺）" : f(fromMeta) + " ZYT"}`);
  console.log(`  逐户求和              ：${f(fromUsers)} ZYT`);
  if (fromMeta !== null && fromMeta !== fromUsers) {
    console.log(`  ⚠ 两个口径不一致，差 ${f(fromMeta - fromUsers)} ZYT（以 meta 为准）`);
  }
  console.log(`  本次补足基数：${f(need)} ZYT${env.AMOUNT ? "（AMOUNT 覆盖）" : ""}`);

  const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const pool = new Contract(
    NEW_POOL,
    ["function dividendPoolZyt() view returns (uint256)", "function zytToken() view returns (address)", "function seedDividend(uint256)"],
    provider
  );
  const zytAddr = await pool.zytToken();
  const zyt = new Contract(
    zytAddr,
    ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
    provider
  );

  const current = await pool.dividendPoolZyt();
  let gap = need > current ? need - current : 0n;
  if (gap > 0n && BUFFER_BPS > 0n) gap = gap + (gap * BUFFER_BPS) / 10000n;

  console.log(`\n新池当前 dividendPoolZyt：${f(current)} ZYT`);
  console.log(`未领合计需要          ：${f(need)} ZYT`);
  console.log(`缺口                  ：${f(gap)} ZYT`);

  if (gap === 0n) {
    console.log("\n✓ 新池余额已足够兑付全部未领分红，无需 seedDividend");
    return;
  }

  const ownerAddr = env.PRIVATE_KEY ? new Wallet(env.PRIVATE_KEY).address : env.DRYRUN_FROM || "";
  if (ownerAddr) {
    const [bal, allow] = await Promise.all([zyt.balanceOf(ownerAddr), zyt.allowance(ownerAddr, NEW_POOL)]);
    console.log(`\n操作账户：${ownerAddr}`);
    console.log(`  ZYT 余额      ：${f(bal)}`);
    console.log(`  已授权给新池  ：${f(allow)}`);
    if (bal < gap) console.log(`  ⚠ 余额不足，还差 ${f(gap - bal)} ZYT（补齐后才能执行）`);
    if (allow < gap) console.log(`  ℹ 需要先 approve(${NEW_POOL}, ≥ ${f(gap)})，脚本在 --execute 时会自动处理`);
  } else {
    console.log(`\nℹ 未提供 PRIVATE_KEY / DRYRUN_FROM，跳过余额与授权检查（执行时再校验）`);
  }

  if (!EXECUTE) {
    console.log(`\n[dry-run] 未发送交易。确认以上数字后加 --execute 执行。`);
    return;
  }

  if (!env.PRIVATE_KEY) die("--execute 需要 PRIVATE_KEY");
  const signer = new Wallet(env.PRIVATE_KEY, provider);
  const zytW = zyt.connect(signer);
  const poolW = pool.connect(signer);

  const allow = await zyt.allowance(signer.address, NEW_POOL);
  if (allow < gap) {
    console.log(`\n→ approve(${NEW_POOL}, ${gap})`);
    await (await zytW.approve(NEW_POOL, gap)).wait();
  }
  console.log(`→ seedDividend(${gap})`);
  await (await poolW.seedDividend(gap)).wait();

  const after = await poolW.dividendPoolZyt();
  if (after < need) die(`补足后仍不足：${f(after)} < ${f(need)}`);
  console.log(`\n✓ 补足完成：dividendPoolZyt = ${f(after)} ZYT（覆盖未领 ${f(need)}）`);
}

main().catch((e) => die(e.shortMessage || e.stack || e.message));
