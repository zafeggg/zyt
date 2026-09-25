<template>
  <div class="home">
    <WalletHeader />

    <DataDashboard :pool="poolStats" :user="userStats" />

    <!-- 底池数据 -->
    <div class="panel">
      <div class="panel-title">{{ $t("home.poolTitle") }}</div>
      <div class="pool-cards">
        <div class="pool-card">
          <div class="p-label">{{ $t("home.poolGst") }}</div>
          <div class="p-value">{{ loaded ? fmtNum(poolStats.poolUSDT, 2) : "--" }}</div>
          <div class="p-sub">USDT</div>
        </div>
        <div class="pool-card">
          <div class="p-label">{{ $t("home.poolZyt") }}</div>
          <div class="p-value">{{ loaded ? fmtCompact(poolStats.poolZYT) : "--" }}</div>
          <div class="p-sub">ZYT</div>
        </div>
        <div class="pool-card">
          <div class="p-label">{{ $t("home.price") }}</div>
          <div class="p-value price">{{ loaded ? fmtPrice(poolStats.price) : "--" }}</div>
          <div class="p-sub">USDT</div>
        </div>
      </div>
      <div v-if="error && !loaded" class="err-tip">{{ $t("home.loadError") }}</div>
      <div class="stage-line">
        <span v-for="s in 3" :key="s" class="stage" :class="{ active: poolStats.stage >= s }">
          阶段{{ s }}
        </span>
      </div>
      <!-- v17：底池创建累计（Creator 未接线时不展示，不以 0 冒充） -->
      <div v-if="creatorLine" class="creator-line">{{ creatorLine }}</div>
    </div>

    <!-- 我的资产 -->
    <div class="panel">
      <div class="panel-title">{{ $t("home.myEarnings") }}</div>
      <div class="asset-row">
        <div class="asset">
          <div class="a-value gold">
            {{ userStats ? fmtNum(userStats.withdrawTotal, 2) : "--" }}
          </div>
          <div class="a-label">{{ $t("home.myEarnings") }} (U)</div>
        </div>
        <div class="asset">
          <div class="a-value">{{ userStats ? fmtNum(userStats.depositTotal, 2) : "--" }}</div>
          <div class="a-label">入金 (U)</div>
        </div>
        <div class="asset">
          <div class="a-value">{{ userStats ? fmtCompact(userStats.power) : "--" }}</div>
          <div class="a-label">{{ $t("home.myPower") }}</div>
        </div>
      </div>
    </div>

    <!-- 每日分红：池内 1% 按当日算力独立结算，累计在合约内由用户自行提取 -->
    <DividendCard
      v-if="userStats"
      :pending="dividendStats ? dividendStats.pending : ''"
      :settleable="dividendStats?.settleable"
      :today-accrual="dividendStats?.todayAccrual"
      @refresh="refresh"
    />

    <!-- 买入额度 + 强制卖出进度（v9.1：买入消耗买额 1:1，与算力/提取解耦） -->
    <QuotaCard
      v-if="userStats"
      :buy-quota-left="userStats.buyQuotaLeft || '0'"
      :deposit-total="userStats.depositTotal"
      :stage="poolStats.stage"
      :force-sell="forceSellStats"
      @reinvest="goSwap"
    />

    <!-- v9.1：静态 2 倍 / 动态 5 倍出局进度 -->
    <ExitProgressCard v-if="userStats" :user="userStats" />

    <div class="foot-tip">{{ $t("home.tomorrowBurn") }}: 2% · {{ $t("home.unit") }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import WalletHeader from "../components/WalletHeader.vue";
import DataDashboard from "../components/DataDashboard.vue";
import QuotaCard from "../components/QuotaCard.vue";
import ExitProgressCard from "../components/ExitProgressCard.vue";
import DividendCard from "../components/DividendCard.vue";
import { usePoolData } from "../composables/usePoolData";
import { useWallet } from "../composables/useWallet";

const { poolStats, userStats, forceSellStats, dividendStats, loaded, error, refresh, fmtCompact, fmtNum } =
  usePoolData();
const { listenAccountChange } = useWallet();
const { t } = useI18n();
const router = useRouter();

let timer: ReturnType<typeof setInterval> | null = null;

/** v17：底池创建累计行（无 Creator 数据时整行隐藏） */
const creatorLine = computed(() => {
  const p = poolStats.value;
  const parts: string[] = [];
  if (p.creatorUsdtIn) parts.push(`${t("home.poolCreated")} ${fmtNum(p.creatorUsdtIn, 2)} U`);
  if (p.lpLocked) parts.push(`LP ${fmtCompact(p.lpLocked)}`);
  if (parts.length === 0) return "";
  parts.push(t("home.lpLocked"));
  return parts.join(" · ");
});

function goSwap() {
  router.push("/swap");
}

function fmtPrice(p: string): string {
  const v = parseFloat(p);
  if (isNaN(v)) return "0";
  if (v > 0 && v < 0.01) return v.toFixed(8);
  return v.toFixed(6);
}

onMounted(() => {
  refresh();
  listenAccountChange();
  timer = setInterval(() => refresh(), 30_000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped lang="scss">
.pool-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  .pool-card {
    background: var(--bg-card);
    border-radius: var(--radius-sm);
    padding: 12px 8px;
    text-align: center;
    .p-label {
      font-size: 11px;
      color: var(--text-secondary);
    }
    .p-value {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 6px 0 2px;
      word-break: break-all;
      &.price {
        color: var(--gold);
      }
    }
    .p-sub {
      font-size: 10px;
      color: var(--text-tertiary);
    }
  }
}
.stage-line {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  .stage {
    flex: 1;
    text-align: center;
    font-size: 11px;
    padding: 4px 0;
    border-radius: 12px;
    border: 1px solid var(--border);
    color: var(--text-tertiary);
    &.active {
      color: var(--gold);
      border-color: rgba(245, 193, 93, 0.5);
      background: rgba(245, 193, 93, 0.08);
    }
  }
}
.creator-line {
  margin-top: 10px;
  text-align: center;
  font-size: 11px;
  color: var(--text-tertiary);
}
.asset-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  .asset {
    text-align: center;
    .a-value {
      font-size: 17px;
      font-weight: 700;
      color: var(--text-primary);
      word-break: break-all;
      &.gold {
        color: var(--gold);
      }
    }
    .a-label {
      font-size: 10px;
      color: var(--text-secondary);
      margin-top: 4px;
    }
  }
}
.foot-tip {
  text-align: center;
  font-size: 11px;
  color: var(--text-tertiary);
  margin: 14px 0 20px;
}
.err-tip {
  text-align: center;
  font-size: 11px;
  color: var(--red-up, #e24b4a);
  margin-top: 10px;
}
</style>
