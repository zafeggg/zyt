import { JsonRpcProvider, Contract, formatEther } from "ethers";
import { CONFIG } from "./config.js";
import { getDb } from "./db.js";
import { logRun, notify } from "./alert.js";
import { POOL_VIEW_ABI } from "./abis.js";

/**
 * 监控规则引擎（生产缺口 #4）
 *
 * 5 类规则（每类独立冷却 cooldownMs，防告警风暴）：
 *   R1-POOL-MOVE      底池突变：poolUSDT 相对上次监控值变化 > poolDropPct%
 *   R2-BIG-SELL       大额卖出：单笔卖出 usdtOut > 底池 USDT × bigSellPct%（indexer 事件实时判定）
 *   R3-SLIPPAGE-JUMP  滑点档位跳变：当前滑点较上次监控升高（底池 GST 被抽血，下跌控盘信号）
 *   R4-INDEX-LAG      索引延迟：latest − indexer.lastBlock > indexLagBlocks
 *   R5-ERROR-RATE     调用失败率：最近 errorWindowSec 内 keeper_runs error 占比 > errorRatePct%
 *
 * 规则判定依赖链上只读视图 + 本地 DB（keeper_runs），全部为 view/本地查询，
 * 不产生写交易，天然无重入/资金风险。
 */
export class Monitor {
  /**
   * @param {object} [opts]
   * @param {object} [opts.provider] 可注入 stub（测试用），默认自建
   * @param {object} [opts.pool]     可注入 stub pool 合约，默认自建
   */
  constructor({ provider, pool } = {}) {
    this.provider = provider ?? new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
    this.pool = pool ?? new Contract(CONFIG.contracts.pool, POOL_VIEW_ABI, this.provider);
    this.indexer = null;
    this.lastPoolUsdt = null; // 上次监控的 poolUSDT（null=首次，仅记基线不判定）
    this.lastSlippage = null; // 上次监控滑点（基点，如 500=5%）
    this.cooldown = new Map(); // rule -> 上次告警时间戳（冷却防风暴）
  }

  /** 注入 indexer（R4 索引延迟需要其 lastBlock） */
  setIndexer(indexer) {
    this.indexer = indexer;
  }

  /** 冷却检查：冷却期内不重复告警（每规则独立计时） */
  _canAlert(rule) {
    const last = this.cooldown.get(rule) || 0;
    if (Date.now() - last < CONFIG.monitor.cooldownMs) return false;
    this.cooldown.set(rule, Date.now());
    return true;
  }

  async _alert(rule, message) {
    if (!this._canAlert(rule)) return;
    logRun("monitor", "alert", `[${rule}] ${message}`);
    await notify(`[ZYT Monitor][${rule}] ${message}`);
  }

  /** 周期检查（index.js 定时调用）：R1/R3/R4/R5 */
  async checkOnce() {
    // 链上只读：底池 USDT + 当前滑点
    const [poolUsdt, slippage] = await Promise.all([
      this.pool.poolUSDT(),
      this.pool.getCurrentSlippage(),
    ]);

    // ---- R1 底池突变（相对上次监控值；首次仅记基线） ----
    if (this.lastPoolUsdt !== null && this.lastPoolUsdt > 0n) {
      const delta = poolUsdt > this.lastPoolUsdt ? poolUsdt - this.lastPoolUsdt : this.lastPoolUsdt - poolUsdt;
      const pct = (delta * 10000n) / this.lastPoolUsdt; // 万分比精度
      const threshold = BigInt(Math.round(CONFIG.monitor.poolDropPct * 100));
      if (pct > threshold) {
        const dir = poolUsdt >= this.lastPoolUsdt ? "上升" : "下跌";
        await this._alert(
          "R1-POOL-MOVE",
          `底池USDT ${dir} ${Number(pct) / 100}%（阈值 ${CONFIG.monitor.poolDropPct}%）：${formatEther(this.lastPoolUsdt)} → ${formatEther(poolUsdt)} U`
        );
      }
    }
    this.lastPoolUsdt = poolUsdt;

    // ---- R3 滑点档位跳变（升高=底池GST被抽血） ----
    // 注意：getCurrentSlippage() 返回 uint256 → ethers 解析为 BigInt，算术需显式转换
    const slipPct = Number(slippage) / 100;
    if (this.lastSlippage !== null && slippage > this.lastSlippage) {
      await this._alert(
        "R3-SLIPPAGE-JUMP",
        `滑点档位升高：${Number(this.lastSlippage) / 100}% → ${slipPct}%（底池GST被抽血，下跌控盘触发）`
      );
    }
    this.lastSlippage = slippage;

    // ---- R4 索引延迟 ----
    if (this.indexer) {
      try {
        const latest = Number(await this.provider.getBlockNumber());
        const lag = latest - Number(this.indexer.lastBlock);
        if (lag > CONFIG.monitor.indexLagBlocks) {
          await this._alert(
            "R4-INDEX-LAG",
            `索引延迟 ${lag} 块（阈值 ${CONFIG.monitor.indexLagBlocks}）：lastBlock=${this.indexer.lastBlock} latest=${latest}`
          );
        }
      } catch (e) {
        logRun("monitor", "error", `R4 getBlockNumber: ${e.message}`);
      }
    }

    // ---- R5 调用失败率（本地 DB 统计） ----
    await this._checkErrorRate();

    logRun("monitor", "ok", `poolUSDT=${formatEther(poolUsdt)} slippage=${slipPct}%`);
  }

  /** R5：最近窗口内 keeper_runs 的 error 占比 */
  async _checkErrorRate() {
    try {
      const db = await getDb();
      const winStart = Math.floor(Date.now() / 1000) - CONFIG.monitor.errorWindowSec;
      const rows = await db.all(
        `SELECT COUNT(*) AS total,
                COUNT(CASE WHEN status='error' THEN 1 END) AS errors
         FROM keeper_runs
         WHERE created_at >= ? AND type IN ('indexer','ledger','keeper','reconcile')`,
        [winStart]
      );
      const total = Number(rows[0]?.total || 0);
      const errors = Number(rows[0]?.errors || 0);
      // 样本数过小不判定（避免冷启动误报）
      if (total >= 10 && (errors * 100) / total > CONFIG.monitor.errorRatePct) {
        await this._alert(
          "R5-ERROR-RATE",
          `最近 ${CONFIG.monitor.errorWindowSec}s 调用失败率 ${((errors * 100) / total).toFixed(1)}%（${errors}/${total}，阈值 ${CONFIG.monitor.errorRatePct}%）`
        );
      }
    } catch (e) {
      logRun("monitor", "error", `R5: ${e.message}`);
    }
  }

  /**
   * 事件实时规则（由 indexer 事件回调调用）
   * @param {string} name 事件名
   * @param {object} args 事件参数（toObject）
   */
  async onEvent(name, args) {
    try {
      // ---- R2 大额卖出：Sold(user, zytIn, usdtOut) ----
      if (name === "Sold") {
        const usdtOut = BigInt(args.usdtOut || 0);
        if (usdtOut > 0n && this.lastPoolUsdt !== null && this.lastPoolUsdt > 0n) {
          const pct = (usdtOut * 10000n) / this.lastPoolUsdt;
          const threshold = BigInt(Math.round(CONFIG.monitor.bigSellPct * 100));
          if (pct > threshold) {
            await this._alert(
              "R2-BIG-SELL",
              `大额卖出 ${formatEther(usdtOut)} U = 底池 ${Number(pct) / 100}%（阈值 ${CONFIG.monitor.bigSellPct}%），用户 ${(args.user || "").toString().slice(0, 10)}`
            );
          }
        }
      }
    } catch (e) {
      logRun("monitor", "error", `onEvent ${name}: ${e.message}`);
    }
  }
}
