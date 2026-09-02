<template>
  <div class="panel swap-panel">
    <div class="panel-title">
      <span>{{ $t("swap.title") }}</span>
      <SlippageBadge :slippage="slippage" />
    </div>

    <!-- 模式切换：卖出 / 入金（v7：非白名单用户禁用入金） -->
    <van-tabs v-model:active="mode" class="mode-tabs" color="#f5c15d">
      <van-tab :title="$t('swap.sell')" name="sell" />
      <van-tab :title="$t('swap.buy')" name="buy" :disabled="isWhitelisted === false" />
    </van-tabs>

    <!-- v7：非白名单提示条 -->
    <div v-if="isWhitelisted === false" class="wl-tip">{{ $t("swap.whitelistTip") }}</div>

    <!-- v12：入金金额范围提示（链上 config.minDeposit/maxDeposit，默认 100~500U） -->
    <div v-if="mode === 'buy' && isWhitelisted !== false" class="range-tip">
      {{ $t("swap.depositRange", { min: depositMin, max: depositMax }) }}
    </div>
    <!-- v12：stage2 LP 1:1 配额提示 -->
    <div v-if="mode === 'buy' && stageRef === 2" class="range-tip lp-tip">
      {{ $t("swap.stage2Tip") }}
    </div>

    <!-- 金额输入 -->
    <div class="input-row">
      <div class="input-box">
        <input
          v-model="amount"
          type="text"
          inputmode="decimal"
          :placeholder="$t('swap.amountPlaceholder')"
        />
        <div class="pct-btns">
          <span v-for="p in [20, 50, 70]" :key="p" class="pct" @click="setPct(p)">{{ p }}%</span>
          <span class="pct max" @click="setPct(100)">{{ $t("swap.max") }}</span>
        </div>
      </div>
      <div class="token-btn" @click="showPicker = true">
        <span class="dot" :style="{ background: tokenColor }" />
        {{ tokenSymbol }}
        <van-icon name="arrow-down" size="12" />
      </div>
    </div>

    <div class="meta">
      <span>{{ $t("common.balance") }}: {{ balance }}</span>
      <span v-if="mode === 'sell'" class="sliptip">
        {{ $t("swap.slippageTip", { rate: slippage, pct: reductionPct }) }}
      </span>
    </div>

    <van-button
      block
      type="primary"
      :loading="submitting"
      :disabled="!walletReady || !amount"
      class="action-btn"
      @click="submit"
    >
      {{ mode === "sell" ? $t("swap.sellAction") : $t("swap.depositAction") }}
    </van-button>

    <TokenSelector v-model:show="showPicker" :selected="tokenSymbol" @select="onTokenSelect" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { parseEther, formatEther } from "ethers";
import { showToast, showSuccessToast, showFailToast } from "vant";
import { useI18n } from "vue-i18n";
import SlippageBadge from "./SlippageBadge.vue";
import TokenSelector, { type TokenOption } from "./TokenSelector.vue";
import { useWallet } from "../composables/useWallet";
import { getContracts, setSigner } from "../composables/useContracts";

const props = defineProps<{
  slippage: number;
  reductionPct: string;
  refresh: () => Promise<void>;
}>();

const { t } = useI18n();
const { address, getSigner, tokenBalance } = useWallet();
const mode = ref<"sell" | "buy">("sell");
const tokenSymbol = ref("ZYT");
const tokenColor = ref("#f5c15d");
const amount = ref("");
const balance = ref("0");
const showPicker = ref(false);
const submitting = ref(false);

const walletReady = computed(() => !!address.value);

// v7：买入白名单状态（null=加载中；false=未在白名单，禁用入金）
const isWhitelisted = ref<boolean | null>(null);
// v12：入金范围（链上 config 读取，默认 100~500U）
const depositMin = ref(100);
const depositMax = ref(500);
// v12：当前阶段（stage2 = LP 1:1 配额阶段，入金需先补 LP）
const stageRef = ref(0);

async function loadDepositRange() {
  try {
    const { config, pool } = getContracts(false);
    const [lo, hi, stage] = await Promise.all([config.minDeposit(), config.maxDeposit(), pool.getStage()]);
    depositMin.value = Number(formatEther(lo));
    depositMax.value = Number(formatEther(hi));
    stageRef.value = Number(stage);
  } catch {
    /* 保持默认 100~500 */
  }
}

async function loadWhitelist() {
  isWhitelisted.value = null;
  if (!address.value) return;
  try {
    const { pool, config } = getContracts(false);
    const enabled = await config.buyWhitelistEnabled();
    if (!enabled) {
      isWhitelisted.value = true; // 全局开关关闭（逃生通道）→ 人人可买
      return;
    }
    isWhitelisted.value = await pool.buyWhitelist(address.value);
  } catch {
    isWhitelisted.value = true; // 查询失败放行，避免卡死界面
  }
}

watch(
  address,
  async (a) => {
    if (a) {
      setSigner(await getSigner());
      await loadWhitelist();
      await loadDepositRange();
      await loadBalance();
    } else {
      isWhitelisted.value = null;
    }
  },
  // v12：immediate——组件挂载时 address 可能已非空（先连接后进页面），
  // 默认不立即触发会导致 setSigner 从未执行、入金报 NOT_CONNECTED
  { immediate: true }
);
watch(mode, () => loadBalance());

async function loadBalance() {
  if (!address.value) return;
  try {
    const { zyt, usdt } = getContracts(false);
    const { address: addr } = useWallet();
    if (tokenSymbol.value === "ZYT") {
      const bal = await zyt.balanceOf(addr.value);
      balance.value = formatEther(bal);
    } else {
      const bal = await usdt.balanceOf(addr.value);
      balance.value = formatEther(bal);
    }
  } catch {
    balance.value = "0";
  }
}

function setPct(p: number) {
  const b = parseFloat(balance.value) || 0;
  amount.value = ((b * p) / 100).toFixed(4);
}

function onTokenSelect(tk: TokenOption) {
  tokenSymbol.value = tk.symbol;
  tokenColor.value = tk.color;
  loadBalance();
}

async function submit() {
  if (!amount.value || parseFloat(amount.value) <= 0) return;
  // v12：入金前校验链上金额范围（100~500U），避免浪费 gas 触发合约 revert
  if (mode.value === "buy") {
    const v = parseFloat(amount.value);
    if (v < depositMin.value || v > depositMax.value) {
      showFailToast(t("swap.amountOutOfRange", { min: depositMin.value, max: depositMax.value }));
      return;
    }
  }
  submitting.value = true;
  try {
    const amt = parseEther(amount.value);
    if (mode.value === "sell") {
      // 卖出 ZYT：需授权 pool（由 mining.sellZyt 内部转给 pool）
      const { mining, zyt } = getContracts(true);
      const poolAddr = await (await import("../config")).currentChain().contracts.pool;
      const tx0 = await zyt.approve(poolAddr, amt);
      await tx0.wait();
      const tx = await mining.sellZyt(amt);
      await tx.wait();
      showSuccessToast("OK");
    } else {
      // 入金：USDT 授权 mining（addLiquidity 与 deposit 均由 mining 发起 transferFrom，一次授权覆盖）
      const { mining, pool, usdt } = getContracts(true);
      const amt = parseEther(amount.value);
      const stage = Number(await pool.getStage());
      const tx0 = await usdt.approve(await mining.getAddress(), stage === 2 ? amt * 2n : amt);
      await tx0.wait();
      // v12：stage2（LP 1:1 配额阶段）需先补充 LP 配额再入金——缺额 = 入金额 - 现有 lpQuota
      if (stage === 2) {
        const info = await mining.userInfo(address.value);
        const lp = BigInt(info[5] ?? 0);
        const need = amt - lp;
        if (need > 0n) {
          await (await mining.addLiquidity(need)).wait();
        }
      }
      const tx = await mining.deposit(amt, refAddr());
      await tx.wait();
      showSuccessToast("OK");
    }
    amount.value = "";
    await props.refresh();
    await loadBalance();
  } catch (e: any) {
    showFailToast(e?.shortMessage || e?.message || "FAIL");
  } finally {
    submitting.value = false;
  }
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
  color: var(--gold);  font-size: 12px;
  line-height: 1.5;
}
.range-tip {
  margin: 2px 2px 10px;
  font-size: 11px;
  color: var(--text-tertiary);
}
.action-btn {
  border-radius: 10px;
  height: 46px;
  font-size: 16px;
  margin-top: 4px;
}
</style>
