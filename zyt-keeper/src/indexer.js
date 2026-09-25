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

    // v16：按地址聚合订阅，一次 getLogs 拉全部合约地址
    // 原因：原先对每个合约地址单独请求（4 个地址 = 4 次/批），公共节点在首次全量同步时高频调用会触发 429 限速
    const addrMap = new Map();
    for (const sub of SUBSCRIBED) {
      const addr = CONFIG.contracts[sub.addrKey];
      if (!addr) continue;
      const k = addr.toLowerCase();
      if (!addrMap.has(k)) addrMap.set(k, []);
      addrMap.get(k).push(sub);
    }
    const addrList = [...addrMap.keys()];
    if (addrList.length === 0) return 0;

    while (from <= latest) {
      const to = Math.min(from + range - 1, latest);
      let logs;
      try {
        logs = await this.provider.getLogs({ address: addrList, fromBlock: from, toBlock: to });
      } catch (e) {
        // 2026-09-25：公共 RPC（publicnode / 官方 data-seed）对老区块 getLogs 剪枝（-32701
        // "History has been pruned"）。原实现在此整轮抛错 → 游标停滞、后续所有事件持续漏抓。
        // 自愈策略：低于安全窗口的历史区间放弃（记录 gap），直接跳到最近 SAFE_WINDOW 块继续。
        const SAFE_WINDOW = 900; // 保留窗口（实测公共节点近 1 万块可用，900 更保守）
        const jumpTo = latest - SAFE_WINDOW;
        if (to < jumpTo) {
          console.warn(
            `[indexer] pruned history ${from}-${to}（公共 RPC 剪枝）；跳过至 ${jumpTo}，该区间事件缺失`
          );
          logRun("indexer", "gap", `pruned ${from}-${to} → resume ${jumpTo}`);
          from = jumpTo;
          continue;
        }
        throw e;
      }
      for (const log of logs) {
        // 按日志来源地址定位对应的合约订阅（避免用错 iface 解析）
        const subs = addrMap.get((log.address || "").toLowerCase()) || [];
        for (const sub of subs) {
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
            // v17：金额字段候选扩展（各事件参数名不同，原实现会落库为字符串 "undefined"）
            // v9 新增：lpBurned（LiquidityInjected）/ burned（Deflated）/ dividend（Deflated）
            const amountVal =
              args.amount ??
              args.usdt ??
              args.usdtAmount ??
              args.usdtValue ??
              args.usdtIn ??
              args.reward ??
              args.zytIn ??
              args.usdtOut ??
              args.liquidity ??
              args.zytAmount ??
              args.lpBurned ??
              args.burned ??
              args.dividend ??
              "";
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
                String(amountVal),
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
      // v16：批间限速（公共 RPC 对 getLogs 有频率限制，连续请求会 429）
      if (CONFIG.indexer.batchDelayMs > 0 && from <= latest) {
        await new Promise((r) => setTimeout(r, CONFIG.indexer.batchDelayMs));
      }
    }
    this.lastBlock = latest;
    return count;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    // 2026-09-25：启动游标优先取 DB 已索引位置（MAX(block)+1）。
    // 背景：公共 RPC 剪枝老区块，每次重启从 START_BLOCK 重扫都会大量报错并制造无效 gap 日志；
    // 已索引过的区间无需重扫（事件表 UNIQUE 幂等，但省去无用 RPC 调用与噪音）。
    try {
      const db = await getDb();
      const row = await db.get("SELECT MAX(block) AS m FROM events WHERE chain_id=?", [CONFIG.chainId]);
      const maxBlock = row && row.m ? Number(row.m) : 0;
      if (maxBlock > this.lastBlock) {
        logRun("indexer", "ok", `resume cursor from DB MAX(block)=${maxBlock}（跳过 ${this.lastBlock}-${maxBlock} 重扫）`);
        this.lastBlock = maxBlock;
      }
    } catch {
      /* 读游标失败则退回 START_BLOCK 全量重扫 */
    }
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
