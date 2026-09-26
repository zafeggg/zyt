/**
 * 手动补跑每日快照（仅当 keeper 未自动执行时使用）
 *
 * ⚠️ 严重注意：dailySnapshot(totalPower) 的 totalPower 是「全网算力总和」，
 *    keeper 正常流程取 ledger.totalPower()（链下账本计算）。
 *    绝不能用 mining.dailyInfo(今日).totalPower —— 那是快照的输出，未快照时为 0，
 *    传 0 会导致当日分红分母为 0，用户无法结算该日分红（且同日不可重跑，不可逆）。
 *    本脚本内置 tp==0 拒绝发送的保护。
 *
 * 用法：
 *   node scripts/trigger-snapshot.mjs                # 自动取权重（keeper /stats → 昨日链上值）
 *   node scripts/trigger-snapshot.mjs --tp 1500      # 手动指定权重（谨慎）
 *   node scripts/trigger-snapshot.mjs --dry          # 只检查不发交易
 *
 * 环境：zyt-contracts/.env 的 PRIVATE_KEY = owner（deployer，有权限），或 keeper 私钥
 */
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import "dotenv/config";

const RPC = process.env.BSC_TESTNET_RPC || "https://bsc-testnet-rpc.publicnode.com";
const DEFLATION = process.env.DEFLATION_ADDR || "0x80a98C926755604A5582289eecd3eB25C816EF8b";
const MINING = process.env.MINING_ADDR || "0x7e3507050db25AD09f2D772Df72C4bea3bae0b04";
const KEEPER_API = process.env.KEEPER_API || "http://127.0.0.1:8080";

const p = new JsonRpcProvider(RPC, 97, { staticNetwork: true });
const wallet = new Wallet(process.env.PRIVATE_KEY, p);
const deflation = new Contract(
  DEFLATION,
  ["function dailySnapshot(uint256)","function lastSnapshotDay() view returns (uint256)","function snapshotCount() view returns (uint256)"],
  wallet
);
const mining = new Contract(MINING, ["function dailyInfo(uint256) view returns (uint256,uint256)"], p);

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const tpArg = args.includes("--tp") ? args[args.indexOf("--tp") + 1] : null;

async function main() {
  const today = Math.floor(Date.now() / 86400000);
  const lastDay = Number(await deflation.lastSnapshotDay());
  console.log("=== 快照补跑检查 ===");
  console.log("今日 UTC 日  :", today);
  console.log("链上已快照至 :", lastDay, lastDay >= today ? "（今日已完成，无需补跑）" : "（今日待补）");
  if (lastDay >= today && !dry) {
    console.log("同日不可重跑（合约 require day > lastSnapshotDay），退出。");
    return;
  }

  // 权重来源优先级：① --tp 指定 ② keeper /stats networkPower ③ 昨日链上 totalPower
  let tp = 0n;
  if (tpArg) {
    tp = BigInt(Math.round(Number(tpArg) * 1e18));
    console.log("权重来源     : --tp 指定");
  } else {
    try {
      const res = await fetch(`${KEEPER_API}/stats`, { signal: AbortSignal.timeout(15000) });
      const j = await res.json();
      if (j.networkPower && BigInt(j.networkPower) > 0n) {
        tp = BigInt(j.networkPower);
        console.log("权重来源     : keeper /stats networkPower");
      }
    } catch {
      /* 落到链上兜底 */
    }
    if (tp === 0n) {
      for (let d = lastDay; d > lastDay - 3 && tp === 0n; d--) {
        const di = await mining.dailyInfo(d);
        tp = BigInt(di[0]);
      }
      console.log("权重来源     : 链上历史 dailyInfo（最近有效日）");
    }
  }
  console.log("待传 totalPower:", tp.toString(), `(${Number(tp) / 1e18})`);

  if (tp === 0n) {
    console.error("❌ totalPower 为 0，拒绝发送（传 0 会导致当日分红无法分配，且不可重跑）");
    process.exit(1);
  }
  if (dry) {
    console.log("--dry 模式，未发送交易");
    return;
  }

  const tx = await deflation.dailySnapshot(tp);
  const r = await tx.wait();
  console.log("✔ tx:", tx.hash, "| status:", r.status, "| block:", r.blockNumber);
  console.log("快照后 lastSnapshotDay:", String(await deflation.lastSnapshotDay()), "| snapshotCount:", String(await deflation.snapshotCount()));
}

main().catch((e) => {
  console.error("失败:", e.shortMessage || e.message);
  process.exit(1);
});
