<template>
  <div class="records">
    <WalletHeader />
    <div class="panel">
      <div class="panel-title">{{ $t("records.title") }}</div>
      <van-empty v-if="records.length === 0" :description="$t('records.empty')" />
      <van-cell-group v-else inset>
        <van-cell v-for="(r, i) in records" :key="i" :title="typeText(r.type)" :label="r.time">
          <template #value>
            <span :class="r.type === 'sell' ? 'out' : 'in'">{{ r.type === "sell" ? "-" : "+" }}{{ r.amount }}</span>
          </template>
        </van-cell>
      </van-cell-group>
    </div>
    <div class="panel">
      <div class="panel-title">{{ $t("records.burn") }}</div>
      <van-empty :description="$t('records.empty')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import WalletHeader from "../components/WalletHeader.vue";

const { t } = useI18n();
// MVP：本地交易记录（接入 indexer 后改为链上事件聚合）
interface Row {
  type: string;
  amount: string;
  time: string;
}
const records = ref<Row[]>([]);

function typeText(type: string): string {
  const map: Record<string, string> = {
    deposit: t("records.deposit"),
    sell: t("records.sell"),
    reward: t("records.reward"),
    dividend: t("records.dividend"),
    refReward: t("records.refReward"),
  };
  return map[type] || type;
}
</script>
