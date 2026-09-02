# ZYT 众赢币 — 生产部署上线操作手册

> 适用项目: ZYT 众赢币 (基于 BSC 公链 chainId=56)  
> 版本: v1.0 (2026-09-02) | 状态: 待执行  
> 本文档为纯操作指引，每一步均包含「做什么 / 怎么做 / 怎么验证」。执行时按顺序逐项完成并勾选。
> 关联文档: 众赢币(ZYT)_技术方案.md §8 / 众赢币(ZYT)_上线流程清单.md / docs/DEPLOYMENT.md

---

## 〇、上线前信息清单 (先准备好再动手)

| 项目             | 当前值 (主网部署后填写)                                | 说明                                     |
| ---------------- | ------------------------------------------------- | -------------------------------------- |
| 前端托管          | **待定**（独立域名/CDN，不使用 GYT 服务器）                  | 前端 SPA 静态托管方案需在上线前确定                  |
| 域名             | 待定 (示例: zyt.com / api.zyt.com)                  | 前端 + keeper API 各一个域名                  |
| BSC RPC         | `https://bsc-dataseed.binance.org`               | BSC 主网 RPC（备选 bsc-dataseed1/2）         |
| BSC ChainId     | `56`                                             |                                          |
| ZYTConfig       | `待部署`                                           | 主网部署后填入                               |
| GSTToken        | `待部署`                                           |                                          |
| ZYTToken        | `待部署`                                           |                                          |
| ZYTForceSell    | `待部署`                                           |                                          |
| ZYTPoolManager  | `待部署`                                           |                                          |
| ZYTReferral     | `待部署`                                           |                                          |
| ZYTCompute(库)   | `待部署`                                           |                                          |
| ZYTMining       | `待部署`                                           | 构造含库链接 ZYTCompute                     |
| ZYTDeflation    | `待部署`                                           |                                          |
| 部署者地址         | `待部署`                                           | 临时 owner；上线前移交 Gnosis Safe 多签         |
| 多签 Safe        | `待创建` (营销 + 技术 2/3 多签)                        | owner 唯一管理方                            |
| keeperAddress   | `待设置`（签名钱包，与资金完全隔离）                          | 仅触发 dailySnapshot，无资金权限               |
| 买入白名单         | `待设置`（poolStage1USDT=0 决策 A 下初始即 stage2）        | 多签管理                                  |
| 索引器起始块        | `待填`（= 合约部署区块，用 find-deploy-blocks 类脚本复核）      | keeper .env START_BLOCK                |
| 签名钱包私钥        | **生产必须新建独立钱包**                                  | ⚠️ 不要沿用 testnet/本地的私钥                   |

---

## 一、服务器初始化（若采用自托管）

**做什么**: 拿到一台干净的 Ubuntu 22.04 服务器，完成基础安全配置。（若前端走 CDN 静态托管、keeper 用其他 24h 运行环境，跳过本节但保留安全基线。）

**怎么做**:

```bash
# 1. SSH 登录服务器
ssh root@你的服务器IP

# 2. 系统更新
apt update && apt upgrade -y

# 3. 创建部署专用用户 (非 root)
adduser zyt
usermod -aG sudo zyt
su - zyt

# 4. 配置 SSH 密钥登录 (本地执行)
ssh-keygen -t ed25519
ssh-copy-id zyt@你的服务器IP

# 5. 禁止 root 密码登录 (服务器执行)
sudo sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# 6. 防火墙
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

**怎么验证**:

```bash
sudo ufw status verbose        # 22/80/443 为 ALLOW
exit                           # 退出后重新用密钥登录，密码登录应被拒绝
```

---

## 二、安装运行时 (Node / MySQL / Nginx / PM2)

**做什么**: 安装 keeper 与前端所需的全部运行时环境。

**怎么做**:

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# MySQL 8.0 (keeper 持久化)
sudo apt install -y mysql-server
sudo systemctl start mysql && sudo systemctl enable mysql
sudo mysql_secure_installation    # 设置 root 密码并移除匿名用户

# Nginx (前端静态 + API 反代)
sudo apt install -y nginx
sudo systemctl start nginx && sudo systemctl enable nginx

# Git
sudo apt install -y git

# PM2 进程管理
sudo npm install -g pm2

# SSL 工具
sudo apt install -y certbot python3-certbot-nginx
```

**怎么验证**:

```bash
node --version   # v22.x
mysql --version  # 8.0.x
nginx -v         # 1.18+
pm2 -v
```

---

## 三、创建数据库

**做什么**: 创建 `zyt_keeper` 数据库和专用应用账号 (不用 root 连接 keeper)。

**怎么做**:

```bash
sudo mysql -u root -p
```

```sql
-- 创建数据库
CREATE DATABASE zyt_keeper CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建应用专用账号（最小权限：仅本库）
CREATE USER 'zyt_keeper_app'@'localhost' IDENTIFIED BY '请设置强密码';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX ON zyt_keeper.* TO 'zyt_keeper_app'@'localhost';
FLUSH PRIVILEGES;

-- 验证
USE zyt_keeper;
SHOW TABLES;   -- 此时应为空 (keeper 启动后自动建表)
EXIT;
```

**怎么验证**:

```bash
mysql -u zyt_keeper_app -p -e "SELECT 1;"   # 能连接即成功
```

> 说明: keeper 的 `src/db.js` 启动时执行幂等 DDL 自动建 7 张表 (events, users, snapshots, pool_state, keeper_runs, reconcile_results, force_sell)，无需手动建表。

---

## 四、上传项目代码

**做什么**: 把本地三线项目 (zyt-contracts / zyt-dapp / zyt-keeper) 放到服务器工作目录（如 `/opt/zyt/zyt`）。

**怎么做**:

```bash
sudo mkdir -p /opt/zyt/zyt && sudo chown -R zyt:zyt /opt/zyt/zyt
```

```bash
# 方式 A: git clone (推荐)
cd /opt/zyt/zyt
git clone 你的仓库地址/zyt.git .

# 方式 B: scp 上传 (仅上传运行所需目录)
scp -r F:\zyt\zyt-keeper   zyt@服务器IP:/opt/zyt/zyt/
scp -r F:\zyt\zyt-dapp      zyt@服务器IP:/opt/zyt/zyt/
scp -r F:\zyt\zyt-contracts zyt@服务器IP:/opt/zyt/zyt/   # 仅备份/验证用，无需运行
```

> ⚠️ 注意: 本地 `.env` 内含明文私钥，**上传前先删除或替换**；`node_modules`、`.git`、`artifacts`、`cache` 无需上传。

**怎么验证**:

```bash
ls /opt/zyt/zyt/                          # zyt-keeper / zyt-dapp / zyt-contracts 目录
ls /opt/zyt/zyt/zyt-keeper/src/index.js   # keeper 入口存在
```

---

## 五、keeper 生产配置

**做什么**: 安装 keeper npm 依赖，写入生产环境 `.env`。

**怎么做**:

```bash
cd /opt/zyt/zyt/zyt-keeper
npm install --production
```

```bash
# 创建生产 .env
vi /opt/zyt/zyt/zyt-keeper/.env
```

```env
# ============ 链 (BSC 主网) ============
CHAIN_ID=56
RPC_URL=https://bsc-dataseed.binance.org

# ============ 合约地址 (与主网部署记录一致) ============
MINING_ADDR=0x待填
POOL_ADDR=0x待填
DEFLATION_ADDR=0x待填
CONFIG_ADDR=0x待填
ZYT_ADDR=0x待填
USDT_ADDR=0x55d398326f99059fF775485246999027B3197955   # BSC 主网 USDT
FORCESELL_ADDR=0x待填

# ============ 快照定时 (北京 08:00 = UTC 0 点，tz 显式指定) ============
SNAPSHOT_CRON=0 0 * * *
SNAPSHOT_CRON_TZ=UTC
RETRY_TIMES=3
RETRY_DELAY_MS=30000

# ============ 签名钱包 (写交易) ============
# ⚠️ 生产必须新建独立钱包！仅作 dailySnapshot 定时触发器，无资金权限
KEEPER_PRIVATE_KEY=0x新钱包私钥

# ============ 索引器 ============
INDEXER_POLL_MS=30000
START_BLOCK=待填(主网部署区块)
BLOCK_RANGE=1000

# ============ API ============
API_PORT=8080
# ⚠️ 生产必须配置管理端点鉴权（/reconcile 等），留空 = 端点禁用(403)
API_ADMIN_TOKEN=请设置强随机串
API_RATE_LIMIT=100
CORS_ORIGIN=https://你的前端域名

# ============ 存储 (MySQL 专用账号) ============
DB_URL=mysql://zyt_keeper_app:强密码@127.0.0.1:3306/zyt_keeper

# ============ 告警 (群机器人 webhook) ============
ALERT_WEBHOOK_URL=https://你的告警webhook

# ============ 监控规则 (默认即可，按需调参) ============
MONITOR_ENABLED=true
FORCESELL_ENABLED=true
```

```bash
# 收紧 .env 权限 (含私钥)
chmod 600 /opt/zyt/zyt/zyt-keeper/.env
```

**怎么验证**:

```bash
cd /opt/zyt/zyt/zyt-keeper && node src/index.js
# 期望输出: service start chain=56 / ledger rebuild users=N /
#           keeper start cron="0 0 * * *" tz=UTC / api start :8080 / reconcile ok
# 验证后 Ctrl+C 停止
curl http://localhost:8080/health      # {"ok":true,...}
curl http://localhost:8080/stats       # pool_state + 最近快照
```

---

## 六、首次全量数据同步

**做什么**: keeper 启动时自动从 `START_BLOCK` 重放链上事件并重建账本（幂等），随后索引器增量续跑。

**怎么做**:

```bash
cd /opt/zyt/zyt/zyt-keeper
node src/index.js
# 观察日志: indexer initial sync +N events → ledger rebuild users=N → reconcile ok
# 首次同步耗时取决于 START_BLOCK 到当前高度的数据量
```

**怎么验证**:

```bash
mysql -u zyt_keeper_app -p zyt_keeper -e "
  SELECT COUNT(*) AS events FROM events;
  SELECT COUNT(*) AS users FROM users;
"
# events 应有全量历史事件；reconcile 日志 diff=0（链上 userList 与链下账本一致）
```

> 注意（testnet 已实证）: 公共 RPC（publicnode 类）对 BSC 的历史 getLogs 窗口仅数小时——**若停机超过该窗口，重启前必须把 START_BLOCK 推到最新块**（历史事件已在 events 表则无损）；主网建议使用自建 full node 或付费 RPC 以获得完整历史。

---

## 七、PM2 守护 keeper

**做什么**: 用 PM2 管理 keeper 进程，崩溃自动重启 + 开机自启（保持每日 08:00 快照触发可靠）。

**怎么做**:

```bash
# 创建 PM2 配置
cat > /opt/zyt/zyt/zyt-keeper/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'zyt-keeper',
    cwd: '/opt/zyt/zyt/zyt-keeper',
    script: 'src/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '500M',
    error_file: '/var/log/zyt/keeper-error.log',
    out_file: '/var/log/zyt/keeper-output.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
EOF

# 日志目录
sudo mkdir -p /var/log/zyt && sudo chown -R zyt:zyt /var/log/zyt

# 启动 + 开机自启
cd /opt/zyt/zyt/zyt-keeper
pm2 start ecosystem.config.js
pm2 save
pm2 startup    # 按输出提示执行 sudo 命令
```

**怎么验证**:

```bash
pm2 status                  # zyt-keeper 状态 online
pm2 logs zyt-keeper         # 查看启动日志
curl http://localhost:8080/health
```

---

## 八、域名与 SSL 证书

**做什么**: DNS 解析 + HTTPS 证书。

**怎么做**:

1. 在域名服务商后台添加解析 (示例域名):
   ```
   A    zyt.com      → 前端托管IP（或 CDN CNAME）
   A    api.zyt.com  → keeper 服务器IP
   ```
2. 申请证书 (Nginx 插件会自动改配置):
   ```bash
   sudo certbot --nginx -d api.zyt.com
   ```
3. 验证自动续期:
   ```bash
   sudo certbot renew --dry-run
   ```

**怎么验证**:

```bash
dig api.zyt.com +short      # 返回服务器 IP
curl -I https://api.zyt.com # 返回 200 且证书有效
```

---

## 九、Nginx 反向代理配置

**做什么**: 前端静态托管 (SPA) + keeper API 代理 + HTTPS。

**怎么做**:

```bash
sudo vi /etc/nginx/sites-available/zyt
```

```nginx
# ===== 前端 SPA (zyt.com) =====
server {
    listen 80;
    server_name zyt.com;
    return 301 https://$host$request_uri;    # HTTP 强制跳 HTTPS
}

server {
    listen 443 ssl;
    server_name zyt.com;

    ssl_certificate     /etc/letsencrypt/live/zyt.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/zyt.com/privkey.pem;

    root /opt/zyt/zyt/zyt-dapp/dist;
    index index.html;

    # SPA 路由回退
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 静态资源缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|webp)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # 安全头
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}

# ===== keeper API (api.zyt.com) =====
server {
    listen 80;
    server_name api.zyt.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name api.zyt.com;

    ssl_certificate     /etc/letsencrypt/live/api.zyt.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.zyt.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;      # 链上查询慢，放宽超时
        proxy_connect_timeout 10s;
    }

    location /health {
        proxy_pass http://127.0.0.1:8080/health;   # 健康检查豁免限流
    }
}
```

```bash
# 启用配置
sudo ln -s /etc/nginx/sites-available/zyt /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

**怎么验证**:

```bash
curl https://api.zyt.com/health          # 返回 {"ok":true,...}
curl -I https://zyt.com/                 # 200
```

---

## 十、前端构建与部署

**做什么**: 构建 Vue3 前端生产产物并部署，配置 keeper API 地址与缓存参数。

**怎么做**:

```bash
# 1. 生产构建 (本地，非沙箱)
cd F:/zyt/zyt-dapp
npx vite build
# 产物输出到 dist/

# 2. 上传 dist 到服务器
scp -r F:\zyt\zyt-dapp\dist zyt@服务器IP:/opt/zyt/zyt/zyt-dapp/

# 3. 更新 index.html 的 ?v=YYYYMMDDxx 缓存参数（每次上传必须递增，防浏览器旧缓存）
#    API 地址注入：在 index.html 或构建配置中设置 keeper API base（前端已实现
#    apiBase + 合约直连降级，生产指向 https://api.zyt.com）
```

**怎么验证**:

- 浏览器打开 `https://zyt.com`，F12 → Network：资源加载版本号正确（无旧缓存）；`/api/*` 请求指向 `api.zyt.com` 且 200。
- 前端 API 不可用时自动降级为合约直连（观察 Network 有 eth_call 直连请求）。

---

## 十一、端到端上线验证

**做什么**: 模拟真实用户走完整链路。

**怎么做 / 验证**:

| # | 验证项        | 操作                                                                     | 期望结果                                               |
| - | ----------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| 1 | keeper 健康   | `curl https://api.zyt.com/health`                                       | `ok: true`                                         |
| 2 | 池状态        | `curl https://api.zyt.com/stats`                                        | pool_state 数值与链上一致；快照记录存在                         |
| 3 | 链上合约       | bscscan 打开 9 合约地址（主网已源码验证）                                      | 均显示 Contract Verified                            |
| 4 | 字节码一致性     | `cd zyt-contracts && npx hardhat run scripts/probe-bytecode.js --network bsc` | 线上 = 本地（库链接占位符差异属正常）                            |
| 5 | 前端页面       | 浏览器打开 `https://zyt.com`                                               | 页面正常渲染，三语切换正常                                    |
| 6 | 钱包连接       | MetaMask/TokenPocket 连接；主网 chainId=56 校验                            | 钱包显示已连接 + 网络为 BSC 主网                             |
| 7 | 读链路        | 首页查看池状态/价格/阶段/滑点档位                                                | 与 keeper API / 链上一致                               |
| 8 | 写链路        | USDT 授权 → 入金（小额）→ 算力/产出/分红领取 → 卖出 → 转账                              | 交易走钱包签名上链；数值符合模型（入金×5 额度、2 倍出局、10% 转账税）        |
| 9 | 快照触发       | 观察次日 08:00 后：`SELECT * FROM snapshots ORDER BY day DESC LIMIT 3`       | 当日快照存在；通缩 2% 生效；对账 diff=0                        |
| 10 | 对账          | keeper 日志 / `reconcile_results` 表                                      | status=ok, diff_users=0                            |
| 11 | CORS/限流     | 从 zyt.com 页面观察 API 请求；连续高频请求                                      | 无跨域报错；超限返回 429                                 |
| 12 | 重启恢复       | `pm2 restart zyt-keeper`                                                | 自动拉起，账本重建一致，无重复事件                               |

---

## 十二、监控与备份

**做什么**: 数据库每日备份 + 日志轮转 + 健康检查告警 + keeper 5 规则监控。

**怎么做**:

```bash
# 1. 数据库每日备份 (crontab -e)
0 3 * * * mysqldump -u zyt_keeper_app -p密码 zyt_keeper | gzip > /backup/zyt_$(date +\%Y\%m\%d).sql.gz
0 4 * * * find /backup -name "zyt_*.sql.gz" -mtime +30 -delete

# 2. PM2 日志轮转
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 30

# 3. 外部监控 (每 60s，失败发告警)
*/1 * * * * curl -fsS https://api.zyt.com/health || curl -fsS -X POST 你的告警webhook
```

**keeper 内置监控（5 规则，已在启动时启用）**:
- R1 底池突变（>10%）/ R2 大额卖出（>5%）/ R3 滑点跳变 / R4 索引延迟（>120 块）/ R5 失败率（>30%，10min 窗口）
- 告警 webhook 上线前实测一次（发测试告警确认可达）

**关键指标阈值**: 磁盘 >80% / 内存 <500M / 索引器落后 >120 块 / API 响应 >3s / **每日 08:00-08:10 快照必须完成**（未完成 = P0）。

---

## 十三、安全上线检查清单 (逐项勾选)

- [ ] 服务器: root 密码登录已禁用，仅密钥登录
- [ ] 防火墙: 仅开放 22/80/443
- [ ] 数据库: 专用账号 `zyt_keeper_app`，非 root；`bind-address=127.0.0.1`
- [ ] `.env`: 生产新签名钱包私钥（非 testnet/本地私钥），权限 `chmod 600`
- [ ] 合约地址: 与链上实际部署一致（9 合约 + 库；可用 probe 脚本复核）
- [ ] `START_BLOCK` 正确（= 部署区块，勿小于实际部署块）
- [ ] 多签: owner 已移交 Gnosis Safe（营销 + 技术），单一 EOA 无管理权限
- [ ] keeperAddress: 已注册签名钱包地址，且与资金钱包隔离
- [ ] 买入白名单: 按阶段策略配置完毕（决策 A：初始 stage2，额度 1:1）
- [ ] CORS: 已限制为前端域名
- [ ] `API_ADMIN_TOKEN` 已配置（/reconcile 等管理端点）
- [ ] HTTPS: 证书有效，HTTP 强制跳转 HTTPS
- [ ] PM2: 开机自启已配置 (`pm2 startup` + `pm2 save`)
- [ ] 数据库备份 cron 已生效
- [ ] SSL 自动续期 cron 已生效 (`certbot renew --dry-run` 通过)
- [ ] bscscan 主网源码验证 9/9（`--network bsc`）
- [ ] 前端 `?v=` 缓存参数已更新，API 指向生产域名
- [ ] 全量同步完成，索引器增量正常，reconcile diff=0
- [ ] 端到端验证 12 项全部通过
- [ ] 签名钱包仅作定时触发器，不存放资金

---

## 附录 A: 常用运维命令速查

```bash
# keeper 进程
pm2 status                     # 进程状态
pm2 logs zyt-keeper            # 实时日志
pm2 restart zyt-keeper         # 重启
pm2 reload zyt-keeper          # 零停机重载

# keeper API
curl http://localhost:8080/health            # 健康
curl http://localhost:8080/stats             # 池状态 + 最近快照
curl http://localhost:8080/user/0x...        # 用户数据
curl http://localhost:8080/force-sell/0x...  # 强制卖出窗口

# 索引器/账本
cd /opt/zyt/zyt/zyt-keeper
node scripts/snapshot-now.js   # 手动触发快照（补快照；注意进程不退出需 Ctrl+C / timeout）

# Nginx / SSL
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew             # 手动续期证书

# 本地模式（当前 ZYT 策略：keeper 本地运行）
cd F:/zyt/zyt-keeper && node src/index.js
netstat -ano | grep ":8080"    # 端口占用排查（启动前确认无残留）
```

## 附录 B: 回滚预案

```bash
# keeper 回滚到上一版本
cd /opt/zyt/zyt/zyt-keeper && git log --oneline -3
pm2 stop zyt-keeper && git checkout 上一版本commit
npm install --production && pm2 restart zyt-keeper

# 索引器/账本数据异常 → 清空重建（events 为唯一事实源，从链上重放）
pm2 stop zyt-keeper
mysql -u zyt_keeper_app -p zyt_keeper -e "
  TRUNCATE events; TRUNCATE users; TRUNCATE pool_state;
  TRUNCATE snapshots; TRUNCATE reconcile_results; TRUNCATE force_sell;"
# 将 .env START_BLOCK 改回部署区块（若在 RPC 历史窗口内）或最新块，再启动
pm2 start zyt-keeper
# 验证: ledger rebuild users=N / reconcile ok

# 快照触发失败（连续 2 日未触发 = P0）
node scripts/snapshot-now.js    # 手动补快照
# 排查: keeper 进程存活? RPC 可达? keeperAddress 权限? lock 是否残留?
```

**合约回滚（不可升级合约，无现场回滚）**——预案链：
1. **止血**: 多签触发合约 pause（如具备）/ 停止入金相关入口。
2. **评估**: 确认问题范围（参数错误 / 功能缺陷 / 资金风险）。
3. **迁移**: 部署修复版新合约 → 前端/keeper 切地址 → 按链上状态迁移资金与用户余额（底池、动态额度、待领分红逐项核对）。
4. **公告**: 迁移方案与时间表同步用户。
5. 可配置项（keeperAddress / 买入白名单 / 滑点档位 / 阶段阈值 / 通缩底线）**优先用多签调整**，避免合约级迁移。

> 文档版本: v1.0 (2026-09-02) ｜ 仿照 GYT docs/DEPLOYMENT_ONLINE.md 结构编制 ｜ 主网部署后回填"上线前信息清单"
