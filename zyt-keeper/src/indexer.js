import { JsonRpcProvider } from "ethers";
import { CONFIG } from "./config.js";
import { getDb } from "./db.js";
import { SUBSCRIBED } from "./abis.js";
import { logRun } from "./alert.js";

/**
 * 链上事件索引器：轮询 getLogs（无需 WebSocket 节点），解析事件入库。
 * 事件落库后由 ledger 模块汇总为用户/池状态。
 */
export class Indexer {
  constructor({ onEvent } = {}) {
    this.provider = new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
    this.lastBlock = CONFIG.indexer.startBlock;
    this.running = false;
    // 可选事件回调（监控引擎 R2 大额卖出实时判定用），签名 (name, args)
    this.onEvent = onEvent || null;
  }

  async syncOnce() {
    const db = await getDb();
    const latest = await this.provider.getBlockNumber();
    if (latest <= this.lastBlock) return 0;

    let from = this.lastBlock + 1;
    const range = CONFIG.indexer.blockRange;
    let count = 0;
    const INSERT_SQL =
      "INSERT OR IGNORE INTO events (chain_id, block, tx_hash, log_index, name, from_addr, to_addr, amount, extra, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)";

    while (from <= latest) {
      const to = Math.min(from + range - 1, latest);
      for (const sub of SUBSCRIBED) {
        const addr = CONFIG.contracts[sub.addrKey];
        if (!addr) continue;
        const logs = await this.provider.getLogs({ address: addr, fromBlock: from, toBlock: to });
        for (const log of logs) {
          try {
            const parsed = sub.iface.parseLog({ topics: log.topics, data: log.data });
            if (!parsed) continue;
            // ethers v6 Result：用 toObject() 取具名参数（Object.entries 会丢具名键）
            const args =
              typeof parsed.args.toObject === "function"
                ? parsed.args.toObject()
                : {};
            const bigintSafe = (k, v) => (typeof v === "bigint" ? v.toString() : v);
            // 地址统一小写（链上返回 checksum 地址）
            const fromAddr = (args.user || args.from || args.receiver || "").toString().toLowerCase();
            const toAddr = (args.to || "").toString().toLowerCase();
            await db.run(
              INSERT_SQL,
              [
                CONFIG.chainId,
                log.blockNumber,
                log.transactionHash,
                log.index,
                parsed.name,
                fromAddr,
                toAddr,
                args.amount !== undefined ? String(args.amount) : String(args.usdt ?? args.reward ?? args.zytIn ?? args.usdtOut ?? ""),
                JSON.stringify(args, bigintSafe),
                Math.floor(Date.now() / 1000),
              ]
            );
            count++;
            // 实时事件回调（监控引擎；异步 fire-and-forget，不阻塞索引）
            if (this.onEvent) {
              this.onEvent(parsed.name, args).catch((e) =>
                console.warn("[indexer] onEvent error:", parsed.name, e.message)
              );
            }
          } catch (e) {
            console.warn("[indexer] skip log:", log.blockNumber, e.message);
          }
        }
      }
      from = to + 1;
    }
    this.lastBlock = latest;
    return count;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    // 初始同步
    try {
      const n = await this.syncOnce();
      logRun("indexer", "ok", `initial sync +${n} events, lastBlock=${this.lastBlock}`);
    } catch (e) {
      logRun("indexer", "error", e.message);
    }
    // 轮询
    setInterval(async () => {
      try {
        const n = await this.syncOnce();
        if (n > 0) logRun("indexer", "ok", `+${n} events`);
      } catch (e) {
        logRun("indexer", "error", e.message);
      }
    }, CONFIG.indexer.pollIntervalMs);
  }
}
