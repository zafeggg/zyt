<template>
  <div class="page migrate-page">
    <div class="panel">
      <div class="panel-title">{{ $t("migrate.title") }}</div>
      <div class="mig-rate">{{ $t("migrate.rate") }}</div>
      <div class="mig-desc">{{ $t("migrate.desc") }}</div>

      <!-- 未接线（地址空串）/ 未开放 -->
      <div v-if="!swapAddr" class="mig-closed">{{ $t("migrate.notOpen") }}</div>

      <template v-else>
        <div class="mig-count" :class="{ urgent: isOpen && remainSec > 0 && remainSec < 86400 }">
          {{ isOpen ? $t("migrate.countdown", countdownParams) : $t("migrate.closed") }}
        </div>

        <div class="mig-row">
          <span>{{ $t("migrate.oldBalance") }}</span>
          <b>{{ oldBalFmt }} ZYT</b>
        </div>
        <div class="mig-row">
          <span>{{ $t("migrate.newBalance") }}</span>
          <b>{{ newBalFmt }} ZYT</b>
        </div>
        <div class="mig-row">
          <span>{{ $t("migrate.totalSwapped") }}</span>
          <b>{{ totalInFmt }} ZYT</b>
        </div>
        <div class="mig-row sub">
          <span>{{ $t("migrate.deadline") }}</span>
          <span>{{ deadlineText }}</span>
        </div>

        <!-- 金额输入 -->
        <div class="input-row">
          <div class="input-box">
            <input
              v-model="amount"
              type="text"
              inputmode="decimal"
              :placeholder="$t('migrate.amountPlaceholder')"
              :disabled="!isOpen"
            />
          </div>
          <span class="pct max" @click="setMax">{{ $t("migrate.max") }}</span>
        </div>

        <div v-if="!walletReady" class="mig-hint">{{ $t("migrate.notConnected") }}</div>
        <div v-else-if="amountNum > oldBalNum" class="mig-err">{{ $t("migrate.insufficient") }}</div>
        <div v-else-if="closedOrExpired" class="mig-err">{{ $t("migrate.closedTip") }}</div>

        <van-button
          v-if="walletReady && !approved && isOpen"
          block
          type="primary"
          :disabled="!canApprove"
          class="action-btn"
          @click="doApprove"
        >
          {{ busy === "approve" ? $t("migrate.approving") : $t("migrate.approve") }}
        </van-button>
        <van-button
          v-if="walletReady && approved && isOpen"
          block
          type="primary"
          :disabled="!canSwap"
          class="action-btn"
          @click="doSwap"
        >
          {{ busy === "swap" ? $t("migrate.swapping") : $t("migrate.action") }}
        </van-button>

        <div v-if="txMsg" class="mig-tx" :class="txOk ? 'ok' : 'no'">{{ txMsg }}</div>
        <div class="mig-note">{{ $t("migrate.note") }}</div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Contract, formatEther, parseEther } from "ethers";
import { currentChain } from "../config";
import { getReadProvider, setSigner } from "../composables/useContracts";
import { useWallet } from "../composables/useWallet";
import { SWAP_ABI } from "../abis/swap";

/**
 * v9.2 迁移兑换页（旧 ZYT 1:1 → 新 ZYT）
 *
 * 数据源：ZYTSwap 合约直连（isOpen / deadline / totalOldIn）+ 旧 ZYT 余额与授权。
 * 与链上口径一致：窗口 = 首次注资起 14 天，owner 可提前关闭；兑换 1:1 无税无滑点。
 * 提示口径：兑换不可逆（旧币统一转销毁地址），金额只进不出。
 */
const { t } = useI18n();
const { address, getSigner } = useWallet();

const ERC20_MIN = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const swapAddr = computed(() => currentChain().contracts.swap || "");
const oldZytAddr = computed(() => currentChain().contracts.oldZyt || "");
const walletReady = computed(() => !!address.value);

const amount = ref("");
const amountNum = computed(() => parseFloat(amount.value) || 0);
const oldBal = ref(0n);
const newBal = ref(0n);
const allowanceAmt = ref(0n);
const totalIn = ref(0n);
const isOpen = ref(false);
const deadlineSec = ref(0);
const nowSec = ref(Math.floor(Date.now() / 1000));
const busy = ref<"" | "approve" | "swap">("");
const txMsg = ref("");
const txOk = ref(false);

const oldBalNum = computed(() => Number(formatEther(oldBal.value)));
const oldBalFmt = computed(() => oldBalNum.value.toFixed(2));
const newBalFmt = computed(() => Number(formatEther(newBal.value)).toFixed(2));
const totalInFmt = computed(() => Number(formatEther(totalIn.value)).toFixed(2));
const amtWei = computed(() => (amountNum.value > 0 ? parseEther(String(amountNum.value)) : 0n));
const approved = computed(() => allowanceAmt.value >= amtWei.value && amtWei.value > 0n);
const remainSec = computed(() => (deadlineSec.value > 0 ? Math.max(0, deadlineSec.value - nowSec.value) : 0));
const closedOrExpired = computed(() => !isOpen.value || remainSec.value <= 0);
const canApprove = computed(() => walletReady.value && isOpen.value && amtWei.value > 0n && amtWei.value <= oldBal.value && busy.value === "");
const canSwap = computed(() => canApprove.value && !closedOrExpired.value);

const countdownParams = computed(() => ({
  d: Math.floor(remainSec.value / 86400),
  h: Math.floor((remainSec.value % 86400) / 3600),
  m: Math.floor((remainSec.value % 3600) / 60),
  s: remainSec.value % 60,
}));

const deadlineText = computed(() => {
  if (!deadlineSec.value) return "-";
  const d = new Date(deadlineSec.value * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
});

function setMax() {
  amount.value = oldBalNum.value > 0 ? String(oldBalNum.value) : "";
}

function swapRead(): Contract {
  return new Contract(swapAddr.value, SWAP_ABI, getReadProvider());
}

async function refresh() {
  if (!swapAddr.value) return;
  try {
    const s = swapRead();
    const [open, dl, tin] = await Promise.all([s.isOpen(), s.deadline(), s.totalOldIn()]);
    isOpen.value = Boolean(open);
    deadlineSec.value = Number(dl);
    totalIn.value = BigInt(tin);
  } catch {
    /* 读失败保持现值 */
  }
  if (!address.value) return;
  try {
    const oldC = new Contract(oldZytAddr.value, ERC20_MIN, getReadProvider());
    const [ob, al, nb] = await Promise.all([
      oldC.balanceOf(address.value),
      oldC.allowance(address.value, swapAddr.value),
      new Contract(currentChain().contracts.zyt, ERC20_MIN, getReadProvider()).balanceOf(address.value),
    ]);
    oldBal.value = BigInt(ob);
    allowanceAmt.value = BigInt(al);
    newBal.value = BigInt(nb);
  } catch {
    /* 读失败保持现值 */
  }
}

async function doApprove() {
  busy.value = "approve";
  try {
    const signer = await getSigner();
    setSigner(signer);
    // ERC20 最小 ABI 传入的是字符串数组，ethers 推断为 BaseContract，此处按实际方法签名收窄
    const oldC = new Contract(oldZytAddr.value, ERC20_MIN, signer) as unknown as {
      approve(to: string, amount: bigint): Promise<{ wait(): Promise<unknown> }>;
    };
    const tx = await oldC.approve(swapAddr.value, amtWei.value);
    await tx.wait();
    txOk.value = true;
    txMsg.value = t("migrate.approvedMsg");
  } catch (e) {
    txOk.value = false;
    txMsg.value = `${t("migrate.failed")}: ${String((e as Error).message).slice(0, 80)}`;
  } finally {
    busy.value = "";
    await refresh();
  }
}

async function doSwap() {
  busy.value = "swap";
  try {
    const signer = await getSigner();
    setSigner(signer);
    const tx = await new Contract(swapAddr.value, SWAP_ABI, signer).swap(amtWei.value);
    await tx.wait();
    txOk.value = true;
    txMsg.value = `${t("migrate.success")} (${tx.hash.slice(0, 10)}…)`;
    amount.value = "";
  } catch (e) {
    txOk.value = false;
    txMsg.value = `${t("migrate.failed")}: ${String((e as Error).message).slice(0, 80)}`;
  } finally {
    busy.value = "";
    await refresh();
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  if (address.value) setSigner(await getSigner());
  await refresh();
  timer = setInterval(() => {
    nowSec.value = Math.floor(Date.now() / 1000);
  }, 1000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
watch(address, async () => {
  setSigner(await getSigner());
  await refresh();
});
</script>

<style scoped lang="scss">
.migrate-page {
  .mig-rate {
    font-size: 13px;
    color: var(--gold);
    font-weight: 600;
    margin-bottom: 4px;
  }
  .mig-desc {
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-secondary);
  }
  .mig-closed {
    margin-top: 14px;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: rgba(226, 75, 74, 0.1);
    border: 1px solid rgba(226, 75, 74, 0.3);
    color: #f47a77;
    font-size: 12px;
  }
  .mig-count {
    margin: 12px 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: rgba(110, 198, 255, 0.12);
    border: 1px solid rgba(110, 198, 255, 0.35);
    color: #6ec6ff;
    font-size: 13px;
    text-align: center;
    font-weight: 600;
    &.urgent {
      background: rgba(245, 193, 93, 0.14);
      border-color: rgba(245, 193, 93, 0.4);
      color: var(--gold);
    }
  }
  .mig-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--text-secondary);
    padding: 5px 0;
    b {
      color: var(--text-primary);
    }
    &.sub {
      font-size: 11px;
      color: var(--text-tertiary);
    }
  }
  .mig-hint,
  .mig-err,
  .mig-tx {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    line-height: 1.5;
  }
  .mig-hint {
    background: rgba(245, 193, 93, 0.1);
    border: 1px solid rgba(245, 193, 93, 0.3);
    color: var(--gold);
  }
  .mig-err {
    background: rgba(226, 75, 74, 0.1);
    border: 1px solid rgba(226, 75, 74, 0.3);
    color: #f47a77;
  }
  .mig-tx {
    &.ok {
      background: rgba(76, 195, 138, 0.1);
      border: 1px solid rgba(76, 195, 138, 0.3);
      color: #4cc38a;
    }
    &.no {
      background: rgba(226, 75, 74, 0.1);
      border: 1px solid rgba(226, 75, 74, 0.3);
      color: #f47a77;
    }
  }
  .mig-note {
    margin-top: 12px;
    font-size: 10px;
    line-height: 1.6;
    color: var(--text-tertiary);
  }
}
</style>
