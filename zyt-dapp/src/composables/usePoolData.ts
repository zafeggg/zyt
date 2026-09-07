import { ref, computed, watch } from "vue";
import { formatEther } from "ethers";
import { useWallet } from "./useWallet";
import { getContracts } from "./useContracts";
import { useKeeperApi, KeeperForceSell } from "./useKeeperApi";
import { currentChain } from "../config";

export interface PoolStats {
  poolGST: string;
  poolZYT: string;
  poolUSDT: string;
  snapshotGST: string;
  price: string;
  stage: number;
  slippage: number;
}

export interface UserStats {
  depositTotal: string;
  withdrawTotal: string;
  dynamicQuota: string;
  dynamicWithdrawn: string;
  power: string;
  lpQuota: string;
  isExited: boolean;
}

const poolStats = ref<PoolStats>({
  poolGST: "0",
  poolZYT: "0",
  poolUSDT: "0",
  snapshotGST: "0",
  price: "0",
  stage: 0,
  slippage: 5,
});
const userStats = ref<UserStats | null>(null);
const forceSellStats = ref<KeeperForceSell | null>(null);
const loading = ref(false);
// v13：加载状态与错误态。数据未成功前页面展示占位，禁止用初始 0 冒充真实数据
const loaded = ref(false);
const error = ref("");
// 数据源标记（调试/诊断用）：api=走 keeper API；chain=降级合约直连
const source = ref<"api" | "chain">("chain");

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
        source.value = "api";
        const p = apiPool.pool;
        poolStats.value = {
          poolGST: formatEther(BigInt(p.pool_gst || "0")),
          poolZYT: formatEther(BigInt(p.pool_zyt || "0")),
          poolUSDT: formatEther(BigInt(p.pool_usdt || "0")),
          snapshotGST: formatEther(BigInt(p.snapshot_gst || "0")),
          price: formatEther(BigInt(p.price || "0")),
          stage: Number(p.stage || 0),
          slippage: Number(p.slippage_pct ?? 5), // keeper 返回百分数（5 = 5%）
        };
        loaded.value = true;
      } else {
        // ===== 降级：合约直连（v13：走公共只读 RPC，无需钱包连接） =====
        source.value = "chain";
        const { pool } = getContracts(false);
        const [gst, zyt, usdt, snapshot, price, stage, slip] = await Promise.all([
          pool.poolGST(),
          pool.poolZYT(),
          pool.poolUSDT(),
          pool.snapshotPoolGST(),
          pool.getTradePrice(), // v7：当日快照锁定价（交易实际计价）
          pool.getStage(),
          pool.getCurrentSlippage(),
        ]);
        poolStats.value = {
          poolGST: formatEther(gst),
          poolZYT: formatEther(zyt),
          poolUSDT: formatEther(usdt),
          snapshotGST: formatEther(snapshot),
          price: formatEther(price),
          stage: Number(stage),
          slippage: Number(slip) / 100, // 链上返回基点（500 = 5%），折成百分数
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
            dynamicQuota: formatEther(BigInt(apiUser.dynamic_quota || "0")),
            dynamicWithdrawn: formatEther(BigInt(apiUser.dynamic_withdrawn || "0")),
            power: formatEther(BigInt(apiUser.power || "0")),
            lpQuota: "0", // 链下账本未建模 LP 额度，展示从链上为准
            isExited: !!apiUser.is_exited,
          };
        } else {
          const { mining } = getContracts(false);
          const info = await mining.userInfo(address.value);
          userStats.value = {
            depositTotal: formatEther(info[0]),
            withdrawTotal: formatEther(info[1]),
            dynamicQuota: formatEther(info[2]),
            dynamicWithdrawn: formatEther(info[3]),
            power: formatEther(info[4]),
            lpQuota: formatEther(info[5]),
            isExited: info[6],
          };
        }
        // 强制卖出窗口状态（#7 追踪数据；失败置空，不阻塞主流程）
        forceSellStats.value = await api.forceSell(address.value);
      } else {
        userStats.value = null;
        forceSellStats.value = null;
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
