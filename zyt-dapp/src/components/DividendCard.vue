<template>
  <div class="panel dividend-card">
    <div class="panel-title">
      <span>{{ $t("home.dividendTitle") }}</span>
      <span class="tag">{{ $t("home.dividendDaily") }}</span>
    </div>
    <div class="dv-num">
      <span class="big">{{ pendingFmt }}</span>
      <span class="unit">ZYT</span>
    </div>
    <!-- v9.1：可结算 / 今日待结算（合约按日隔离，点击提取即结算入账） -->
    <div v-if="settleableNum > 0" class="dv-sub">
      {{ $t("home.dividendSettleable", { n: fmtZyt(props.settleable) }) }}
    </div>
    <div v-if="todayNum > 0" class="dv-sub muted">
      {{ $t("home.dividendTodayPending", { n: fmtZyt(props.todayAccrual) }) }}
    </div>
    <div class="dv-note">{{ $t("home.dividendNote") }}</div>
    <van-button
      block
      type="primary"
      :disabled="!canClaim"
      :loading="busy"
      class="action-btn"
      @click="doClaim"
    >
      {{ busy ? $t("home.dividendClaiming") : claimLabel }}
    </van-button>
    <div v-if="lastTx" class="tx-result" :class="lastTx.status">
      <span>{{ lastTx.status === "success" ? $t("records.success") : $t("records.failed") }}</span>
      <a v-if="lastTx.hash" :href="explorerTx(lastTx.hash)" target="_blank" rel="noreferrer">
        {{ shortHash(lastTx.hash) }}
      </a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { showFailToast, showSuccessToast } from "vant";
import { useI18n } from "vue-i18n";
import { useWallet } from "../composables/useWallet";
import { getContracts, setSigner } from "../composables/useContracts";
import { useTxRecords, newTxId } from "../composables/useTxRecords";
import { currentChain } from "../config";

/**
 * 每日分红卡：池内每日 1% 按当日算力独立结算，累计在合约内，由用户自行提取。
 * 三个阶段均可提取（阶段 1 用户无 ZYT，分红是其持币的正当来源）。
 */
const props = defineProps<{
  /** 可提取分红（ZYT，human）；未加载时传空串 */
  pending: string;
  /** v9.1：游标至昨日的可结算份额（点击提取即结算入账，human） */
  settleable?: string;
  /** v9.1：今日份额（次日之后才可结算，human） */
  todayAccrual?: string;
  /** 数据是否已加载（未加载显示 --，不以 0 冒充） */
  loaded?: boolean;
}>();

const emit = defineEmits<{ (e: "refresh"): void }>();

const { t } = useI18n();
const { address, getSigner } = useWallet();
const { upsert } = useTxRecords();

const busy = ref(false);
const lastTx = ref<{ status: string; hash?: string } | null>(null);

const pendingNum = computed(() => parseFloat(props.pending) || 0);
const settleableNum = computed(() => parseFloat(props.settleable || "0") || 0);
const todayNum = computed(() => parseFloat(props.todayAccrual || "0") || 0);
// 可点击条件：有可提取余额，或存在待结算份额（合约 claimDividend 会先惰性结算再提取）
const canClaim = computed(
  () => !!address.value && (pendingNum.value > 0 || settleableNum.value > 0) && !busy.value
);
const claimLabel = computed(() =>
  pendingNum.value > 0 ? t("home.dividendClaim") : t("home.dividendSettleClaim")
);
/** 压缩显示 ZYT（亿/万/原值） */
function fmtZyt(v?: string): string {
  const n = parseFloat(v || "0") || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(2) + "万";
  return n.toFixed(2);
}
const pendingFmt = computed(() => {
  if (props.pending === "") return "--";
  const v = pendingNum.value;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return v.toFixed(4);
});

async function doClaim() {
  const id = newTxId();
  busy.value = true;
  lastTx.value = null;
  try {
    setSigner(await getSigner());
    const { mining } = getContracts(true);
    const tx = await mining.claimDividend();
    upsert(address.value, { id, type: "dividend", status: "pending", time: Date.now(), hash: tx.hash });
    await tx.wait();
    upsert(address.value, {
      id,
      type: "dividend",
      status: "success",
      time: Date.now(),
      receive: `${pendingFmt.value} ZYT`,
      hash: tx.hash,
    });
    lastTx.value = { status: "success", hash: tx.hash };
    showSuccessToast(t("home.dividendClaimed"));
    emit("refresh");
  } catch (e: any) {
    if (e?.code !== 4001) {
      upsert(address.value, { id, type: "dividend", status: "fail", time: Date.now() });
    }
    lastTx.value = { status: "fail" };
    showFailToast(e?.shortMessage || e?.message || "FAIL");
  } finally {
    busy.value = false;
  }
}

function shortHash(h: string): string {
  return `${h.slice(0, 10)}...${h.slice(-8)}`;
}
function explorerTx(h: string): string {
  const base = currentChain().chainId === 97 ? "https://testnet.bscscan.com" : "https://bscscan.com";
  return `${base}/tx/${h}`;
}
</script>

<style scoped lang="scss">
.dividend-card {
  .panel-title {
    display: flex;
    justify-content: space-between;
    align-items: center;
    .tag {
      font-size: 11px;
      color: var(--gold);
      border: 1px solid rgba(245, 193, 93, 0.4);
      border-radius: 10px;
      padding: 1px 8px;
    }
  }
  .dv-num {
    display: flex;
    align-items: baseline;
    gap: 4px;
    margin: 6px 0 2px;
    .big {
      font-size: 26px;
      font-weight: 700;
      color: var(--gold);
    }
    .unit {
      font-size: 13px;
      color: var(--text-secondary);
    }
  }
  .dv-sub {
    font-size: 12px;
    color: var(--gold);
    margin-top: 2px;
    &.muted {
      color: var(--text-secondary);
    }
  }
  .dv-note {
    font-size: 11px;
    color: var(--text-tertiary);
    line-height: 1.5;
    margin-bottom: 10px;
  }
  .action-btn {
    border-radius: 10px;
    height: 44px;
    font-size: 15px;
  }
  .tx-result {
    margin-top: 8px;
    font-size: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    &.success {
      color: #2ecc71;
    }
    &.fail {
      color: #e05b5b;
    }
    a {
      color: inherit;
      text-decoration: underline;
      word-break: break-all;
    }
  }
}
</style>
