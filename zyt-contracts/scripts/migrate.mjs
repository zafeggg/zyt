/**
 * ZYT v9.2 一次性迁移脚本（路线 A，2026-10-13 拍板）
 *
 * 四个子命令（默认只读；写链一律要求 --execute）：
 *   snapshot   只读：枚举旧合约全量用户（含纯入金用户）并落盘全量状态快照
 *   push       写入新合约：setUserData 每批 BATCH_SIZE（默认 50）人；可断点续跑（幂等跳过）
 *   verify     逐户比对新旧状态（含 launchDay），输出差异报告；有差异则退出码 1
 *   launchday  继承 launchDay（红线第 4 条：不继承则老用户算力复利因子归 1 缩水）
 *
 * 为什么不能只靠链上 userList 枚举：
 *   ZYTToken.userList 只在「收币 / 卖出 / 转出」时登记，纯入金（从未持币）用户不在其中。
 *   因此本脚本以旧 Mining 的 Deposited 事件为枚举主源，userList 为补充源，两者取并集。
 *
 * 用法示例：
 *   RPC_URL=... OLD_MINING=0x.. OLD_TOKEN=0x.. NEW_MINING=0x.. NEW_TOKEN=0x.. OLD_CONFIG=0x.. \
 *     node scripts/migrate.js snapshot
 *   ... node scripts/migrate.js push --execute        # MIGRATOR_PRIVATE_KEY 必填
 *   ... node scripts/migrate.js verify
 *   ... node scripts/migrate.js launchday --execute
 *
 * 环境变量：
 *   RPC_URL / CHAIN_ID                链
 *   OLD_MINING / OLD_TOKEN            旧合约（Mining 读状态，Token 读 userList 补充枚举）
 *   NEW_MINING / NEW_TOKEN            新合约
 *   OLD_CONFIG / NEW_CONFIG           可选：Config（校验旧已 pause、新 owner = 签名者）
 *   FROM_BLOCK                        可选：Deposited 事件扫描起点（默认 0；主网务必显式给）
 *   TO_BLOCK                          可选：扫描终点（默认最新块）
 *   LOG_CHUNK                         可选：getLogs 分块大小（默认 5000）
 *   USERS_FILE                        可选：快照文件路径（默认 output/migration/users-<chainId>.json）
 *   BATCH_SIZE                        可选：setUserData 单批人数（默认 50）
 *   TX_GAP_MS                         可选：批间隔毫秒（默认 2000，防 nonce 冲突/RPC 限流）
 *   MIGRATOR_PRIVATE_KEY              写链签名私钥（须为新 Config.owner()）
 *   EXTRA_USERS                       可选：额外用户清单文件（每行一个地址）
 *
 * 停机窗口执行顺序（清单第六章）：T0 旧合约 pause → snapshot → launchday → push → verify → 开闸
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet, Contract, getAddress } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID || 56);
const OLD_MINING = process.env.OLD_MINING || "";
const OLD_TOKEN = process.env.OLD_TOKEN || "";
const NEW_MINING = process.env.NEW_MINING || "";
const NEW_TOKEN = process.env.NEW_TOKEN || "";
const OLD_CONFIG = process.env.OLD_CONFIG || "";
const NEW_CONFIG = process.env.NEW_CONFIG || "";
const FROM_BLOCK = Number(process.env.FROM_BLOCK || 0);
const TO_BLOCK = process.env.TO_BLOCK ? Number(process.env.TO_BLOCK) : null;
const LOG_CHUNK = Number(process.env.LOG_CHUNK || 5000);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50);
const TX_GAP_MS = Number(process.env.TX_GAP_MS || 2000);
const USERS_FILE =
  process.env.USERS_FILE || path.join(ROOT, "output", "migration", `users-${CHAIN_ID}.json`);
const OUT_DIR = path.join(ROOT, "output", "migration");

/** 旧/新 UserState 字段声明顺序（两端一致；本脚本按此顺序读写） */
const STATE_FIELDS = [
  "depositTotal",      // 0
  "withdrawTotal",     // 1
  "powerBase",         // 2
  "powerDay",          // 3
  "pendingDividend",   // 4
  "isExited",          // 5  (bool)
  "receivedValue",     // 6
  "exitDay",           // 7
  "buyQuota",          // 8
  "buyUsed",           // 9
  "dynamicQuota",      // 10
  "dynamicWithdrawn",  // 11
  "dynamicExited",     // 12 (bool)
];

const BOOL_FIELDS = ["isExited", "dynamicExited"];

const MINING_READ_ABI = [
  `function users(address) view returns (${STATE_FIELDS.map((f) =>
    BOOL_FIELDS.includes(f) ? "bool" : "uint256"
  ).join(", ")})`,
  "function dividendClaimedDay(address) view returns (uint256)",
  "function launchDay() view returns (uint64)",
  "function sellTierInputs(address) view returns (uint256, uint256)",
  "event Deposited(address indexed user, uint256 usdt, uint256 power, uint256 quota, address ref)",
];

/** setUserData 的元组顺序：13 个 uint256 在前，2 个 bool 在后（与合约结构体一致） */
const WRITE_TUPLE =
  "(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)";
const MINING_WRITE_ABI = [
  `function setUserData(address[] users, ${WRITE_TUPLE}[] data)`,
  "function setLaunchDay(uint256 day)",
];

const TOKEN_ABI = [
  "function getUserCount() view returns (uint256)",
  "function getUserAt(uint256) view returns (address)",
];
const CONFIG_ABI = [
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function referral() view returns (address)",
];
const REFERRAL_ABI = ["function referrerOf(address) view returns (address)"];
const ZERO = "0x0000000000000000000000000000000000000000";

// ---------------- 工具 ----------------

const log = (...a) => console.log(...a);
const die = (msg) => {
  console.error(`\n[中止] ${msg}`);
  process.exit(1);
};

function requireEnv(list) {
  const missing = list.filter((k) => !process.env[k]);
  if (missing.length) die(`缺少环境变量：${missing.join(", ")}`);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function toFile(addr) {
  try {
    return getAddress(addr);
  } catch {
    return addr;
  }
}

/** JSON 序列化（BigInt → 十进制字符串） */
function jsonReplacer(_k, v) {
  return typeof v === "bigint" ? v.toString() : v;
}

/** 单用户读取：UserState + dividendClaimedDay */
async function readUser(mining, addr) {
  const s = await mining.users(addr);
  const rec = { address: toFile(addr) };
  STATE_FIELDS.forEach((f, i) => {
    rec[f] = BOOL_FIELDS.includes(f) ? Boolean(s[i]) : s[i].toString();
  });
  rec.dividendClaimedDay = (await mining.dividendClaimedDay(addr)).toString();
  return rec;
}

/** 快照记录 → setUserData 元组（顺序：12 uint + 2 bool） */
function toWriteTuple(rec) {
  const uints = [
    "depositTotal",
    "withdrawTotal",
    "powerBase",
    "powerDay",
    "pendingDividend",
    "receivedValue",
    "exitDay",
    "buyQuota",
    "buyUsed",
    "dynamicQuota",
    "dynamicWithdrawn",
    "dividendClaimedDay",
    "directDeposit", // v9.2b：一级直推累计入金（「在玩」判据分子）
  ].map((f) => BigInt(rec[f] || "0"));
  return [...uints, Boolean(rec.isExited), Boolean(rec.dynamicExited)];
}

/** 状态等价判定（忽略 address 字段） */
function sameUser(a, b) {
  for (const f of [...STATE_FIELDS, "dividendClaimedDay"]) {
    const av = BOOL_FIELDS.includes(f) ? Boolean(a[f]) : BigInt(a[f] || "0").toString();
    const bv = BOOL_FIELDS.includes(f) ? Boolean(b[f]) : BigInt(b[f] || "0").toString();
    if (av !== bv) return false;
  }
  return true;
}

function loadSnapshot() {
  if (!fs.existsSync(USERS_FILE)) die(`未找到快照文件 ${USERS_FILE}，请先执行 snapshot`);
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------- 子命令 ----------------

/** snapshot：枚举全量用户（事件主源 + userList 补充 + 可选人工补充）并落盘 */
async function cmdSnapshot() {
  requireEnv(["OLD_MINING", "OLD_TOKEN"]);
  if (!FROM_BLOCK) log("[警告] FROM_BLOCK 未显式设置（默认 0）。主网扫描请显式给出部署块。");

  const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const oldMining = new Contract(OLD_MINING, MINING_READ_ABI, provider);
  const oldToken = new Contract(OLD_TOKEN, TOKEN_ABI, provider);

  const latest = TO_BLOCK ?? (await provider.getBlockNumber());
  log(`扫描 Deposited 事件：块 ${FROM_BLOCK} → ${latest}（分块 ${LOG_CHUNK}）`);
  const set = new Set();
  for (let from = FROM_BLOCK; from <= latest; from += LOG_CHUNK) {
    const to = Math.min(from + LOG_CHUNK - 1, latest);
    const logs = await oldMining.queryFilter("Deposited", from, to).catch((e) => {
      die(
        `getLogs 失败（块 ${from}-${to}）：${e.shortMessage || e.message}\n` +
          `常见原因：公共 RPC 对历史块剪枝。请换 RPC，或用 keeper 账本导出的用户清单 + EXTRA_USERS`
      );
    });
    for (const l of logs) set.add(toFile(l.args[0]));
    if ((from - FROM_BLOCK) % (LOG_CHUNK * 20) === 0) log(`  ...已扫至块 ${to}，累计 ${set.size} 人`);
  }
  log(`Deposited 事件枚举：${set.size} 人`);

  const n = Number(await oldToken.getUserCount());
  log(`链上 userList（补充源，含卖出/转出/收币）：${n} 人`);
  for (let i = 0; i < n; i++) set.add(toFile(await oldToken.getUserAt(i)));

  if (process.env.EXTRA_USERS && fs.existsSync(process.env.EXTRA_USERS)) {
    const extra = fs
      .readFileSync(process.env.EXTRA_USERS, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
    extra.forEach((a) => set.add(toFile(a)));
    log(`EXTRA_USERS 补充：${extra.length} 行`);
  }

  const users = [...set];
  const launchDay = (await oldMining.launchDay()).toString();
  log(`待迁移用户合计：${users.length} 人；旧 launchDay = ${launchDay}`);
  if (users.length === 0) die("枚举到 0 个用户，请检查 FROM_BLOCK / 地址是否正确");

  const records = [];
  for (let i = 0; i < users.length; i++) {
    records.push(await readUser(oldMining, users[i]));
    if ((i + 1) % 200 === 0) log(`  ...已读 ${i + 1}/${users.length}`);
  }

  // v9.2b：聚合「一级直推累计入金」——「在玩」判据的分子，漏填会让老用户一律掉到 2% 档
  if (OLD_CONFIG) {
    const refAddr = await new Contract(OLD_CONFIG, CONFIG_ABI, provider).referral();
    if (refAddr && refAddr.toLowerCase() !== ZERO) {
      const oldRef = new Contract(refAddr, REFERRAL_ABI, provider);
      const agg = new Map();
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        const up = await oldRef.referrerOf(r.address).catch(() => ZERO);
        const upLc = String(up || ZERO).toLowerCase();
        if (upLc !== ZERO && upLc !== r.address.toLowerCase()) {
          agg.set(upLc, (agg.get(upLc) || 0n) + BigInt(r.depositTotal || "0"));
        }
        if ((i + 1) % 200 === 0) log(`  ...直推聚合 ${i + 1}/${records.length}`);
      }
      for (const r of records) r.directDeposit = (agg.get(r.address.toLowerCase()) || 0n).toString();
      log(`直推累计已聚合：${agg.size} 人有直推下线`);
    } else {
      log("[严重警告] 旧 Config.referral() 为空 → directDeposit 全为 0，老用户将一律判「不在玩」（2% 档）");
    }
  } else {
    log("[严重警告] 未提供 OLD_CONFIG，无法读 referrerOf → directDeposit 全为 0（老用户将掉 2% 档）");
  }

  ensureDir(OUT_DIR);
  const out = {
    meta: {
      chainId: CHAIN_ID,
      createdAt: new Date().toISOString(),
      oldMining: toFile(OLD_MINING),
      oldToken: toFile(OLD_TOKEN),
      fromBlock: FROM_BLOCK,
      toBlock: latest,
      userCount: records.length,
    },
    launchDay,
    users: records,
  };
  fs.writeFileSync(USERS_FILE, JSON.stringify(out, jsonReplacer, 2));
  log(`快照已落盘：${USERS_FILE}（${records.length} 人，含 dividendClaimedDay）`);
  log("下一步：node scripts/migrate.js launchday --execute 然后 push --execute");
}

/** launchday：继承旧 launchDay（红线第 4 条） */
async function cmdLaunchDay(execute) {
  requireEnv(["OLD_MINING", "NEW_MINING"]);
  const snap = loadSnapshot();
  const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const newMining = new Contract(NEW_MINING, [...MINING_READ_ABI, ...MINING_WRITE_ABI], provider);

  const oldDay = BigInt(snap.launchDay);
  const newDay = await newMining.launchDay();
  log(`旧 launchDay = ${oldDay}；新 launchDay = ${newDay}`);
  if (oldDay === 0n) die("旧合约 launchDay 为 0，无法继承（检查 OLD_MINING 是否正确）");
  if (BigInt(newDay) === oldDay) {
    log("已继承，无需操作。");
    return;
  }
  if (BigInt(newDay) !== 0n) die(`新合约 launchDay 非 0（${newDay}）且不等于旧值，请人工核对后再执行`);

  if (!execute) {
    log("[dry-run] 将执行 newMining.setLaunchDay(" + oldDay + ")。追加 --execute 实际发送。");
    return;
  }
  const signer = makeSigner(provider);
  await ensureOwner(signer, NEW_CONFIG);
  log("发送 setLaunchDay ...");
  const tx = await newMining.connect(signer).setLaunchDay(oldDay);
  log(`tx: ${tx.hash}`);
  await tx.wait();
  log(`完成：新 launchDay = ${await newMining.launchDay()}`);
}

function makeSigner(provider) {
  const pk = process.env.MIGRATOR_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) die("写链需要 MIGRATOR_PRIVATE_KEY（0x + 64 hex）");
  return new Wallet(pk, provider);
}

/** 校验签名者是新 Config.owner()（setUserData/setLaunchDay 的权限来源） */
async function ensureOwner(signer, configAddr) {
  if (!configAddr) {
    log("[警告] NEW_CONFIG 未设置，跳过 owner 校验（合约会自行 require）");
    return;
  }
  const cfg = new Contract(configAddr, CONFIG_ABI, signer.provider);
  const owner = await cfg.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    die(`签名者 ${signer.address} 不是新 Config.owner()（${owner}），setUserData 会被拒绝`);
  }
  log(`权限校验通过：签名者 = 新 Config.owner() = ${owner}`);
}

/** push：分批 setUserData（幂等跳过已写入且一致的记录） */
async function cmdPush(execute) {
  requireEnv(["OLD_MINING", "NEW_MINING"]);
  const snap = loadSnapshot();
  const provider = new JsonRPCProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const newMining = new Contract(NEW_MINING, MINING_READ_ABI, provider);

  // 停机校验（清单第六章 T0）：旧合约应已 pause
  if (OLD_CONFIG) {
    const oldCfg = new Contract(OLD_CONFIG, CONFIG_ABI, provider);
    const paused = await oldCfg.paused().catch(() => null);
    if (paused === null) log("[警告] 无法读取旧 Config.paused()，跳过停机校验");
    else if (!paused) die("旧合约未 pause（T0 未完成）。迁移期间必须先停机再写入用户状态");
    else log("停机校验通过：旧 Config.paused() = true");
  }

  log(`快照 ${snap.users.length} 人；批大小 ${BATCH_SIZE}；模式 ${execute ? "写链" : "dry-run"}`);
  const pending = [];
  let identical = 0;
  for (const rec of snap.users) {
    const cur = await readUser(newMining, rec.address);
    if (sameUser(cur, rec)) identical++;
    else pending.push(rec);
  }
  log(`已一致（幂等跳过）：${identical} 人；待写入：${pending.length} 人`);
  if (pending.length === 0) {
    log("无待写入记录。");
    return;
  }
  if (!execute) {
    log(`[dry-run] 将分 ${Math.ceil(pending.length / BATCH_SIZE)} 批调用 setUserData。追加 --execute 实际发送。`);
    log(`  首批样例：${pending[0].address} depositTotal=${pending[0].depositTotal}`);
    return;
  }

  const signer = makeSigner(provider);
  await ensureOwner(signer, NEW_CONFIG);
  const writer = newMining.connect(signer);
  ensureDir(OUT_DIR);
  const progressFile = path.join(OUT_DIR, `push-${Date.now()}.jsonl`);

  let done = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE);
    const addrs = chunk.map((r) => r.address);
    const data = chunk.map(toWriteTuple);
    const tx = await writer.setUserData(addrs, data);
    const rc = await tx.wait();
    done += chunk.length;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      from: i,
      count: chunk.length,
      tx: tx.hash,
      block: rc.blockNumber,
      gasUsed: rc.gasUsed.toString(),
    });
    fs.appendFileSync(progressFile, line + "\n");
    log(`  批次 ${i / BATCH_SIZE + 1}：${chunk.length} 人 tx=${tx.hash} gas=${rc.gasUsed}（累计 ${done}）`);
    if (i + BATCH_SIZE < pending.length) await sleep(TX_GAP_MS);
  }
  log(`写入完成：${done} 人；进度文件 ${progressFile}`);
  log("下一步：node scripts/migrate.js verify");
}

/** verify：逐户比对新旧状态 + launchDay；有差异退出码 1 */
async function cmdVerify() {
  requireEnv(["OLD_MINING", "NEW_MINING"]);
  const snap = loadSnapshot();
  const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const oldMining = new Contract(OLD_MINING, MINING_READ_ABI, provider);
  const newMining = new Contract(NEW_MINING, MINING_READ_ABI, provider);

  log(`逐户比对 ${snap.users.length} 人 ...`);
  const diffs = [];
  for (let i = 0; i < snap.users.length; i++) {
    const rec = snap.users[i];
    const [cur, fresh] = await Promise.all([
      readUser(newMining, rec.address),
      readUser(oldMining, rec.address), // 以「当前旧合约真值」为准（防止快照过期）
    ]);
    const bad = [];
    for (const f of [...STATE_FIELDS, "dividendClaimedDay"]) {
      const exp = BOOL_FIELDS.includes(f) ? Boolean(fresh[f]) : BigInt(fresh[f] || "0").toString();
      const got = BOOL_FIELDS.includes(f) ? Boolean(cur[f]) : BigInt(cur[f] || "0").toString();
      if (exp !== got) bad.push(`${f}: 新=${got} 旧=${exp}`);
    }
    if (bad.length) diffs.push({ address: rec.address, diff: bad });
    if ((i + 1) % 200 === 0) log(`  ...已比对 ${i + 1}/${snap.users.length}`);
  }

  const oldDay = await oldMining.launchDay();
  const newDay = await newMining.launchDay();
  const dayOk = BigInt(oldDay) === BigInt(newDay);

  ensureDir(OUT_DIR);
  const report = {
    at: new Date().toISOString(),
    userCount: snap.users.length,
    mismatchCount: diffs.length,
    launchDay: { old: oldDay.toString(), new: newDay.toString(), ok: dayOk },
    diffs,
  };
  const reportFile = path.join(OUT_DIR, `verify-${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, jsonReplacer, 2));

  log(`launchDay：旧 ${oldDay} / 新 ${newDay} → ${dayOk ? "一致" : "不一致"}`);
  if (diffs.length === 0 && dayOk) {
    log(`验收通过：全部 ${snap.users.length} 人状态与旧合约逐字段相等。报告：${reportFile}`);
    return;
  }
  console.error(`验收未通过：${diffs.length} 人存在差异；报告 ${reportFile}`);
  for (const d of diffs.slice(0, 10)) console.error(`  ${d.address}: ${d.diff.join(" | ")}`);
  process.exit(1);
}

// ---------------- 入口 ----------------

const [cmd, ...flags] = process.argv.slice(2);
const EXECUTE = flags.includes("--execute");

(async () => {
  switch (cmd) {
    case "snapshot":
      await cmdSnapshot();
      break;
    case "launchday":
      await cmdLaunchDay(EXECUTE);
      break;
    case "push":
      await cmdPush(EXECUTE);
      break;
    case "verify":
      await cmdVerify();
      break;
    default:
      console.log(`用法：node scripts/migrate.js <snapshot|push|verify|launchday> [--execute]

  snapshot   只读：枚举旧合约全量用户（含纯入金用户）并落盘状态快照
  push       写入新合约（no --execute = dry-run）
  verify     逐户比对新旧状态与 launchDay
  launchday  继承旧 launchDay（no --execute = dry-run）

环境变量见脚本头部注释。快照文件：${USERS_FILE}`);
      process.exit(cmd ? 1 : 0);
  }
})().catch((e) => {
  console.error("\n[异常]", e.shortMessage || e.message || e);
  process.exit(1);
});
