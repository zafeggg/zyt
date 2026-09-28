/**
 * 验证 keeper 账本口径下的「全网算力」与「单用户算力」是否与链上一致。
 * 做法：拉取链上全部 Deposited 事件写入内存 SQLite，跑 Ledger.rebuild，
 *       输出每个用户的账本算力 / 链上算力，以及全网算力合计。
 * 用法：cd zyt-keeper && node scripts/verify-power-day.mjs [可选:单个地址]
 * 退出码：0 = 全部一致（误差 ≤ 1），1 = 存在偏差
 */
process.env.CHAIN_ID = process.env.CHAIN_ID || "97";
process.env.RPC_URL = process.env.RPC_URL || "https://bsc-testnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3";
process.env.MINING_ADDR = process.env.MINING_ADDR || "0x7e3507050db25AD09f2D772Df72C4bea3bae0b04";
process.env.POOL_ADDR = process.env.POOL_ADDR || "0x36fa17d24dD706c5a9F61e4Afb47eD3C357b349e";
process.env.ZYT_ADDR = process.env.ZYT_ADDR || "0x9D434F75564410d6e41664716defEd92d95985C1";
process.env.CONFIG_ADDR = process.env.CONFIG_ADDR || "0x8402D46f5974301028Ee461d485748b71b0dc487";
process.env.START_BLOCK = process.env.START_BLOCK || "132873786";
// 强制内存 SQLite，不触碰线上库（置空而非 delete：dotenv 不覆盖已存在的键，可挡住 .env 里的 DB_URL）
process.env.DB_URL = "";

const ethers = await import("ethers");
const { Ledger } = await import("../src/ledger.js");
const { getDb } = await import("../src/db.js");

const { JsonRpcProvider, Contract, Interface, id, formatEther } = ethers;
const CHAIN_ID = Number(process.env.CHAIN_ID);
const START = Number(process.env.START_BLOCK);
const ONLY = process.argv[2] ? process.argv[2].toLowerCase() : "";

const provider = new JsonRpcProvider(process.env.RPC_URL, CHAIN_ID, { staticNetwork: true });
const mining = new Contract(process.env.MINING_ADDR, [
  "function powerOf(address) view returns (uint256)",
  "function dailyInfo(uint256) view returns (uint256 totalPower, uint256 dividendAmount)",
  "function launchDay() view returns (uint64)", // 2026-09-28：v16 复利基准，ledger._getLaunchDay 链上权威路径
], provider);
const TOPIC = id("Deposited(address,uint256,uint256,uint256,address)");
const iface = new Interface(["event Deposited(address indexed user, uint256 usdt, uint256 power, uint256 quota, address ref)"]);

const latest = await provider.getBlockNumber();
const topics = ONLY ? [TOPIC, "0x000000000000000000000000" + ONLY.slice(2)] : [TOPIC];
const logs = [];
for (let from = START; from <= latest; from += 50000) {
  const to = Math.min(from + 49999, latest);
  const part = await provider.getLogs({ address: process.env.MINING_ADDR, topics, fromBlock: from, toBlock: to });
  logs.push(...part);
}
console.log("链上 Deposited 事件数:", logs.length, ONLY ? "(仅 " + ONLY + ")" : "(全部用户)");

const db = await getDb();
for (const l of logs) {
  const p = iface.parseLog({ topics: l.topics, data: l.data });
  const user = String(p.args[0]).toLowerCase();
  const extra = {
    user,
    usdt: p.args[1].toString(),
    power: p.args[2].toString(),
    quota: p.args[3].toString(),
    ref: p.args[4],
  };
  await db.run(
    "INSERT OR IGNORE INTO events (chain_id, block, tx_hash, log_index, name, from_addr, to_addr, amount, extra, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [CHAIN_ID, l.blockNumber, l.transactionHash, l.index, "Deposited", user, "", extra.usdt, JSON.stringify(extra), Math.floor(Date.now() / 1000)]
  );
}

const ledger = new Ledger(provider, { mining });
await ledger.rebuild();

const rows = await db.all("SELECT address, power_base, power_day FROM users");
console.log("\n=== 逐用户对比 ===");
let allOk = true;
for (const r of rows) {
  const local = await ledger.powerOf(r.address);
  const chain = await mining.powerOf(r.address);
  const diff = local > chain ? local - chain : chain - local;
  const ok = diff <= 1n;
  if (!ok) allOk = false;
  console.log(
    (ok ? "  ✔ " : "  ✘ ") +
      r.address +
      " | base=" + formatEther(r.power_base) +
      " power_day=" + r.power_day +
      " | 账本=" + formatEther(local) +
      " 链上=" + formatEther(chain)
  );
}

const totalPower = await ledger.totalPower();
console.log("\n=== 全网算力（口径对照）===");
console.log("  keeper 账本 totalPower（当前）:", formatEther(totalPower));
const today = Math.floor(Date.now() / 86400000);
for (const d of [today - 2, today - 1, today]) {
  const tp = await ledger.totalPower(d);
  const di = await mining.dailyInfo(d);
  const diff = tp > di[0] ? tp - di[0] : di[0] - tp;
  console.log(
    "  day " + d +
    " | 账本 ΣpowerOf=" + formatEther(tp) +
    " | 链上 dailyInfo=" + formatEther(di[0]) +
    " | " + (diff === 0n ? "✔ 一致" : "差 " + formatEther(diff))
  );
}
console.log(allOk ? "\n✔ 全部用户算力与链上一致" : "\n✘ 存在偏差，需排查");
process.exit(allOk ? 0 : 1);
