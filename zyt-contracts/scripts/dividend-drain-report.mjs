// 分红排水与储备盘点（热切换前置判定）
//
// 用法：
//   RPC_URL=... OLD_TOKEN=0x.. OLD_MINING=0x.. OLD_POOL=0x.. node scripts/dividend-drain-report.mjs
//
// 输出：
//   · 旧池分红余额 dividendPoolZyt
//   · 全体用户未领分红合计 sum(pendingDividend)
//   · 场外旧币总量 sum(balanceOf) 与地址数（供 SWAP_RESERVE / 迁移规模参考）
//   · 缺口判定：sumPending > poolDividend 时，迁移后需用 seedDividend 垫付差额
import { JsonRpcProvider, Contract, formatEther } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const RPC = env.RPC_URL || "http://127.0.0.1:8545";
const CHAIN_ID = Number(env.CHAIN_ID || 56);
const TOKEN = env.OLD_TOKEN || "";
const MINING = env.OLD_MINING || "";
const POOL = env.OLD_POOL || "";

const die = (m) => {
  console.error("✗", m);
  process.exit(1);
};
if (!TOKEN || !MINING || !POOL) die("缺少环境变量：OLD_TOKEN / OLD_MINING / OLD_POOL");

const TOKEN_ABI = [
  "function getUserCount() view returns (uint256)",
  "function getUserAt(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];
const MINING_ABI = [
  "function users(address) view returns (uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
];
const POOL_ABI = [
  "function dividendPoolZyt() view returns (uint256)",
  "function reserveUSDT() view returns (uint256)",
  "function pair() view returns (address)",
];

const fmt = (wei, d = 4) => Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: d });

async function main() {
  const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const token = new Contract(TOKEN, TOKEN_ABI, provider);
  const mining = new Contract(MINING, MINING_ABI, provider);
  const pool = new Contract(POOL, POOL_ABI, provider);

  const [divPool, reserveUsdt, supply, n] = await Promise.all([
    pool.dividendPoolZyt(),
    pool.reserveUSDT().catch(() => 0n),
    token.totalSupply(),
    token.getUserCount(),
  ]);
  console.log("旧币总量      :", fmt(supply));
  console.log("旧池分红余额  :", fmt(divPool), "ZYT");
  console.log("旧池自持 U    :", fmt(reserveUsdt), "U");
  console.log("userList 地址 :", String(n));

  let sumPending = 0n;
  let sumBal = 0n;
  let withPending = 0;
  const rows = [];
  for (let i = 0n; i < n; i++) {
    const addr = await token.getUserAt(i);
    const u = await mining.users(addr);
    const pending = BigInt(u[4]); // pendingDividend
    const bal = await token.balanceOf(addr);
    sumPending += pending;
    sumBal += bal;
    if (pending > 0n) {
      withPending++;
      rows.push({ addr, pending, bal });
    }
  }
  rows.sort((a, b) => (a.pending > b.pending ? -1 : 1));

  // 修正口径：userList 含 pair 与 Pool 合约地址，其持仓属池内/分红池，不是场外流通
  let excluded = 0n;
  try {
    const pairAddr = (await pool.pair()).toLowerCase();
    for (const addr of [pairAddr, POOL.toLowerCase()]) excluded += await token.balanceOf(addr);
  } catch {
    /* 读不到 pair 就不扣，仅提示 */
  }
  const offPool = sumBal > excluded ? sumBal - excluded : 0n;

  console.log("\n未领分红合计  :", fmt(sumPending), "ZYT", `（${withPending} 个地址待领）`);
  console.log("场外旧币合计  :", fmt(offPool), "ZYT", `（已扣除 pair/Pool 持仓 ${fmt(excluded)}）`);

  const gap = sumPending > divPool ? sumPending - divPool : 0n;
  console.log("\n=== 判定 ===");
  if (gap === 0n) {
    console.log("✓ 旧池分红余额足以覆盖全部未领分红，切换后无需垫付");
  } else {
    console.log(`⚠ 缺口 ${fmt(gap)} ZYT：旧池余额不足，切换后需用 seedDividend 补足（否则 claimDividend 会 revert）`);
    console.log("  可选处置：① 继续开放领取期让用户领走（推荐）② 项目方自有 ZYT 垫付");
  }
  if (rows.length) {
    console.log("\n未领分红 Top10：");
    for (const r of rows.slice(0, 10)) {
      console.log(`  ${r.addr}  待领 ${fmt(r.pending)}  持仓 ${fmt(r.bal)}`);
    }
  }

  const outDir = path.join(ROOT, "output", "migration");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `dividend-drain-${Date.now()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        chainId: CHAIN_ID,
        token: TOKEN,
        mining: MINING,
        pool: POOL,
        totalSupply: supply.toString(),
        dividendPoolZyt: divPool.toString(),
        reserveUSDT: reserveUsdt.toString(),
        sumPendingDividend: sumPending.toString(),
        sumOffPoolBalance: sumBal.toString(),
        accountsWithPending: withPending,
        gapToSeed: gap.toString(),
        top: rows.slice(0, 50).map((r) => ({ addr: r.addr, pending: r.pending.toString(), bal: r.bal.toString() })),
      },
      null,
      2
    )
  );
  console.log(`\n报表：${file}`);
}

main().catch((e) => die(e.shortMessage || e.stack || e.message));
