/**
 * 历史事件补拉（一次性工具，可复用）
 *
 * 场景：keeper 的 START_BLOCK 被推到链头后（规避公共 RPC 的 archive 限速），
 *       之前的历史事件不会被索引，导致链下账本（users 表）与链上 userInfo 不一致、对账持续告警。
 *
 * 策略：先用二分递归定位「状态变化窗口」（依据 poolUSDT 与 ZYT totalSupply 的变化），
 *       只补拉变化点邻域（默认 25 块窗口），避免盲扫数十万区块。
 *       仅当区间首尾状态一致时才剪枝，因此若区间内出现「先增后减相互抵消」的极端情况可能漏检，
 *       脚本结束会提示，必要时可传入完整区间逐段扫描。
 *
 * 用法：
 *   cd /home/zyt/zyt-keeper
 *   ENV_FILE=.env.mainnet node scripts/backfill-history.mjs [fromBlock] [toBlock]
 *   默认 fromBlock=121785500（试运行版部署块），toBlock=START_BLOCK（当前索引起点）
 *
 * 特性：纯读链 + 幂等入库（events 表有 UNIQUE(chain_id, tx_hash, log_index)），可重复执行
 */
import fs from "fs";
import path from "path";
import { JsonRpcProvider, Interface } from "ethers";
import mysql from "mysql2/promise";
import { SUBSCRIBED } from "../src/abis.js";

const ENV_FILE = process.env.ENV_FILE || ".env.mainnet";
const envText = fs.readFileSync(path.resolve(process.cwd(), ENV_FILE), "utf8");
const get = (k) => {
  const m = envText.match(new RegExp("^" + k + "=(.+)$", "m"));
  return m ? m[1].trim() : "";
};

const RPC = get("RPC_URL");
/**
 * 历史区块 eth_call 需要 archive 能力，实测各节点：
 *   blockrazor / 1rpc → "not supported"；publicnode → 需 token；drpc → 超时
 *   blastapi → 可用 ✓（因此定位用 blastapi，事件拉取仍用 RPC_URL）
 */
const ARCHIVE_RPC = process.env.ARCHIVE_RPC || "https://bsc-mainnet.public.blastapi.io";
const CHAIN_ID = Number(get("CHAIN_ID") || 56);
const POOL = get("POOL_ADDR");
const ZYT = get("ZYT_ADDR");
const STEP = Number(process.env.BACKFILL_STEP || 25); // 单次 getLogs 上限（blockrazor 限 25）
const FROM = Number(process.argv[2] || 121785500);
const TO = Number(process.argv[3] || get("START_BLOCK"));

const ADDR_OF = {
  mining: "MINING_ADDR",
  pool: "POOL_ADDR",
  deflation: "DEFLATION_ADDR",
  forceSell: "FORCESELL_ADDR",
};

const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const archiveProvider = new JsonRpcProvider(ARCHIVE_RPC, CHAIN_ID, { staticNetwork: true });
const valIface = new Interface([
  "function poolUSDT() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

/** 读取指定区块的状态指纹（底池 USDT + ZYT 总供应）；带一次重试应对公共节点限速 */
async function fingerprintAt(block) {
  const tag = "0x" + block.toString(16);
  const call = async () => {
    const [u, s] = await Promise.all([
      archiveProvider.send("eth_call", [{ to: POOL, data: valIface.encodeFunctionData("poolUSDT") }, tag]),
      archiveProvider.send("eth_call", [{ to: ZYT, data: valIface.encodeFunctionData("totalSupply") }, tag]),
    ]);
    return (
      valIface.decodeFunctionResult("poolUSDT", u)[0].toString() +
      "|" +
      valIface.decodeFunctionResult("totalSupply", s)[0].toString()
    );
  };
  try {
    return await call();
  } catch (e) {
    await new Promise((r) => setTimeout(r, 1200));
    return await call(); // 第二次失败则向上抛，由 findWindows 记录并跳过
  }
}

/** 递归定位状态变化窗口（剪枝：首尾指纹相同则跳过整个区间） */
async function findWindows(lo, hi, out, depth = 0) {
  let a, b;
  try {
    [a, b] = await Promise.all([fingerprintAt(lo), fingerprintAt(hi)]);
  } catch (e) {
    console.warn(`  跳过 [${lo},${hi}]（查询失败：${String(e.message).slice(0, 60)}）`);
    return;
  }
  if (a === b) return; // 区间内状态无变化
  if (hi - lo <= STEP) {
    out.push([lo, hi]);
    return;
  }
  const mid = Math.floor((lo + hi) / 2);
  await findWindows(lo, mid, out, depth + 1);
  await findWindows(mid + 1, hi, out, depth + 1);
}

/** 建库连接（MySQL，读 DB_URL） */
async function connectDb() {
  const u = new URL(get("DB_URL"));
  return mysql.createConnection({
    host: u.hostname,
    port: u.port || 3306,
    user: u.username,
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  });
}

const INSERT_SQL =
  "INSERT IGNORE INTO events (chain_id, block, tx_hash, log_index, name, from_addr, to_addr, amount, extra, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)";

(async () => {
  console.log(`RPC=${RPC}  ARCHIVE_RPC=${ARCHIVE_RPC}  范围=[${FROM}, ${TO}] 窗口=${STEP}`);
  const latest = Number(await provider.getBlockNumber());
  console.log(`链上最新块=${latest}`);

  console.log("步骤 1/3：二分定位状态变化窗口…");
  const windows = [];
  await findWindows(FROM, TO, windows);
  windows.sort((x, y) => x[0] - y[0]);
  console.log(`  命中 ${windows.length} 个窗口：${windows.map((w) => w[0] + "-" + w[1]).join(", ") || "无"}`);

  if (windows.length === 0) {
    console.log("无状态变化窗口，链下账本应与链上一致（若仍告警，需用完整区间逐段扫描）");
    return;
  }

  console.log("步骤 2/3：补拉事件…");
  const addrs = [];
  const addrMap = new Map();
  for (const sub of SUBSCRIBED) {
    const addr = get(ADDR_OF[sub.addrKey]);
    if (!addr) continue;
    const k = addr.toLowerCase();
    if (!addrMap.has(k)) addrMap.set(k, []);
    addrMap.get(k).push(sub);
    addrs.push(k);
  }

  const db = await connectDb();
  let pulled = 0;
  let inserted = 0;
  const names = new Map();

  for (const [lo, hi] of windows) {
    const logs = await provider.getLogs({ address: addrs, fromBlock: lo, toBlock: hi });
    pulled += logs.length;
    for (const log of logs) {
      const subs = addrMap.get((log.address || "").toLowerCase()) || [];
      for (const sub of subs) {
        try {
          const parsed = sub.iface.parseLog({ topics: log.topics, data: log.data });
          if (!parsed) continue;
          const args = typeof parsed.args.toObject === "function" ? parsed.args.toObject() : {};
          const bigintSafe = (k, v) => (typeof v === "bigint" ? v.toString() : v);
          const fromAddr = (args.user || args.from || args.receiver || "").toString().toLowerCase();
          const toAddr = (args.to || "").toString().toLowerCase();
          const r = await db.execute(INSERT_SQL, [
            CHAIN_ID,
            log.blockNumber,
            log.transactionHash,
            log.index,
            parsed.name,
            fromAddr,
            toAddr,
            args.amount !== undefined
              ? String(args.amount)
              : String(args.usdt ?? args.reward ?? args.zytIn ?? args.usdtOut ?? ""),
            JSON.stringify(args, bigintSafe),
            Math.floor(Date.now() / 1000),
          ]);
          if (r[0].affectedRows > 0) inserted++;
          names.set(parsed.name, (names.get(parsed.name) || 0) + 1);
        } catch (e) {
          console.warn(`  解析跳过 block=${log.blockNumber}: ${String(e.message).slice(0, 60)}`);
        }
      }
    }
    await new Promise((r) => setTimeout(r, Number(process.env.BACKFILL_GAP_MS || 800)));
  }
  await db.end();

  console.log("步骤 3/3：汇总");
  console.log(`  拉到事件 ${pulled} 条，新入库 ${inserted} 条`);
  for (const [n, c] of names) console.log(`    ${n}: ${c}`);
  console.log("  keeper 会在下一轮（≤30s）rebuild 账本，随后对账应归一致");
})().catch((e) => console.error("ERROR:", String(e.message).slice(0, 300)));
