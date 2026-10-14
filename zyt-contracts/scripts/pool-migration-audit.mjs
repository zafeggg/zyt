/**
 * ZYT v9.2 迁移：底池资产盘点（只读，不改链）
 *
 * 目的：迁移前给出「旧池可回收多少」的事实，供多签做资金决策。
 * 关键事实（务必先读）：
 *   - 入金产生的 LP 已全额转黑洞（0x…dEaD），**不可回收**；
 *   - 可回收的只有 Creator 持有的初始 LP（持续被每日通缩报销、owner 亦可提取）；
 *   - 新池需要 2.1 万 USDT + 21 亿 ZYT（ZYT 由新 Creator 现铸，USDT 需真金）。
 * 因此本脚本输出可回收 USDT 与新池 2.1 万 U 门槛的差额，即项目方需另行准备的缺口。
 *
 * 用法：
 *   RPC_URL=... OLD_PAIR=0x.. OLD_CREATOR=0x.. OLD_POOL=0x.. OLD_TOKEN=0x.. \
 *     node scripts/pool-migration-audit.mjs
 *
 * 输出：控制台报告 + output/migration/pool-audit-<ts>.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Contract, formatEther } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "output", "migration");

const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID || 56);
const PAIR = process.env.OLD_PAIR || "";
const CREATOR = process.env.OLD_CREATOR || "";
const POOL = process.env.OLD_POOL || "";
const TOKEN = process.env.OLD_TOKEN || "";
const BLACK_HOLE = process.env.BLACK_HOLE || "0x000000000000000000000000000000000000dEaD";
const NEW_SEED_USDT = Number(process.env.NEW_SEED_USDT || 21000); // 新池底池 USDT

if (!PAIR || !CREATOR || !POOL || !TOKEN) {
  console.error("缺少环境变量：OLD_PAIR / OLD_CREATOR / OLD_POOL / OLD_TOKEN");
  process.exit(1);
}

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
];
const CREATOR_ABI = [
  "function lockedLiquidity() view returns (uint256)",
  "function totalLpWithdrawn() view returns (uint256)",
  "function totalDeflationZytOut() view returns (uint256)",
  "function totalDeflationUsdtOut() view returns (uint256)",
  "function totalZytSeeded() view returns (uint256)",
  "function totalUsdtSeeded() view returns (uint256)",
];
const POOL_ABI = [
  "function poolUSDT() view returns (uint256)",
  "function poolZYT() view returns (uint256)",
  "function dividendPoolZyt() view returns (uint256)",
  "function reserveUSDT() view returns (uint256)",
  "function totalLpBurned() view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
];

const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const pair = new Contract(PAIR, PAIR_ABI, provider);
const creator = new Contract(CREATOR, CREATOR_ABI, provider);
const pool = new Contract(POOL, POOL_ABI, provider);
const zyt = new Contract(TOKEN, ERC20_ABI, provider);

const [r0, r1, lpTotal, token0, creatorLp, blackHoleLp, poolUsdtBal, poolZytBal, divPoolZyt, reserveUsdt, totalLpBurned, totalSupply] =
  await Promise.all([
    pair.getReserves().then((r) => r[0]),
    pair.getReserves().then((r) => r[1]),
    pair.totalSupply(),
    pair.token0(),
    creator.lockedLiquidity(),
    pair.balanceOf(BLACK_HOLE),
    zyt.balanceOf(POOL),
    zyt.balanceOf(PAIR),
    pool.dividendPoolZyt(),
    pool.reserveUSDT(),
    pool.totalLpBurned(),
    zyt.totalSupply(),
  ]);

const zytIsToken0 = token0.toLowerCase() === TOKEN.toLowerCase();
const zytReserve = zytIsToken0 ? r0 : r1;
const usdtReserve = zytIsToken0 ? r1 : r0;

/** V2 burn 近似：按 LP 占比取回两侧（忽略 MINIMUM_LIQUIDITY 的微量偏差） */
function share(lp) {
  if (lpTotal === 0n) return { zyt: 0n, usdt: 0n };
  return {
    zyt: (zytReserve * lp) / lpTotal,
    usdt: (usdtReserve * lp) / lpTotal,
  };
}

const recoverable = share(creatorLp);
const burnedShare = share(blackHoleLp);
const gap = BigInt(NEW_SEED_USDT) * 10n ** 18n - recoverable.usdt;

console.log("===== ZYT v9.2 迁移底池资产盘点（只读）=====\n");
console.log(`DEX pair 储备      : ZYT ${formatEther(zytReserve)} / USDT ${formatEther(usdtReserve)}`);
console.log(`LP 总量            : ${formatEther(lpTotal)}`);
console.log(`  Creator 持有     : ${formatEther(creatorLp)}（可回收）`);
console.log(`  黑洞持有         : ${formatEther(blackHoleLp)}（不可回收）`);
console.log(`  累计销毁 LP      : ${formatEther(totalLpBurned)}`);
console.log(`旧 ZYT 总供应      : ${formatEther(totalSupply)}\n`);
console.log(`可回收（Creator LP 份额）：ZYT ${formatEther(recoverable.zyt)} / USDT ${formatEther(recoverable.usdt)}`);
console.log(`不可回收（黑洞 LP 份额） ：ZYT ${formatEther(burnedShare.zyt)} / USDT ${formatEther(burnedShare.usdt)}\n`);
console.log(`旧 PoolManager 自持：USDT ${formatEther(poolUsdtBal)}（含 reserveUSDT ${formatEther(reserveUsdt)}）`);
console.log(`分红池 ZYT（待发）  : ${formatEther(divPoolZyt)}`);
console.log(`pair 内 ZYT 储备    : ${formatEther(poolZytBal)}\n`);
console.log(`新池所需 USDT       : ${NEW_SEED_USDT}`);
console.log(`可回收 USDT         : ${formatEther(recoverable.usdt)}`);
console.log(
  gap > 0n
    ? `资金缺口            : ${formatEther(gap)} U 需项目方另行准备`
    : `资金余量            : ${formatEther(-gap)} U`
);
console.log("\n提示：新池 ZYT 由新 Creator 现铸 21 亿，无需从旧池搬运；旧 ZYT 经 ZYTSwap 1:1 兑换。");

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = {
  at: new Date().toISOString(),
  chainId: CHAIN_ID,
  pair: PAIR,
  zytIsToken0,
  reserves: { zyt: zytReserve.toString(), usdt: usdtReserve.toString() },
  lp: {
    total: lpTotal.toString(),
    creator: creatorLp.toString(),
    blackHole: blackHoleLp.toString(),
    totalBurned: totalLpBurned.toString(),
  },
  recoverable: { zyt: recoverable.zyt.toString(), usdt: recoverable.usdt.toString() },
  unrecoverable: { zyt: burnedShare.zyt.toString(), usdt: burnedShare.usdt.toString() },
  oldPoolSelfHeld: { usdt: poolUsdtBal.toString(), reserveUSDT: reserveUsdt.toString(), dividendZyt: divPoolZyt.toString() },
  newPoolSeedUsdt: String(NEW_SEED_USDT),
  fundingGap: gap.toString(),
  oldZytTotalSupply: totalSupply.toString(),
};
const file = path.join(OUT_DIR, `pool-audit-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\n报告已落盘：${file}`);
