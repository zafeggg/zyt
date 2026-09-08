<template>
  <div class="panel swap-panel">
    <div class="panel-title">
      <span>{{ $t("swap.title") }}</span>
      <SlippageBadge :slippage="slippage" />
    </div>

    <!-- 模式切换：卖出 / 入金（v7：非白名单用户禁用入金） -->
    <van-tabs v-model:active="mode" class="mode-tabs" color="#f5c15d" @change="resetFlow">
      <van-tab :title="$t('swap.sell')" name="sell" />
      <van-tab :title="$t('swap.buy')" name="buy" :disabled="isWhitelisted === false" />
    </van-tabs>

    <div v-if="isWhitelisted === false" class="wl-tip">{{ $t("swap.whitelistTip") }}</div>

    <!-- 金额输入 -->
    <div class="input-row">
      <div class="input-box">
        <input
          v-model="amount"
          type="text"
          inputmode="decimal"
          :placeholder="$t('swap.amountPlaceholder')"
          @input="resetFlow"
        />
        <div class="pct-btns">
          <span v-for="p in [20, 50, 70]" :key="p" class="pct" @click="setPct(p)">{{ p }}%</span>
          <span class="pct max" @click="setPct(100)">{{ $t("swap.max") }}</span>
        </div>
      </div>
      <!-- v14：币种随模式锁定（sell=ZYT / buy=USDT），移除误导性选择器：
           入金仅 USDT、卖出仅 ZYT 是合约冻结规则，tokenSymbol 此前只控制余额显示造成语义错位 -->
      <div class="token-btn" :style="{ cursor: 'default' }">
        <span class="dot" :style="{ background: tokenColor }" />
        {{ tokenSymbol }}
      </div>
    </div>

    <div class="meta">
      <span>{{ $t("common.balance") }}: {{ balance }}</span>
      <span v-if="mode === 'sell'" class="sliptip">
        {{ $t("swap.slippageTip", { rate: slippage, pct: reductionPct }) }}
      </span>
    </div>

    <!-- ===== v13：buy 总额明细面板（授权/加池/入金分步透明化） ===== -->
    <template v-if="mode === 'buy' && isWhitelisted !== false && amountNum > 0">
      <div class="flow-panel">
        <div class="flow-title">{{ $t("swap.flowTitle") }}</div>
        <div class="flow-row"><span>{{ $t("swap.flowDeposit") }}</span><b>{{ fmtNum(amountNum) }} USDT</b></div>
        <div v-if="needLpNum > 0" class="flow-row">
          <span>{{ $t("swap.flowLp") }}</span><b>{{ fmtNum(needLpNum) }} USDT</b>
        </div>
        <div class="flow-row total">
          <span>{{ $t("swap.flowTotal") }}</span><b>{{ fmtNum(amountNum + needLpNum) }} USDT</b>
        </div>
        <div class="flow-row sub">
          <span>{{ $t("swap.flowTxCount") }}</span><b>{{ needLpNum > 0 ? 2 : 1 }} {{ $t("swap.flowTxs") }}</b>
        </div>
        <div class="flow-note">{{ $t("swap.flowGasNote") }}</div>
        <!-- v13：LP 用途与不可赎回说明（诚实披露，防"重复扣款"误解） -->
        <div v-if="needLpNum > 0" class="flow-note lp-note">{{ $t("swap.lpExplain") }}</div>
        <div v-if="balanceErr" class="flow-err">
          {{ $t("swap.insufficientBalance", { need: fmtNum(amountNum + needLpNum), bal: balance }) }}
        </div>
        <!-- 授权状态与目标合约 -->
        <div class="auth-row">
          <span>{{ $t("swap.approveStatus") }}：</span>
          <b :class="approved ? 'ok' : 'no'">{{ approved ? $t("swap.approved") : $t("swap.notApproved") }}</b>
          <template v-if="approved">
            <span class="auth-sub">{{ $t("swap.approveTarget") }}：{{ miningAddrShort }}</span>
          </template>
        </div>
      </div>

      <!-- v13：分步主按钮（授权 → 加池 → 入金，任一失败不连锁下一步） -->
      <van-button
        v-if="!approved && !busy"
        block
        type="primary"
        :disabled="!walletReady || balanceErr"
        class="action-btn"
        @click="doApprove"
      >
        {{ $t("swap.approveAction") }}
      </van-button>
      <van-button v-if="busy === 'approve'" block type="primary" loading class="action-btn">
        {{ $t("swap.approving") }}
      </van-button>
      <van-button
        v-if="approved && needLpNum > 0 && busy !== 'lp'"
        block
        type="warning"
        :disabled="!walletReady || balanceErr || busy !== ''"
        class="action-btn lp-btn"
        @click="doAddLiquidity"
      >
        {{ $t("swap.addLiquidityAction", { amt: fmtNum(needLpNum) }) }}
      </van-button>
      <van-button v-if="busy === 'lp'" block type="warning" loading class="action-btn lp-btn">
        {{ $t("swap.lpDoing") }}
      </van-button>
      <van-button
        v-if="approved && needLpNum === 0 && busy !== 'deposit'"
        block
        type="primary"
        :disabled="!walletReady || balanceErr || busy !== ''"
        class="action-btn"
        @click="doDeposit"
      >
        {{ $t("swap.depositAction") }}
      </van-button>
      <van-button v-if="busy === 'deposit'" block type="primary" loading class="action-btn">
        {{ $t("swap.depositing") }}
      </van-button>
    </template>

    <!-- ===== v13：sell 两步（授权 ZYT → 确认卖出） ===== -->
    <template v-else-if="mode === 'sell' && amountNum > 0">
      <div class="flow-panel">
        <div class="flow-row"><span>{{ $t("swap.sellAmount") }}</span><b>{{ fmtNum(amountNum) }} ZYT</b></div>
        <div class="flow-row sub">{{ $t("swap.sellNote", { rate: slippage, pct: reductionPct }) }}</div>
        <div v-if="balanceErr" class="flow-err">{{ $t("swap.insufficientBalance", { need: fmtNum(amountNum), bal: balance }) }}</div>
        <div class="auth-row">
          <span>{{ $t("swap.approveStatus") }}：</span>
          <b :class="zytApproved ? 'ok' : 'no'">{{ zytApproved ? $t("swap.approved") : $t("swap.notApproved") }}</b>
        </div>
      </div>
      <van-button
        v-if="!zytApproved && busy !== 'zytApprove'"
        block
        type="primary"
        :disabled="!walletReady || balanceErr"
        class="action-btn"
        @click="doApproveZyt"
      >
        {{ $t("swap.approveZytAction") }}
      </van-button>
      <van-button v-if="busy === 'zytApprove'" block type="primary" loading class="action-btn">
        {{ $t("swap.approving") }}
      </van-button>
      <van-button
        v-if="zytApproved && busy !== 'sell'"
        block
        type="primary"
        :disabled="!walletReady || balanceErr || busy !== ''"
        class="action-btn"
        @click="doSell"
      >
        {{ $t("swap.sellAction") }}
      </van-button>
      <van-button v-if="busy === 'sell'" block type="primary" loading class="action-btn">
        {{ $t("swap.selling") }}
      </van-button>
    </template>

    <!-- 最近交易结果行（v13：分步交易状态与哈希） -->
    <div v-if="lastTx" class="tx-result" :class="lastTx.status">
      <span>{{ typeText(lastTx.type) }}：{{ statusText(lastTx.status) }}</span>
      <a v-if="lastTx.hash" :href="explorerTx(lastTx.hash)" target="_blank" rel="noreferrer">
        {{ shortHash(lastTx.hash) }}
      </a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { parseEther, formatEther } from "ethers";
import { showFailToast } from "vant";
import { useI18n } from "vue-i18n";
import SlippageBadge from "./SlippageBadge.vue";
import { useWallet } from "../composables/useWallet";
import { getContracts, setSigner } from "../composables/useContracts";
import { useTxRecords, newTxId, type TxRecord, type TxType, type TxStatus } from "../composables/useTxRecords";
import { currentChain } from "../config";

const props = defineProps<{
  slippage: number;
  reductionPct: string;
  refresh: () => Promise<void>;
}>();

const { t } = useI18n();
const { address, getSigner } = useWallet();
const { upsert } = useTxRecords();

const mode = ref<"sell" | "buy">("sell");
// v14：币种随模式锁定（冻结规则：卖出=ZYT / 入金=USDT），仅作余额显示与金额标签
const tokenSymbol = computed(() => (mode.value === "sell" ? "ZYT" : "USDT"));
const tokenColor = computed(() => (tokenSymbol.value === "ZYT" ? "#f5c15d" : "#26a17b"));
const amount = ref("");
const balance = ref("0");

const walletReady = computed(() => !!address.value);
const amountNum = computed(() => parseFloat(amount.value) || 0);
const balanceNum = computed(() => parseFloat(balance.value) || 0);

// ===== 链上状态（授权/阶段/LP 配额） =====
const isWhitelisted = ref<boolean | null>(null);
const stageRef = ref(0);
const allowanceUsdt = ref<bigint>(0n);
const allowanceZyt = ref<bigint>(0n);
const lpQuotaWei = ref<bigint>(0n);
const miningAddr = ref("");
// 流程执行中标记："" 空闲 / approve / lp / deposit / zytApprove / sell
const busy = ref<"" | "approve" | "lp" | "deposit" | "zytApprove" | "sell">("");
const lastTx = ref<{ type: TxType; status: TxStatus; hash?: string } | null>(null);

const miningAddrShort = computed(() =>
  miningAddr.value ? `${miningAddr.value.slice(0, 8)}...${miningAddr.value.slice(-6)}` : ""
);

// buy 侧派生
const amtWei = computed(() => (amountNum.value > 0 ? parseEther(String(amountNum.value)) : 0n));
const needLpWei = computed(() => {
  if (stageRef.value === 2) {
    const have = lpQuotaWei.value;
    return amtWei.value > have ? amtWei.value - have : 0n;
  }
  return 0n;
});
const needLpNum = computed(() => Number(formatEther(needLpWei.value)));
/** 授权需求 = 加池缺额 + 入金额（一次授权覆盖两笔 transferFrom） */
const approveNeedWei = computed(() => amtWei.value + needLpWei.value);
const approved = computed(() => allowanceUsdt.value >= approveNeedWei.value);
const balanceErr = computed(
  () => mode.value === "buy" ? balanceNum.value < amountNum.value + needLpNum.value
    : balanceNum.value < amountNum.value
);

// sell 侧派生
const zytApproved = computed(() => allowanceZyt.value >= amtWei.value);

// ===== 数据加载 =====
async function loadChainState() {
  if (!address.value) return;
  try {
    const { usdt, mining, pool, config } = getContracts(false);
    const miningA = await mining.getAddress();
    miningAddr.value = miningA;
    const stage = Number(await pool.getStage());
    stageRef.value = stage;
    const cfg = currentChain().contracts;
    // 授权额度
    const [au, info] = await Promise.all([
      usdt.allowance(address.value, miningA),
      stage === 2 ? mining.userInfo(address.value) : Promise.resolve(null),
    ]);
    allowanceUsdt.value = au;
    if (stage === 2 && info) lpQuotaWei.value = BigInt(info[5] ?? 0);
    else lpQuotaWei.value = 0n;
    // sell 授权（zyt → pool）
    if (mode.value === "sell") {
      const { zyt } = getContracts(false);
      const poolAddr = cfg.pool;
      allowanceZyt.value = await zyt.allowance(address.value, poolAddr);
    }
  } catch {
    /* 读失败保持现值，不阻塞 */
  }
}

async function loadWhitelist() {
  isWhitelisted.value = null;
  if (!address.value) return;
  try {
    const { pool, config } = getContracts(false);
    const enabled = await config.buyWhitelistEnabled();
    if (!enabled) {
      isWhitelisted.value = true;
      return;
    }
    isWhitelisted.value = await pool.buyWhitelist(address.value);
  } catch {
    isWhitelisted.value = true;
  }
}

async function loadBalance() {
  if (!address.value) return;
  try {
    const { zyt, usdt } = getContracts(false);
    if (tokenSymbol.value === "ZYT") {
      const bal = await zyt.balanceOf(address.value);
      balance.value = formatEther(bal);
    } else {
      const bal = await usdt.balanceOf(address.value);
      balance.value = formatEther(bal);
    }
  } catch {
    balance.value = "0";
  }
}

watch(
  address,
  async (a) => {
    if (a) {
      setSigner(await getSigner());
      resetFlow();
      await loadWhitelist();
      await Promise.all([loadChainState(), loadBalance()]);
    } else {
      isWhitelisted.value = null;
      resetFlow();
    }
  },
  { immediate: true }
);
watch(mode, async () => {
  resetFlow();
  await loadBalance();
  await loadChainState();
});
watch(amount, () => resetFlow());

function resetFlow() {
  busy.value = "";
  lastTx.value = null;
}

// ===== 交易记录与展示 helpers =====
function record(id: string, type: TxType, status: TxStatus, extra: Partial<TxRecord>) {
  upsert(address.value, { id, type, status, time: Date.now(), ...extra });
  lastTx.value = { type, status, hash: extra.hash };
}

function typeText(type: TxType): string {
  const map: Record<TxType, string> = {
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
function statusText(s: TxStatus): string {
  return s === "success" ? t("records.success") : s === "pending" ? t("records.pending") : t("records.failed");
}
function shortHash(h: string): string {
  return `${h.slice(0, 10)}...${h.slice(-8)}`;
}
function explorerTx(h: string): string {
  const chainId = currentChain().chainId;
  const base = chainId === 97 ? "https://testnet.bscscan.com" : "https://bscscan.com";
  return `${base}/tx/${h}`;
}

// ===== 操作：buy 三步 =====
async function doApprove() {
  const id = newTxId();
  busy.value = "approve";
  try {
    const { usdt, mining } = getContracts(true);
    const miningA = await mining.getAddress();
    const tx = await usdt.approve(miningA, approveNeedWei.value);
    record(id, "approve", "pending", { spend: `${Number(formatEther(approveNeedWei.value))} USDT`, hash: tx.hash });
    await tx.wait();
    record(id, "approve", "success", { spend: `${Number(formatEther(approveNeedWei.value))} USDT`, hash: tx.hash, detail: t("swap.approveTarget") + " " + miningA });
    await loadChainState();
  } catch (e: any) {
    if (e?.code !== 4001) record(id, "approve", "fail", {});
    showFailToast(e?.shortMessage || e?.message || "FAIL");
  } finally {
    busy.value = "";
  }
}

async function doAddLiquidity() {
  const id = newTxId();
  busy.value = "lp";
  try {
    const { mining } = getContracts(true);
    const need = needLpWei.value;
    if (need <= 0n) return;
    const tx = await mining.addLiquidity(need);
    record(id, "addLiquidity", "pending", { spend: `${Number(formatEther(need))} USDT`, hash: tx.hash });
    await tx.wait();
    record(id, "addLiquidity", "success", {
      spend: `${Number(formatEther(need))} USDT`,
      receive: `${Number(formatEther(need))} U ${t("records.lpQuotaUnit")}`,
      hash: tx.hash,
    });
    await loadChainState();
  } catch (e: any) {
    if (e?.code !== 4001) record(id, "addLiquidity", "fail", {});
    showFailToast(e?.shortMessage || e?.message || "FAIL");
  } finally {
    busy.value = "";
  }
}

async function doDeposit() {
  const id = newTxId();
  busy.value = "deposit";
  try {
    const { mining } = getContracts(true);
    const amt = amtWei.value;
    if (amt <= 0n) return;
    const tx = await mining.deposit(amt, refAddr());
    record(id, "deposit", "pending", { spend: `${Number(formatEther(amt))} USDT`, hash: tx.hash });
    await tx.wait();
    // 获得 ZYT 估算：按入金后池数据由上层 refresh 刷新，本地记录给出成交 ZYT 估算（快照价 * 池投入）
    record(id, "deposit", "success", {
      spend: `${Number(formatEther(amt))} USDT`,
      detail: t("records.depositDetail", { marketing: Math.round(Number(formatEther(amt)) * 0.4), pool: Math.round(Number(formatEther(amt)) * 0.6) }),
      hash: tx.hash,
    });
    amount.value = "";
    await Promise.all([loadChainState(), loadBalance()]);
    await props.refresh();
  } catch (e: any) {
    // 部分完成提示：若前序（授权/加池）已完成而本步失败，由 lastTx/记录可见
    if (e?.code !== 4001) record(id, "deposit", "fail", {});
    showFailToast(e?.shortMessage || e?.message || "FAIL");
  } finally {
    busy.value = "";
  }
}

// ===== 操作：sell 两步 =====
async function doApproveZyt() {
  const id = newTxId();
  busy.value = "zytApprove";
  try {
    const { zyt } = getContracts(true);
    const poolAddr = currentChain().contracts.pool;
    const tx = await zyt.approve(poolAddr, amtWei.value);
    record(id, "approve", "pending", { spend: `${amountNum.value} ZYT`, hash: tx.hash });
    await tx.wait();
    record(id, "approve", "success", { spend: `${amountNum.value} ZYT`, hash: tx.hash });
    await loadChainState();
  } catch (e: any) {
    if (e?.code !== 4001) record(id, "approve", "fail", {});
    showFailToast(e?.shortMessage || e?.message || "FAIL");
  } finally {
    busy.value = "";
  }
}

async function doSell() {
  const id = newTxId();
  busy.value = "sell";
  try {
    const { mining } = getContracts(true);
    const amt = amtWei.value;
    if (amt <= 0n) return;
    const tx = await mining.sellZyt(amt);
    record(id, "sell", "pending", { spend: `${amountNum.value} ZYT`, hash: tx.hash });
    await tx.wait();
    record(id, "sell", "success", {
      spend: `${amountNum.value} ZYT`,
      detail: t("swap.sellNote", { rate: props.slippage, pct: props.reductionPct }),
      hash: tx.hash,
    });
    amount.value = "";
    await Promise.all([loadChainState(), loadBalance()]);
    await props.refresh();
  } catch (e: any) {
    if (e?.code !== 4001) record(id, "sell", "fail", {});
    showFailToast(e?.shortMessage || e?.message || "FAIL");
  } finally {
    busy.value = "";
  }
}

function setPct(p: number) {
  const b = balanceNum.value;
  if (!b) return;
  amount.value = ((b * p) / 100).toFixed(4);
  resetFlow();
}

function fmtNum(n: number): string {
  if (n >= 1000) return n.toFixed(2);
  return n.toFixed(4).replace(/\.?0+$/, "") || "0";
}

/** 从 URL 读取推荐人 ?ref=0x... */
function refAddr(): string {
  const m = location.hash.match(/ref=([0-9a-fA-Fx]+)/);
  return m ? m[1] : "0x0000000000000000000000000000000000000000";
}
</script>

<style scoped lang="scss">
.mode-tabs {
  margin-bottom: 12px;
  :deep(.van-tabs__wrap) {
    background: var(--bg-card);
    border-radius: var(--radius-sm);
  }
  :deep(.van-tab) {
    color: var(--text-secondary);
  }
  :deep(.van-tab--active) {
    color: var(--gold);
  }
}
.input-row {
  display: flex;
  gap: 10px;
  align-items: center;
  .input-box {
    flex: 1;
    background: var(--bg-card);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    input {
      width: 100%;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text-primary);
      font-size: 20px;
      font-weight: 600;
    }
    .pct-btns {
      display: flex;
      gap: 8px;
      margin-top: 8px;
      .pct {
        font-size: 11px;
        color: var(--gold);
        border: 1px solid rgba(245, 193, 93, 0.4);
        border-radius: 12px;
        padding: 2px 8px;
        cursor: pointer;
        &.max {
          color: #141823;
          background: var(--gold);
          border-color: transparent;
        }
      }
    }
  }
  .token-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-card);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    cursor: pointer;
    .dot {
      width: 18px;
      height: 18px;
      border-radius: 50%;
    }
  }
}
.meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-secondary);
  margin: 10px 2px;
  .sliptip {
    text-align: right;
  }
}
.wl-tip {
  margin: 8px 2px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: rgba(245, 193, 93, 0.12);
  border: 1px solid rgba(245, 193, 93, 0.3);
  color: var(--gold);
  font-size: 12px;
  line-height: 1.5;
}
// v13：流程明细面板
.flow-panel {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin: 8px 0 10px;
  .flow-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 8px;
  }
  .flow-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--text-secondary);
    padding: 3px 0;
    b {
      color: var(--text-primary);
      font-weight: 600;
    }
    &.total {
      border-top: 1px dashed var(--border);
      margin-top: 4px;
      padding-top: 7px;
      span,
      b {
        color: var(--gold);
        font-weight: 700;
      }
    }
    &.sub {
      justify-content: flex-start;
      font-size: 11px;
      color: var(--text-tertiary);
    }
  }
  .flow-note {
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: 6px;
    line-height: 1.5;
    &.lp-note {
      color: var(--gold);
    }
  }
  .flow-err {
    font-size: 12px;
    color: #e05b5b;
    margin-top: 6px;
  }
  .auth-row {
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: 8px;
    b.ok {
      color: #2ecc71;
    }
    b.no {
      color: #e05b5b;
    }
    .auth-sub {
      display: block;
      word-break: break-all;
    }
  }
}
.action-btn {
  border-radius: 10px;
  height: 46px;
  font-size: 16px;
  margin-top: 4px;
  &.lp-btn {
    --van-button-warning-color: #1a1206;
  }
}
// 最近交易结果
.tx-result {
  margin-top: 10px;
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
  &.pending {
    color: var(--gold);
  }
  a {
    color: inherit;
    text-decoration: underline;
    word-break: break-all;
  }
}
</style>
