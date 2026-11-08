import { JsonRpcProvider } from "ethers";
import { CONFIG } from "./config.js";
import { getDb } from "./db.js";
import { SUBSCRIBED } from "./abis.js";
import { logRun } from "./alert.js";

/**
 * 区分 getLogs 失败原因（2026-11-08）。
 * 背景：原实现把所有异常一律当「历史剪枝」处理，直接跳过 900 块。实测 blockrazor 返回
 *   429 too many requests 时也走了跳块分支，一次丢掉 8 条 Sold / 2 条 Claimed /
 *   2 条 DividendSettled（132146847-132148842 区间）。Sold 决定静态 2 倍出局进度，
 *   丢失会让账本误判用户未出局，算力继续复利，摊薄全网分红分母。
 * 返回：
 *   "retry"  限流/超时/网络抖动，退避重试同一区间，绝不跳块
 *   "pruned" 节点真的没有历史数据（-32701），才允许跳块并记录精确区间
 *   "fatal"  其他错误，抛出交由上层（轮询下一轮会重来）
 */
export function classifyRpcError(e) {
  const info = e?.info?.error || {};
  const code = info.code ?? e?.code;
  const msg = String(info.message || e?.shortMessage || e?.message || "").toLowerCase();
  // 剪枝优先判断：部分节点把剪枝也包成 -32005，靠消息里的 pruned 兜底
  if (code === -32701 || msg.includes("pruned") || msg.includes("history has been")) return "pruned";
  if (code === 429 || code === -32005) return "retry";
  if (msg.includes("too many") || msg.includes("rate limit") || msg.includes("limit exceeded")) return "retry";
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("socket") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    e?.code === "TIMEOUT"
  ) {
    return "retry";
  }
  return "fatal";
}

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

    // 2026-11-08：限流重试计数，成功一次即清零
    const MAX_RETRY = 3;
    let retry = 0;
    while (from <= latest) {
      const to = Math.min(from + range - 1, latest);
      let logs;
      try {
        logs = await this.provider.getLogs({ address: addrList, fromBlock: from, toBlock: to });
        retry = 0; // 成功即复位
      } catch (e) {
        const kind = classifyRpcError(e);
        // 429 / 超时 / 网络抖动：退避后重试同一区间。跳块会永久丢事件，这里宁可慢也不能漏。
        if (kind === "retry") {
          retry++;
          if (retry <= MAX_RETRY) {
            const wait = 2000 * retry;
            console.warn(
              `[indexer] ${from}-${to} 限流或超时（第 ${retry} 次），${wait}ms 后重试同一区间`
            );
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          console.warn(`[indexer] ${from}-${to} 重试 ${MAX_RETRY} 次仍失败，抛错等待下一轮轮询`);
          throw e;
        }
        // 真正的历史剪枝（-32701 / pruned）才允许跳块
        if (kind === "pruned") {
          const SAFE_WINDOW = 900; // 保留窗口（实测公共节点近 1 万块可用，900 更保守）
          const jumpTo = latest - SAFE_WINDOW;
          if (to < jumpTo) {
            console.warn(
              `[indexer] pruned history ${from}-${to}（节点已剪枝）；跳过至 ${jumpTo}，该区间事件缺失`
            );
            logRun("indexer", "gap", `pruned ${from}-${to} → resume ${jumpTo}`);
            from = jumpTo;
            continue;
          }
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
      // 2026-11-08：每批成功即落独立游标表。原实现靠 events 的 MAX(block) 恢复，
      // 而「没有事件的块」不会推进 events，游标因此长期停在旧块，每次重启就从很久以前重扫，
      // 撞上节点剪枝窗口后直接跳块丢数据（今天两次 pruned 就是这么来的）。
      this.lastBlock = to;
      try {
        await db.run(
          "INSERT INTO indexer_state (chain_id, last_block, updated_at) VALUES (?,?,?) ON CONFLICT(chain_id) DO UPDATE SET last_block=excluded.last_block, updated_at=excluded.updated_at",
          [CONFIG.chainId, to, Math.floor(Date.now() / 1000)]
        );
      } catch (e) {
        console.warn("[indexer] 写游标失败:", String(e.message).slice(0, 80));
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
    // 2026-11-08：游标优先取独立表 indexer_state，回退 events 的 MAX(block)。
    // 原因：events 只在有事件时推进，长时间无事件的行情下列的 MAX(block) 会停在旧块，
    //       重启后从旧块重扫，撞上节点剪枝窗口就跳块丢数据。
    try {
      const db = await getDb();
      const st = await db.get("SELECT last_block FROM indexer_state WHERE chain_id=?", [CONFIG.chainId]);
      const saved = st && st.last_block ? Number(st.last_block) : 0;
      if (saved > this.lastBlock) {
        logRun("indexer", "ok", `resume cursor from indexer_state last_block=${saved}`);
        this.lastBlock = saved;
      } else {
        // 老库首次升级：indexer_state 还没有记录，用 events 的 MAX(block) 兜底
        const row = await db.get("SELECT MAX(block) AS m FROM events WHERE chain_id=?", [CONFIG.chainId]);
        const maxBlock = row && row.m ? Number(row.m) : 0;
        if (maxBlock > this.lastBlock) {
          logRun("indexer", "ok", `resume cursor from DB MAX(block)=${maxBlock}（跳过 ${this.lastBlock}-${maxBlock} 重扫）`);
          this.lastBlock = maxBlock;
        }
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
