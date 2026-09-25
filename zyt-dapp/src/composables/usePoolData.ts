import { ref, computed, watch } from "vue";
import { formatEther } from "ethers";
import { useWallet } from "./useWallet";
import { getContracts, getCreatorContract } from "./useContracts";
import { useKeeperApi, KeeperForceSell } from "./useKeeperApi";
import { currentChain } from "../config";

export interface PoolStats {
  // v9 真池口径：poolGST/snapshotGST 已废弃；peakPoolUSDT = 滑点档位基准（max(初始, 历史峰值)）
  poolZYT: string;
  poolUSDT: string;
  peakPoolUSDT: string;
  price: string;
  stage: number;
  slippage: number;
  // v9：分红池（ZYT）与累计销毁 LP（入金 60% 凭证）
  dividendPoolZyt?: string;
  totalLpBurned?: string;
  // v14：keeper /stats 统计扩展（wei 字符串；链上直连降级分支无此数据 → 空 = 前端显示 --）
  burned?: string;
  todayDeposit?: string;
  networkPower?: string;
  // v9：锁仓合约累计（Creator 未接线时为空字符串，展示层显示 --）
  creatorUsdtIn?: string; // 初始底池 USDT（2.1 万）
  creatorZytIn?: string; // 初始底池 ZYT（21 亿）
  lpLocked?: string; // 当前锁仓 LP 凭证量
}

/** v17：分红状态（每日按算力结算，累计在合约内，用户自行提取） */
export interface DividendStats {
  /** 可提取分红（ZYT，human，链上 pendingDividend） */
  pending: string;
  /** 已结算到的日（不含该日） */
  settledDay: number;
  /** v9.1：游标至昨日的可结算份额（点击提取即入账，human） */
  settleable?: string;
  /** v9.1：今日份额（次日之后可结算，human） */
  todayAccrual?: string;
}

export interface UserStats {
  depositTotal: string;
  withdrawTotal: string;
  power: string;
  /** v9：动态额度（加速释放）：quota=入金×5，withdrawn=推荐奖励已消耗 */
  dynamicQuota?: string;
  dynamicWithdrawn?: string;
  /** v9：剩余买额（阶段 2 用，入金 1:1） */
  buyQuotaLeft?: string;
  /** v9.1：静态出局线（= depositTotal×2 + 受赠，transferValueOf[1]） */
  withdrawCap?: string;
  /** v9：动态出局（额度耗尽；复投解除） */
  dynamicExited?: boolean;
  isExited: boolean;
}

const poolStats = ref<PoolStats>({
  poolZYT: "0",
  poolUSDT: "0",
  peakPoolUSDT: "0",
  price: "0",
  stage: 0,
  slippage: 5,
});
const userStats = ref<UserStats | null>(null);
const forceSellStats = ref<KeeperForceSell | null>(null);
const dividendStats = ref<DividendStats | null>(null);
const loading = ref(false);
// v13：加载状态与错误态。数据未成功前页面展示占位，禁止用初始 0 冒充真实数据
const loaded = ref(false);
const error = ref("");
// 数据源标记（调试/诊断用）：api=走 keeper API；chain=降级合约直连
const source = ref<"api" | "chain">("chain");

/**
 * v9：锁仓合约累计数据归一为 human 数值（展示层直接显示）。
 * keeper 未接线 Creator 时返回空对象，字段保持 undefined，展示层显示 --。
 */
function pickCreator(c?: {
  totalUsdtSeeded?: string;
  totalZytSeeded?: string;
  lockedLiquidity?: string;
} | null): Pick<PoolStats, "creatorUsdtIn" | "creatorZytIn" | "lpLocked"> {
  if (!c) return {};
  // 2026-09-25：统一 wei → human（原实现直接透传 wei，前端显示 2.1e+22 量纲错误）
  const eth = (v?: string) => {
    if (!v) return undefined;
    try {
      return formatEther(BigInt(v));
    } catch {
      return undefined;
    }
  };
  return {
    creatorUsdtIn: eth(c.totalUsdtSeeded),
    creatorZytIn: eth(c.totalZytSeeded),
    lpLocked: eth(c.lockedLiquidity),
  };
}

/** v9：链上直连读锁仓合约累计（未接线或调用失败一律返回空对象，不阻塞主流程） */
async function readCreatorOnChain(): Promise<Pick<PoolStats, "creatorUsdtIn" | "creatorZytIn" | "lpLocked">> {
  const c = getCreatorContract();
  if (!c) return {};
  try {
    const [usdtSeeded, zytSeeded, locked] = await Promise.all([
      c.totalUsdtSeeded(),
      c.totalZytSeeded(),
      c.lockedLiquidity(),
    ]);
    return {
      creatorUsdtIn: formatEther(usdtSeeded),
      creatorZytIn: formatEther(zytSeeded),
      lpLocked: formatEther(locked),
    };
  } catch {
    return {};
  }
}

export function usePoolData() {
  const { address } = useWallet();
  const chain = currentChain();
  const api = useKeeperApi();

  const slippageLabel = computed(() => {
    const s = poolStats.value.slippage;
    return `${s}%`; // v13：slippage 语义为百分数（5 = 5%），修掉此前 s/100 显示 0.05% 的错误
  });

  /** 轮询刷新数据：优先 keeper API（省 90% RPC），失败降级合约直连 */
  async function refresh() {
    try {
      loading.value = true;
      error.value = "";
      const apiPool = await api.stats();
      if (apiPool?.pool) {
        // ===== 走 keeper API（链下聚合数据） =====
        // v9：pool_state 遗留列复用口径 —— pool_gst 恒 0；snapshot_gst 存峰值基准；
        //     day_sold_gst 存分红池 ZYT；snapshot_pool_usdt 为当日快照 U
        source.value = "api";
        const p = apiPool.pool;
        poolStats.value = {
          poolZYT: formatEther(BigInt(p.pool_zyt || "0")),
          poolUSDT: formatEther(BigInt(p.pool_usdt || "0")),
          peakPoolUSDT: formatEther(BigInt(p.snapshot_gst || "0")),
          price: formatEther(BigInt(p.price || "0")),
          stage: Number(p.stage || 0),
          slippage: Number(p.slippage_pct ?? 5), // keeper 返回百分数（5 = 5%）
          dividendPoolZyt: formatEther(BigInt(p.day_sold_gst || "0")),
          burned: apiPool.burned,
          // v9.1：累计销毁 LP（keeper 链上直读 pool.totalLpBurned，wei → human）
          totalLpBurned: apiPool.lpBurned ? formatEther(BigInt(apiPool.lpBurned)) : "",
          todayDeposit: apiPool.todayDeposit,
          networkPower: apiPool.networkPower,
          ...pickCreator(apiPool.creator),
        };
        loaded.value = true;
      } else {
        // ===== 降级：合约直连（v13：走公共只读 RPC，无需钱包连接） =====
        source.value = "chain";
        const { pool } = getContracts(false);
        const [zytRes, usdtRes, peak, price, stage, slip, divPool, lpBurned] = await Promise.all([
          pool.poolZYT(),
          pool.poolUSDT(),
          pool.peakPoolUSDT(),
          pool.getTradePrice(), // 当日 08:01 快照锁定价（记账口径）
          pool.getStage(),
          pool.getCurrentSlippage(),
          pool.dividendPoolZyt(),
          pool.totalLpBurned(),
        ]);
        poolStats.value = {
          poolZYT: formatEther(zytRes),
          poolUSDT: formatEther(usdtRes),
          peakPoolUSDT: formatEther(peak),
          price: formatEther(price),
          stage: Number(stage),
          slippage: Number(slip) / 100, // 链上返回基点（500 = 5%），折成百分数
          dividendPoolZyt: formatEther(divPool),
          totalLpBurned: formatEther(lpBurned),
          ...(await readCreatorOnChain()),
        };
        loaded.value = true;
      }

      if (address.value) {
        // 用户账本（API 优先）
        const apiUser = await api.user(address.value);
        if (apiUser && apiUser.deposit_total !== undefined) {
          userStats.value = {
            depositTotal: formatEther(BigInt(apiUser.deposit_total || "0")),
            withdrawTotal: formatEther(BigInt(apiUser.withdraw_total || "0")),
            power: formatEther(BigInt(apiUser.power || "0")),
            dynamicQuota: formatEther(BigInt(apiUser.dynamic_quota || "0")),
            dynamicWithdrawn: formatEther(BigInt(apiUser.dynamic_withdrawn || "0")),
            // 2026-09-24：keeper /user 补充链上买入额度（userInfo[5]，wei 字符串）
            buyQuotaLeft: apiUser.buy_quota_left ? formatEther(BigInt(apiUser.buy_quota_left)) : "0",
            // v9.1：静态出局线（transferValueOf[1]）
            withdrawCap: apiUser.withdraw_cap ? formatEther(BigInt(apiUser.withdraw_cap)) : "0",
            isExited: !!apiUser.is_exited,
          };
        } else {
          const { mining } = getContracts(false);
          const info = await mining.userInfo(address.value);
          // v9 用户口径 8 元组：(depositTotal, withdrawTotal, power, dynamicQuota, dynamicWithdrawn, buyQuotaLeft, staticExited, dynamicExited)
          // v9.1：出局线 withdrawCap = depositTotal×2 + 受赠（transferValueOf[1]）
          const tv = await mining.transferValueOf(address.value).catch(() => null);
          userStats.value = {
            depositTotal: formatEther(info[0]),
            withdrawTotal: formatEther(info[1]),
            power: formatEther(info[2]),
            dynamicQuota: formatEther(info[3]),
            dynamicWithdrawn: formatEther(info[4]),
            buyQuotaLeft: formatEther(info[5]),
            withdrawCap: tv ? formatEther(tv[1]) : "0",
            isExited: info[6],
            dynamicExited: info[7],
          };
        }
        // 强制卖出窗口状态（#7 追踪数据；失败置空，不阻塞主流程）
        forceSellStats.value = await api.forceSell(address.value);
        // 分红：可提取从链上读；可结算/今日份额优先用 keeper 预估（链下同公式预演），失败则仅展示链上值
        try {
          const { mining } = getContracts(false);
          const [dv, apiDiv] = await Promise.all([
            mining.dividendOf(address.value),
            api.dividend(address.value),
          ]);
          dividendStats.value = {
            pending: formatEther(dv[0]),
            settledDay: Number(dv[1]),
            settleable: apiDiv?.settleable ? formatEther(BigInt(apiDiv.settleable)) : undefined,
            todayAccrual: apiDiv?.todayAccrual ? formatEther(BigInt(apiDiv.todayAccrual)) : undefined,
          };
        } catch {
          dividendStats.value = null;
        }
      } else {
        userStats.value = null;
        forceSellStats.value = null;
        dividendStats.value = null;
      }
    } catch (e) {
      console.warn("refresh pool failed", e);
      error.value = "network"; // 网络/合约配置错误；UI 显示提示而非 0
    } finally {
      loading.value = false;
    }
  }

  // v13：钱包连接/切换成功后立即刷新（消除 HomeView 挂载时钱包恢复未完成的时序竞态）
  watch(address, (a) => {
    if (a) refresh();
  });

  /** 压缩显示大数（21亿 → 21.0亿） */
  function fmtCompact(n: string, digits = 2): string {
    const v = parseFloat(n);
    if (isNaN(v)) return "0";
    const abs = Math.abs(v);
    if (abs >= 1e8) return (v / 1e8).toFixed(digits) + "亿";
    if (abs >= 1e4) return (v / 1e4).toFixed(digits) + "万";
    return v.toFixed(digits > 4 ? 4 : digits);
  }

  function fmtNum(n: string, digits = 4): string {
    const v = parseFloat(n);
    if (isNaN(v)) return "0";
    if (v >= 1000) return v.toFixed(2);
    return v.toFixed(digits);
  }

  return {
    chain,
    poolStats,
    userStats,
    forceSellStats,
    dividendStats,
    loading,
    loaded,
    error,
    source,
    slippageLabel,
    refresh,
    fmtCompact,
    fmtNum,
  };
}
