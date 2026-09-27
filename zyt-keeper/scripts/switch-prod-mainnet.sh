#!/bin/bash
# ============================================================
# ZYT keeper 切换到主网正式版 v9.1（2026-09-26）
#
# 用途：把 /opt/zyt/zyt-keeper/.env 从测试链 v9.1 切到主网正式版，
#       并替换 keeper 私钥（此前为 42 字符占位值）。
# 特性：幂等（可重复执行，结果一致）；先备份；不触碰 DB_URL（见末尾提示）。
#
# 用法：
#   bash switch-prod-mainnet.sh           # 执行切换
#   bash switch-prod-mainnet.sh --check   # 只打印当前 .env 状态，不修改
#
# 前置（需先手动建库，见文件末尾的 SQL 提示）。
# ============================================================
set -euo pipefail
cd /opt/zyt/zyt-keeper

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if [ ! -f .env ]; then
  echo "❌ 找不到 /opt/zyt/zyt-keeper/.env"; exit 1
fi

show_env() {
  echo "---- 当前 .env 关键值（私钥脱敏）----"
  grep -E "^(CHAIN_ID|RPC_URL|START_BLOCK|BLOCK_RANGE|CONFIG_ADDR|ZYT_ADDR|POOL_ADDR|MINING_ADDR|DEFLATION_ADDR|FORCESELL_ADDR|REFERRAL_ADDR|CREATOR_ADDR)=" .env || echo "(以上键均未设置)"
  grep -E "^KEEPER_PRIVATE_KEY=" .env | awk -F= '{v=$2; if (length(v)==66) print "KEEPER_PRIVATE_KEY=<66字符 ✓>"; else print "KEEPER_PRIVATE_KEY=<" length(v) "字符 ⚠ 应为66>" }'
  grep -E "^DB_URL=" .env | sed 's|:[^:@/]*@|:***@|' | sed 's/^/  /'
  echo "--------------------------------------"
}

show_env
if [ "$CHECK_ONLY" = "1" ]; then exit 0; fi

echo
echo "【1/4】备份 .env"
cp -n .env .env.bak-testnet-20260926 2>/dev/null || cp .env .env.bak-testnet-20260926-$(date +%H%M%S)
ls -la .env.bak-testnet-20260926* | tail -2

echo
echo "【2/4】写入主网正式版配置"
upsert() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    echo "$1=$2" >> .env
  fi
}

upsert CHAIN_ID 56
upsert RPC_URL "https://bsc.blockrazor.xyz"
upsert START_BLOCK 124125000
upsert BLOCK_RANGE 25
upsert BATCH_DELAY_MS 1200
upsert CONFIG_ADDR "0x4FEFe79A90Bf7C9BD2699030Ee1ad0360f4B1B22"
upsert ZYT_ADDR "0xa64E6ab9A8a61f55eE9B1521312783AE033fd546"
upsert POOL_ADDR "0x57d8Ec0D9Ef0822dFc5D08Db686D182351580028"
upsert MINING_ADDR "0x0119cf2eac935447f2Dd60C457190fAEa116fd22"
upsert DEFLATION_ADDR "0xF44fE232d26F4E845Be75960bc0a65aB12898D73"
upsert FORCESELL_ADDR "0xaE0EeD16e6f7ca4736294a6c2E4a5b87d02672C8"
upsert REFERRAL_ADDR "0x43018AF273296064991c018955c636fB45eB0dad"
upsert CREATOR_ADDR "0x41799040658764d91C94AF16b8B461f2fc1A040F"

echo
echo "【3/4】替换 keeper 私钥（0x4b83dfdc…，对应链上 keeperAddress 0x09BeD12b…）"
upsert KEEPER_PRIVATE_KEY "0x4b83dfdcf31b9387a09d008a56898b8676e6726936c57a247c8f879dbe10cee7"
# 校验：私钥必须 66 字符
awk -F= '/^KEEPER_PRIVATE_KEY=/{ if (length($2)!=66) { print "❌ 私钥长度异常: " length($2); exit 1 } else print "✓ 私钥长度 66" }' .env

echo
echo "【4/4】写入后状态"
show_env

echo "✅ .env 切换完成。剩余两步："
echo
echo "  ① 建生产库（需 sudo，只执行一次）："
echo "     sudo mysql"
echo "       CREATE DATABASE IF NOT EXISTS zyt_keeper_prod CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
echo "       GRANT ALL PRIVILEGES ON zyt_keeper_prod.* TO 'zyt_keeper_app'@'localhost';"
echo "       FLUSH PRIVILEGES;"
echo "     exit"
echo
echo "  ② 把 DB_URL 的库名从当前库改为 zyt_keeper_prod（命令末尾提示了当前指向），然后："
echo "     pm2 restart zyt-keeper && sleep 40 && tail -12 ~/.pm2/logs/zyt-keeper-out.log"
echo "     期望看到: indexer: ok initial sync ... | reconcile: ok ... | monitor: ok ..."
echo
echo "  回滚：cp .env.bak-testnet-20260926 .env && pm2 restart zyt-keeper"
