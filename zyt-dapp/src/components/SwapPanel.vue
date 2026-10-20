<template>
  <div class="panel swap-panel">
    <div class="panel-title">
      <span>{{ $t("swap.title") }}</span>
      <SlippageBadge :slippage="slippage" />
    </div>

    <!-- v9 三 Tab：入金（全阶段） / 买入（阶段 2 起，真池直换） / 卖出（全阶段） -->
    <van-tabs v-model:active="mode" class="mode-tabs" color="#f5c15d" @change="resetFlow">
      <van-tab :title="$t('swap.deposit')" name="deposit" />
      <van-tab :title="$t('swap.buy')" name="buy" :disabled="stageBlocked" />
      <van-tab :title="$t('swap.sell')" name="sell" />
    </van-tabs>

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
          <span v-for="p in [2, 5, 10, 20]" :key="p" class="pct" @click="setPct(p)">{{ p }}%</span>
          <span class="pct max" @click="setPct(100)">{{ $t("swap.max") }}</span>
        </div>
      </div>
      <!-- v9：币种随模式锁定（deposit/buy=USDT / sell=ZYT） -->
      <div class="token-btn" :style="{ cursor: 'default' }">
        <span class="dot" :style="{ background: tokenColor }" />
        {{ tokenSymbol }}
      </div>
    </div>

    <div class="meta">
      <span v-if="mode === 'buy'">{{ $t("swap.buyQuotaAvail") }}: {{ fmtNum(buyQuotaNum) }} U</span>
      <span v-else>{{ $t("common.balance") }}: {{ balance }}</span>
      <span v-if="mode === 'sell'" class="sliptip">
        {{ $t("swap.slippageTip", { rate: slippage, pct: reductionPct }) }}
      </span>
      <span v-else-if="mode === 'deposit'" class="sliptip">{{ $t("swap.depositStageTip") }}</span>
    </div>

    <!-- ===== 入金：40% 生态奖励 + 60% 创建底池，用户获得算力（不发放 ZYT） ===== -->
    <template v-if="mode === 'deposit' && amountNum > 0">
      <div class="flow-panel">
        <div class="flow-title">{{ $t("swap.flowTitle") }}</div>
        <div class="flow-row"><span>{{ $t("swap.flowDeposit") }}</span><b>{{ fmtNum(amountNum) }} USDT</b></div>
        <div class="flow-row">
          <span>{{ $t("swap.flowReward") }}</span><b>{{ fmtNum(amountNum * rewardRatio) }} USDT</b>
        </div>
        <div class="flow-row">
          <span>{{ $t("swap.flowPool") }}</span><b>{{ fmtNum(amountNum * (1 - rewardRatio)) }} USDT</b>
        </div>
        <div class="flow-row total">
          <span>{{ $t("swap.flowTotal") }}</span><b>{{ fmtNum(amountNum) }} USDT</b>
        </div>
        <div class="flow-note">
          {{ $t("swap.depositRewardNote", { reward: fmtNum(amountNum * rewardRatio) }) }}
        </div>
        <div class="flow-note">
          {{ $t("swap.depositPoolNote", { pool: fmtNum(amountNum * (1 - rewardRatio)) }) }}
        </div>
        <div class="flow-note">{{ $t("swap.depositPowerNote", { power: fmtNum(amountNum) }) }}</div>
        <div class="flow-note lp-note">{{ $t("swap.depositNoZytNote") }}</div>
        <div v-if="balanceErr" class="flow-err">
          {{ $t("swap.insufficientBalance", { need: fmtNum(amountNum), bal: balance }) }}
        </div>
        <!-- v9.2 入金规则：100U 倍数 / 单笔 100-500U / 单钱包累计 500U -->
        <div v-if="depositErrKey" class="flow-err">
          {{
            $t(depositErrKey, {
              min: 100,
              max: 500,
              step: 100,
              left: fmtNum(depositCapLeft),
            })
          }}
        </div>
        <div v-else-if="isNewRound" class="flow-note">{{ $t("swap.reinvestNote") }}</div>
        <div v-else class="flow-note">
          {{ $t("swap.depositCapNote", { used: fmtNum(depositTotalNum), left: fmtNum(depositCapLeft) }) }}
        </div>
        <div class="auth-row">
          <span>{{ $t("swap.approveStatus") }}：</span>
          <b :class="approved ? 'ok' : 'no'">{{ approved ? $t("swap.approved") : $t("swap.notApproved") }}</b>
          <template v-if="approved">
            <span class="auth-sub">{{ $t("swap.approveTarget") }}：{{ miningAddrShort }}</span>
          </template>
        </div>
      </div>

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
        v-if="approved && busy !== 'deposit'"
        block
        type="primary"
        :disabled="!walletReady || balanceErr || depositErrKey !== '' || busy !== ''"
        class="action-btn"
        @click="doDeposit"
      >
        {{ $t("swap.depositAction") }}
      </van-button>
      <van-button v-if="busy === 'deposit'" block type="primary" loading class="action-btn">
        {{ $t("swap.depositing") }}
      </van-button>
    </template>

    <!-- ===== 买入：USDT 真池直换 ZYT（AMM 成交价；阶段 2 消耗买额） ===== -->
    <template v-else-if="mode === 'buy'">
      <div class="flow-panel">
        <div class="flow-row"><span>{{ $t("swap.buyQuotaAvail") }}</span><b>{{ fmtNum(buyQuotaNum) }} U</b></div>
        <div v-if="amountNum > 0" class="flow-row total">
          <span>{{ $t("swap.buyPreview") }}</span><b>≈ {{ fmtCompact(buyOut) }} ZYT</b>
        </div>
        <div class="flow-note">{{ $t("swap.buyNote") }}</div>
        <div v-if="stageBlocked" class="flow-err">{{ $t("swap.buyStageTip") }}</div>
        <div v-else-if="stage2QuotaOver" class="flow-err">
          {{ $t("swap.buyQuotaExceed", { max: fmtNum(buyQuotaNum) }) }}
        </div>
        <div v-if="balanceErr" class="flow-err">
          {{ $t("swap.insufficientBalance", { need: fmtNum(amountNum), bal: balance }) }}
        </div>
        <div class="auth-row">
          <span>{{ $t("swap.approveStatus") }}：</span>
          <b :class="approved ? 'ok' : 'no'">{{ approved ? $t("swap.approved") : $t("swap.notApproved") }}</b>
        </div>
      </div>
      <van-button
        v-if="!approved && busy !== 'approve'"
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
        v-if="approved && busy !== 'buy'"
        block
        type="primary"
        :disabled="!buyReady"
        class="action-btn"
        @click="doBuy"
      >
        {{ $t("swap.buyAction") }}
      </van-button>
      <van-button v-if="busy === 'buy'" block type="primary" loading class="action-btn">
        {{ $t("swap.buying") }}
      </van-button>
    </template>

    <!-- ===== 卖出：授权 ZYT → 确认卖出 ===== -->
    <template v-else-if="mode === 'sell' && amountNum > 0">
      <div class="flow-panel">
        <div class="flow-row"><span>{{ $t("swap.sellAmount") }}</span><b>{{ fmtNum(amountNum) }} ZYT</b></div>
        <div class="flow-row sub">{{ $t("swap.sellNote", { rate: slippage, pct: reductionPct }) }}</div>
        <!-- v9.2 卖币窗口：每月 14/28 日（北京时间）全天可卖，窗口外禁卖；额度 = 窗口首次活动时余额 × 档位 -->
        <div class="flow-row sub">
          <span>{{ $t("swap.sellWindowLabel") }}</span>
          <b :class="sellWindowOpen ? 'ok' : 'no'">{{ sellWindowText }}</b>
        </div>
        <div class="flow-row sub">
          <span>{{ $t("swap.sellQuotaLabel") }}</span>
          <b>{{ fmtNum(sellRemainNum) }} ZYT（{{ tierPctText }}）</b>
        </div>
        <div v-if="balanceErr" class="flow-err">{{ $t("swap.insufficientBalance", { need: fmtNum(amountNum), bal: balance }) }}</div>
        <div v-if="sellErrKey" class="flow-err">{{ $t(sellErrKey, { n: fmtNum(sellRemainNum) }) }}</div>
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
        :disabled="!walletReady || balanceErr || sellErrKey !== '' || busy !== ''"
        class="action-btn"
        @click="doSell"
      >
        {{ $t("swap.sellAction") }}
      </van-button>
      <van-button v-if="busy === 'sell'" block type="primary" loading class="action-btn">
        {{ $t("swap.selling") }}
      </van-button>
    </template>

    <!-- 最近交易结果行 -->
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
import { getContracts, getForceSellContract, setSigner } from "../composables/useContracts";
import { useTxRecords, newTxId, type TxRecord, type TxType, type TxStatus } from "../composables/useTxRecords";
import { useInvite } from "../composables/useInvite";
import { currentChain } from "../config";

const props = defineProps<{
  slippage: number;
  reductionPct: string;
  refresh: () => Promise<void>;
}>();

const { t } = useI18n();
const { address, getSigner } = useWallet();
const { upsert } = useTxRecords();
const { getSaved } = useInvite();

/** v9：入金（全阶段）/ 买入（阶段 2 起，真池直换）/ 卖出（全阶段） */
const mode = ref<"deposit" | "buy" | "sell">("deposit");
const tokenSymbol = computed(() => (mode.value === "sell" ? "ZYT" : "USDT"));
const tokenColor = computed(() => (tokenSymbol.value === "ZYT" ? "#f5c15d" : "#26a17b"));
const amount = ref("");
const balance = ref("0");

const walletReady = computed(() => !!address.value);
const amountNum = computed(() => parseFloat(amount.value) || 0);
const balanceNum = computed(() => parseFloat(balance.value) || 0);

// ===== 链上状态 =====
const stageRef = ref(0);
const allowanceUsdt = ref<bigint>(0n);
const allowanceZyt = ref<bigint>(0n);
const powerWei = ref<bigint>(0n);
const buyQuotaWei = ref<bigint>(0n);
const dynamicExitedRef = ref(false);
// ===== v9.2 入金规则校验所需状态 =====
const staticExitedRef = ref(false);
const depositTotalWei = ref<bigint>(0n);
// ===== v9.2 卖币窗口状态（ForceSell 直连） =====
const sellWindowId = ref(0);
const sellWindowOpen = ref(false);
const sellTierBps = ref(0);
const sellQuotaWei = ref<bigint>(0n);
const sellSoldWei = ref<bigint>(0n);
const tradePriceWei = ref<bigint>(0n);
const miningAddr = ref("");
// 流程执行中标记："" 空闲 / approve / deposit / buy / zytApprove / sell
const busy = ref<"" | "approve" | "deposit" | "buy" | "zytApprove" | "sell">("");
const lastTx = ref<{ type: TxType; status: TxStatus; hash?: string } | null>(null);

const miningAddrShort = computed(() =>
  miningAddr.value ? `${miningAddr.value.slice(0, 8)}...${miningAddr.value.slice(-6)}` : ""
);

// ===== deposit 侧派生 =====
/** 生态奖励占比：与合约 marketingRate 默认 4000（40%）一致，仅作用于明细展示 */
const rewardRatio = 0.4;
const amtWei = computed(() => (amountNum.value > 0 ? parseEther(String(amountNum.value)) : 0n));
const approved = computed(() => allowanceUsdt.value >= amtWei.value);
const balanceErr = computed(() => balanceNum.value < amountNum.value);

// ===== buy 侧派生（v9 真池直换） =====
/** 阶段未知（stageRef=0，加载中）不禁用，避免误挡；一旦读到 1 则禁用 */
const stageBlocked = computed(() => stageRef.value !== 0 && stageRef.value < 2);
const buyQuotaNum = computed(() => Number(formatEther(buyQuotaWei.value)));
/** 阶段 2 消耗买额（1:1）；阶段 3 自由。stageRef=3 时不限制 */
const stage2QuotaOver = computed(() => stageRef.value === 2 && amtWei.value > buyQuotaWei.value);
const buyOut = computed(() => {
  if (tradePriceWei.value <= 0n || amtWei.value <= 0n) return "0";
  // 按实时价估算（实际以 AMM 成交为准，含 0.25% fee 与滑点）
  return formatEther((amtWei.value * 10n ** 18n) / tradePriceWei.value);
});
const buyReady = computed(
  () =>
    !!address.value &&
    !stageBlocked.value &&
    !stage2QuotaOver.value &&
    !balanceErr.value &&
    amountNum.value > 0 &&
    busy.value === ""
);

// ===== sell 侧派生 =====
const zytApproved = computed(() => allowanceZyt.value >= amtWei.value);

// ===== v9.2 入金规则校验（100U 倍数 / 单笔 100-500U / 单钱包累计 500U / 复投开新一轮） =====
const depositTotalNum = computed(() => Number(formatEther(depositTotalWei.value)));
/** 复投开新一轮：静态 2 倍或动态 5 倍任一出局后可全额入金（账本按本笔重算） */
const isNewRound = computed(() => staticExitedRef.value || dynamicExitedRef.value);
const depositCapLeft = computed(() => Math.max(0, 500 - depositTotalNum.value));
const depositErrKey = computed(() => {
  if (mode.value !== "deposit" || amountNum.value <= 0) return "";
  if (amountNum.value % 100 !== 0) return "swap.depositStepErr";
  if (amountNum.value < 100 || amountNum.value > 500) return "swap.depositRangeErr";
  if (!isNewRound.value && amountNum.value > depositCapLeft.value) return "swap.depositCapErr";
  return "";
});

// ===== v9.2 卖币窗口额度（窗口外禁卖 + 当期额度上限，与合约同口径） =====
const sellRemainWei = computed(() =>
  sellQuotaWei.value > sellSoldWei.value ? sellQuotaWei.value - sellSoldWei.value : 0n
);
const sellRemainNum = computed(() => Number(formatEther(sellRemainWei.value)));
const tierPctText = computed(() => `${sellTierBps.value / 100}%`);
const sellWindowText = computed(() =>
  sellWindowOpen.value ? t("swap.sellWindowOpen", { id: sellWindowId.value }) : t("swap.sellWindowClosedShort")
);
const sellOverQuota = computed(() => sellRemainWei.value > 0n && amtWei.value > sellRemainWei.value);
const sellErrKey = computed(() => {
  if (mode.value !== "sell" || amountNum.value <= 0) return "";
  if (!sellWindowOpen.value) return "swap.sellWindowClosed";
  if (sellOverQuota.value) return "swap.sellOverQuota";
  return "";
});

// ===== 数据加载 =====
async function loadChainState() {
  if (!address.value) return;
  try {
    const { usdt, mining, pool } = getContracts(false);
    const miningA = await mining.getAddress();
    miningAddr.value = miningA;
    const stage = Number(await pool.getStage());
    stageRef.value = stage;
    // v9：一次性读取授权、用户账本（8 元组）、当日快照价（买入预估用）
    const [au, info, price] = await Promise.all([
      usdt.allowance(address.value, miningA),
      mining.userInfo(address.value),
      pool.getPrice(),
    ]);
    allowanceUsdt.value = au;
    tradePriceWei.value = price;
    powerWei.value = BigInt(info[2] ?? 0);
    buyQuotaWei.value = BigInt(info[5] ?? 0);
    dynamicExitedRef.value = !!info[7];
    // v9.2：累计入金（500U 上限校验）与静态出局标记（复投判定）
    depositTotalWei.value = BigInt(info[0] ?? 0);
    staticExitedRef.value = !!info[6];
    // v9.2：卖币窗口（直连 ForceSell；keeper 口径同源，此处置于链上实时口径）
    const fsC = getForceSellContract();
    if (fsC) {
      const { zyt: zytC } = getContracts(false);
      const [win, tier, latch, zbal] = await Promise.all([
        fsC.currentWindow(),
        fsC.tierBpsOf(address.value),
        fsC.windows(address.value),
        zytC.balanceOf(address.value),
      ]);
      sellWindowId.value = Number(win[0]);
      sellWindowOpen.value = Boolean(win[1]);
      sellTierBps.value = Number(tier);
      const latchId = Number(latch[0]);
      // 锁存命中（本窗口已有活动）用锁存额度；否则额度 = 当前余额 × 档位（与合约同口径）
      if (latchId !== 0 && latchId === Number(win[0])) {
        sellQuotaWei.value = BigInt(latch[1]);
        sellSoldWei.value = BigInt(latch[2]);
      } else {
        sellQuotaWei.value = (BigInt(zbal) * BigInt(tier)) / 10000n;
        sellSoldWei.value = 0n;
      }
    }
    // sell 授权（zyt → pool）
    if (mode.value === "sell") {
      const { zyt } = getContracts(false);
      const poolAddr = currentChain().contracts.pool;
      allowanceZyt.value = await zyt.allowance(address.value, poolAddr);
    }
  } catch {
    /* 读失败保持现值，不阻塞 */
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
      await Promise.all([loadChainState(), loadBalance()]);
    } else {
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
    buy: t("swap.buy"),
    convert: t("swap.convert"),
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

// ===== 操作：入金 =====
async function doApprove() {
  const id = newTxId();
  busy.value = "approve";
  try {
    const { usdt, mining } = getContracts(true);
    const miningA = await mining.getAddress();
    const tx = await usdt.approve(miningA, amtWei.value);
    record(id, "approve", "pending", { spend: `${Number(formatEther(amtWei.value))} USDT`, hash: tx.hash });
    await tx.wait();
    record(id, "approve", "success", {
      spend: `${Number(formatEther(amtWei.value))} USDT`,
      hash: tx.hash,
      detail: t("swap.approveTarget") + " " + miningA,
    });
    await loadChainState();
  } catch (e: any) {
    if (e?.code !== 4001) record(id, "approve", "fail", {});
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
    const n = Number(formatEther(amt));
    record(id, "deposit", "success", {
      spend: `${n} USDT`,
      receive: `${fmtNum(n)} ${t("home.powerUnit")}`,
      detail: t("records.depositDetail", {
        marketing: Math.round(n * rewardRatio),
        pool: Math.round(n * (1 - rewardRatio)),
      }),
      hash: tx.hash,
    });
    amount.value = "";
    await Promise.all([loadChainState(), loadBalance()]);
    await props.refresh();
  } catch (e: any) {
    if (e?.code !== 4001) record(id, "deposit", "fail", {});
    showFailToast(e?.shortMessage || e?.message || "FAIL");
  } finally {
    busy.value = "";
  }
}

// ===== 操作：买入（v9 真池直换；approve USDT → mining） =====
async function doBuy() {
  const id = newTxId();
  busy.value = "buy";
  try {
    const { mining } = getContracts(true);
    const v = amtWei.value;
    if (v <= 0n) return;
    const out = buyOut.value;
    const tx = await mining.buy(v);
    record(id, "buy", "pending", { spend: `${fmtNum(amountNum.value)} USDT`, hash: tx.hash });
    await tx.wait();
    record(id, "buy", "success", {
      spend: `${fmtNum(amountNum.value)} USDT`,
      receive: `≈ ${fmtCompact(out)} ZYT`,
      detail: t("records.buyDetail", { usdt: fmtNum(amountNum.value) }),
      hash: tx.hash,
    });
    amount.value = "";
    await Promise.all([loadChainState(), loadBalance()]);
    await props.refresh();
  } catch (e: any) {
    if (e?.code !== 4001) record(id, "buy", "fail", {});
    showFailToast(e?.shortMessage || e?.message || "FAIL");
  } finally {
    busy.value = "";
  }
}

// ===== 操作：卖出 =====
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

/**
 * 各模式的「有效上限」——百分比快捷与 MAX 都以它为基数：
 *  - 入金：min(钱包 USDT, 剩余累计额度, 500)，复投新一轮时上限为 500
 *  - 买入：min(钱包 USDT, 剩余买额)
 *  - 卖出：min(持币 ZYT, 当期剩余可卖额度)
 */
const effectiveMax = computed(() => {
  if (mode.value === "deposit") {
    const left = isNewRound.value ? 500 : depositCapLeft.value;
    return Math.max(0, Math.min(balanceNum.value, left, 500));
  }
  if (mode.value === "buy") {
    const quota = Number(formatEther(buyQuotaWei.value));
    return quota > 0 ? Math.min(balanceNum.value, quota) : balanceNum.value;
  }
  const remain = sellRemainNum.value;
  return remain > 0 ? Math.min(balanceNum.value, remain) : balanceNum.value;
});

/** 百分比快捷：2% / 5% / 10% / 20% / MAX；入金向下取整到 100U 倍数并夹在 100–500 */
function setPct(p: number) {
  const base = effectiveMax.value;
  if (!(base > 0)) return;
  let v = (base * p) / 100;
  if (mode.value === "deposit") {
    v = Math.floor(v / 100) * 100;
    if (v < 100) v = Math.min(100, Math.floor(base / 100) * 100); // 不足最小额时补到 100（受上限约束）
    if (v > 500) v = 500;
    if (v <= 0) {
      amount.value = "";
      resetFlow();
      return;
    }
    amount.value = String(v);
  } else {
    // 非入金：向下截到 4 位小数，避免浮点四舍五入后超出上限
    amount.value = String(Math.floor(v * 1e4) / 1e4);
  }
  resetFlow();
}

function fmtNum(n: number | string): string {
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "0";
  return v.toFixed(4).replace(/\.?0+$/, "") || "0";
}

function fmtCompact(n: string): string {
  const v = parseFloat(n);
  if (isNaN(v)) return "0";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return v.toFixed(2);
}

/** 入金推荐人：URL ?ref= 优先，其次邀请 gate 存储的邀请码，否则零地址 */
function refAddr(): string {
  const q = new URLSearchParams(location.hash.split("?")[1] || location.search.split("?")[1] || "");
  const fromUrl = q.get("ref") || "";
  if (/^0x[0-9a-fA-F]{40}$/.test(fromUrl)) return fromUrl;
  return getSaved() || "0x0000000000000000000000000000000000000000";
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
      flex-wrap: wrap;
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
}
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
