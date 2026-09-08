<template>
  <div class="records">
    <WalletHeader />
    <div class="panel">
      <div class="panel-title-row">
        <span class="panel-title">{{ $t("records.title") }}</span>
        <van-button v-if="loading" size="mini" loading />
        <van-button v-else size="mini" icon="replay" @click="reload">
          {{ $t("records.retry") }}
        </van-button>
      </div>

      <!-- 链上记录加载失败提示（本地记录仍展示） -->
      <div v-if="loadError" class="err-tip" @click="reload">
        {{ $t("records.loadFail") }} <span class="retry-link">{{ $t("records.retry") }}</span>
      </div>

      <van-empty v-if="rows.length === 0 && !loading && !loadError" :description="$t('records.empty')" />

      <template v-else>
        <div v-for="(r, i) in rows" :key="i" class="rec-item" :class="r.status">
          <div class="rec-head">
            <span class="rec-type">{{ typeText(r.type) }}</span>
            <span class="rec-status" :class="r.status">{{ statusText(r.status) }}</span>
          </div>
          <div class="rec-body">
            <template v-if="r.spend"><div class="rec-line"><span>{{ $t("records.spend") }}</span><b>{{ r.spend }}</b></div></template>
            <template v-if="r.receive"><div class="rec-line"><span>{{ $t("records.receive") }}</span><b>{{ r.receive }}</b></div></template>
            <template v-if="r.detail"><div class="rec-line"><span></span><em>{{ r.detail }}</em></div></template>
          </div>
          <div class="rec-foot">
            <span>{{ fmtTime(r.time) }}</span>
            <a
              v-if="r.hash"
              :href="explorerTx(r.hash)"
              target="_blank"
              rel="noreferrer"
              class="hash-link"
            >
              {{ shortHash(r.hash) }}
            </a>
            <span v-else-if="r.block" class="hash-link">{{ $t("records.block") }} #{{ r.block }}</span>
            <span v-else class="hash-link">-</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import WalletHeader from "../components/WalletHeader.vue";
import { useWallet } from "../composables/useWallet";
import { useTxRecords, type TxRecord, type TxType, type TxStatus } from "../composables/useTxRecords";
import { useKeeperApi } from "../composables/useKeeperApi";
import { currentChain } from "../config";

const { t } = useI18n();
const { address } = useWallet();
const { load } = useTxRecords();
const api = useKeeperApi();

/** 行：本地记录 ∪ 链上事件（无 hash 时用 block） */
interface Row {
  type: string;
  status: string;
  spend?: string;
  receive?: string;
  detail?: string;
  hash?: string;
  time: number;
  block?: number;
  from?: string;
}

const loading = ref(false);
const loadError = ref(false);
const rows = ref<Row[]>([]);

/** 链上事件名 → 本地类型（模糊匹配 abis 事件名） */
function mapEventName(name: string): TxType | string {
  const n = name.toLowerCase();
  if (n.includes("liquid")) return "addLiquidity";
  if (n.includes("approv")) return "approve";
  if (n.includes("deposit")) return "deposit";
  if (n.includes("sell") || n.includes("sold")) return "sell";
  if (n.includes("reward")) return "reward";
  if (n.includes("dividend")) return "dividend";
  if (n.includes("refer")) return "refReward";
  if (n.includes("transfer")) return "transfer";
  return name;
}

async function loadRecords() {
  if (!address.value) {
    rows.value = [];
    return;
  }
  loading.value = true;
  loadError.value = false;
  // 1) 本地持久化记录（授权/失败/处理中全覆盖，含 hash）
  const local: Row[] = load(address.value).map((r) => ({ ...r }));
  // 2) 链上历史事件（keeper /records，补充多设备/历史操作）
  try {
    const evs = await api.records(address.value);
    const fromChain: Row[] = (evs || []).map((e) => ({
      type: mapEventName(e.name),
      spend: e.amount ? `${e.amount} (${e.from_addr === address.value?.toLowerCase() ? "out" : "in"})` : undefined,
      time: 0,
      block: e.block,
      hash: e.hash,
      status: "success" as TxStatus,
      detail: e.extra || undefined,
    }));
    rows.value = [...fromChain, ...local];  } catch {
    loadError.value = true;
    rows.value = local;
  } finally {
    loading.value = false;
  }
}

function reload() {
  loadRecords();
}

function typeText(type: string): string {
  const map: Record<string, string> = {
    approve: t("records.approve"),
    addLiquidity: t("records.addLiquidity"),
    deposit: t("records.deposit"),
    sell: t("records.sell"),
    reward: t("records.reward"),
    dividend: t("records.dividend"),
    refReward: t("records.refReward"),
    forceSell: t("records.forceSell"),
    burn: t("records.burn"),
    transfer: t("records.transfer"),
  };
  return map[type] || type;
}
function statusText(s: string): string {
  return s === "success" ? t("records.success") : s === "pending" ? t("records.pending") : s === "fail" ? t("records.failed") : s;
}
function fmtTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function shortHash(h: string): string {
  return `${h.slice(0, 8)}...${h.slice(-6)}`;
}
function explorerTx(h: string): string {
  const chainId = currentChain().chainId;
  const base = chainId === 97 ? "https://testnet.bscscan.com" : "https://bscscan.com";
  return `${base}/tx/${h}`;
}

watch(address, () => loadRecords());
onMounted(() => {
  if (address.value) loadRecords();
});
</script>

<style scoped lang="scss">
.records {
  padding-bottom: 20px;
}
.panel-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
  .panel-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
  }
}
.err-tip {
  background: rgba(224, 91, 91, 0.1);
  border: 1px solid rgba(224, 91, 91, 0.3);
  color: #e05b5b;
  font-size: 12px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  margin: 6px 2px;
  cursor: pointer;
  .retry-link {
    text-decoration: underline;
  }
}
.rec-item {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin: 8px 2px;
  &.pending {
    border-color: rgba(245, 193, 93, 0.4);
  }
  &.fail {
    border-color: rgba(224, 91, 91, 0.4);
  }
  .rec-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    .rec-type {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .rec-status {
      font-size: 11px;
      &.success {
        color: #2ecc71;
      }
      &.pending {
        color: var(--gold);
      }
      &.fail {
        color: #e05b5b;
      }
    }
  }
  .rec-body {
    margin-top: 6px;
    .rec-line {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-secondary);
      padding: 2px 0;
      b {
        color: var(--text-primary);
        font-weight: 600;
      }
      em {
        color: var(--text-tertiary);
        font-style: normal;
        font-size: 11px;
        text-align: right;
      }
    }
  }
  .rec-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-tertiary);
    .hash-link {
      color: var(--gold);
      text-decoration: none;
      word-break: break-all;
      &:hover {
        text-decoration: underline;
      }
    }
  }
}
</style>
