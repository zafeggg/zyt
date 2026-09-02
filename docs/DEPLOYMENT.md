# ZYT 众赢币 — 生产部署指南

> 从本地开发到生产上线的完整流程，涵盖架构、服务器、数据库、域名、进程管理、安全配置、监控与运维。
> 关联文档: docs/DEPLOYMENT_ONLINE.md（逐步骤操作手册）/ 众赢币(ZYT)_技术方案.md §8 / 众赢币(ZYT)_上线流程清单.md

---

## 一、架构总览

```
                       ┌──────────────┐
   用户浏览器 ──────────▶│   Nginx      │  :80/:443
                       │   (反向代理)   │
                       └──┬────────┬──┘
                          │        │
              ┌───────────▼─┐  ┌──▼───────────┐
              │  前端静态    │  │  keeper API   │
              │  :80/:443   │  │  :8080        │
              │  (Vue3 SPA) │  │  (链下服务)     │
              └─────────────┘  └──────┬────────┘
                                      │
                              ┌───────▼────────┐
                              │    MySQL       │
                              │    :3306       │
                              │  zyt_keeper    │
                              └────────────────┘
                                      │
                              ┌───────▼────────┐
                              │   BSC 区块链    │
                              │  chainId=56    │
                              │  9 合约 + 库    │
                              └────────────────┘
```

**三线工程**：
| 目录             | 内容                                  | 部署目标       |
| -------------- | ----------------------------------- | ---------- |
| `zyt-contracts` | 9 合约 + ZYTCompute 库（仅部署/验证用）        | 链上（无需服务器运行） |
| `zyt-dapp`      | Vue3 + Vant 前端（三语 i18n，ethers v6）    | 静态托管       |
| `zyt-keeper`    | indexer/ledger/keeper/monitor/forcesell/API | 24h 常驻进程   |

**keeper 模块职责**：索引器（事件轮询入库）/ 账本（重放重建用户状态）/ 快照机器人（每日 08:00 北京触发通缩与产出释放）/ 监控（R1-R5 规则引擎）/ 强制卖出追踪 / API（:8080 数据查询）。

---

## 二、服务器准备

### 2.1 最低配置

| 资源  | 要求                      |
| --- | ----------------------- |
| CPU | 2 核                     |
| 内存  | 4 GB                    |
| 磁盘  | 40 GB SSD               |
| 系统  | Ubuntu 22.04 / CentOS 8 |
| 带宽  | 5 Mbps                  |

> 前端可走 CDN 静态托管 + keeper 独立 24h 环境；keeper 不得跑在会休眠的本地机器上（testnet 已实证：Windows 夜间休眠导致进程冻结、快照漏触发）。

### 2.2 安装运行时

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# MySQL 8.0
sudo apt install -y mysql-server
sudo mysql_secure_installation

# Nginx
sudo apt install -y nginx

# Git
sudo apt install -y git

# PM2 (进程管理)
sudo npm install -g pm2

# 验证
node --version   # >= 22
mysql --version  # >= 8.0
nginx -v         # >= 1.18
```

---

## 三、数据库部署

### 3.1 创建数据库和用户

```sql
-- 登录 MySQL
sudo mysql -u root

-- 创建数据库
CREATE DATABASE zyt_keeper CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建专用用户 (避免用 root)
CREATE USER 'zyt_keeper_app'@'localhost' IDENTIFIED BY '你的强密码';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX ON zyt_keeper.* TO 'zyt_keeper_app'@'localhost';
FLUSH PRIVILEGES;
```

### 3.2 keeper 连接配置

编辑 `zyt-keeper/.env`：

```bash
DB_URL=mysql://zyt_keeper_app:你的强密码@127.0.0.1:3306/zyt_keeper
```

### 3.3 自动建表

keeper 启动时 `src/db.js` 幂等 DDL 自动建 7 张表（MySQL/SQLite 双后端自动适配），无需手动建表。首次启动后验证：

```sql
USE zyt_keeper;
SHOW TABLES;
-- 预期: events, users, snapshots, pool_state, keeper_runs, reconcile_results, force_sell
```

### 3.4 备份策略

```bash
# crontab 每天凌晨 3:00 备份
0 3 * * * mysqldump -u zyt_keeper_app -p密码 zyt_keeper | gzip > /backup/zyt_$(date +\%Y\%m\%d).sql.gz

# 保留最近 30 天
0 4 * * * find /backup/ -name "zyt_*.sql.gz" -mtime +30 -delete
```

---

## 四、域名与 DNS

### 4.1 域名规划

| 域名            | 指向            | 用途            |
| ------------- | ------------- | ------------- |
| `zyt.com`      | 前端托管IP/CDN    | 前端 DApp (SPA) |
| `api.zyt.com`  | keeper 服务器 IP  | keeper API     |

### 4.2 DNS 解析（示例）

```
A    zyt.com      → 前端托管IP（或 CDN CNAME）
A    api.zyt.com  → keeper 服务器IP
```

### 4.3 SSL 证书 (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx

# 申请证书
sudo certbot --nginx -d api.zyt.com

# 自动续期 (crontab)
0 0 * * * certbot renew --quiet
```

---

## 五、Nginx 配置

```nginx
# /etc/nginx/sites-available/zyt

# ===== 前端 SPA =====
server {
    listen 80;
    server_name zyt.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name zyt.com;

    ssl_certificate     /etc/letsencrypt/live/zyt.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/zyt.com/privkey.pem;

    root /opt/zyt/zyt/zyt-dapp/dist;
    index index.html;

    # SPA 路由：所有无扩展名路径 → index.html
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

# ===== keeper API =====
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

    # 健康检查不限流
    location /health {
        proxy_pass http://127.0.0.1:8080/health;
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/zyt /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

---

## 六、应用部署

### 6.1 目录结构

```
/opt/zyt/zyt/
├── zyt-contracts/     # (仅备份/验证用)
├── zyt-dapp/
│   └── dist/          # 前端构建产物
└── zyt-keeper/
    ├── src/           # indexer/ledger/keeper/monitor/forcesell/api
    ├── .env           # 生产环境配置
    ├── ecosystem.config.js
    └── node_modules/
```

### 6.2 拉取代码

```bash
sudo mkdir -p /opt/zyt/zyt
cd /opt/zyt/zyt
git clone 你的仓库地址/zyt.git .

# 或手动上传
scp -r F:\zyt\zyt-keeper   zyt@服务器IP:/opt/zyt/zyt/
scp -r F:\zyt\zyt-dapp      zyt@服务器IP:/opt/zyt/zyt/
scp -r F:\zyt\zyt-contracts zyt@服务器IP:/opt/zyt/zyt/   # 仅备份/验证用
```

### 6.3 安装依赖

```bash
cd /opt/zyt/zyt/zyt-keeper
npm install --production
```

### 6.4 生产环境配置

```bash
# zyt-keeper/.env (生产) —— 完整模板见 DEPLOYMENT_ONLINE.md 第五节
CHAIN_ID=56
RPC_URL=https://bsc-dataseed.binance.org

MINING_ADDR=0x待填
POOL_ADDR=0x待填
DEFLATION_ADDR=0x待填
CONFIG_ADDR=0x待填
ZYT_ADDR=0x待填
USDT_ADDR=0x55d398326f99059fF775485246999027B3197955
FORCESELL_ADDR=0x待填

SNAPSHOT_CRON=0 0 * * *
SNAPSHOT_CRON_TZ=UTC           # 北京 08:00，显式时区防漂移
KEEPER_PRIVATE_KEY=0x新钱包私钥  # 独立签名钱包，仅定时触发用

INDEXER_POLL_MS=30000
START_BLOCK=待填                 # 主网部署区块
BLOCK_RANGE=1000

API_PORT=8080
API_ADMIN_TOKEN=强随机串          # 管理端点鉴权
API_RATE_LIMIT=100
CORS_ORIGIN=https://zyt.com

DB_URL=mysql://zyt_keeper_app:强密码@127.0.0.1:3306/zyt_keeper
ALERT_WEBHOOK_URL=https://你的告警webhook
```

```bash
chmod 600 /opt/zyt/zyt/zyt-keeper/.env
```

### 6.5 PM2 进程管理

```bash
# ecosystem.config.js
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
```

```bash
# 创建日志目录
sudo mkdir -p /var/log/zyt && sudo chown -R zyt:zyt /var/log/zyt

# 启动
pm2 start ecosystem.config.js

# 设置开机自启
pm2 save
pm2 startup

# 常用命令
pm2 status           # 查看状态
pm2 logs zyt-keeper  # 查看日志
pm2 restart zyt-keeper
pm2 reload zyt-keeper  # 零停机重启
```

---

## 七、首次上线步骤

### 顺序执行，逐步验证

```bash
# 1. 服务器基础检查
node --version && mysql --version && nginx -v

# 2. 启动 MySQL
sudo systemctl start mysql && sudo systemctl enable mysql

# 3. 创建数据库与专用用户（见第三节）

# 4. 安装依赖
cd /opt/zyt/zyt/zyt-keeper && npm install --production

# 5. 启动 keeper (先验证)
cd /opt/zyt/zyt/zyt-keeper && node src/index.js
# 看到 chain=56 / ledger rebuild / keeper start tz=UTC / api start :8080 / reconcile ok 即成功, Ctrl+C 退出

# 6. PM2 启动
pm2 start /opt/zyt/zyt/zyt-keeper/ecosystem.config.js

# 7. 验证 API
curl http://localhost:8080/health
curl http://localhost:8080/stats
curl http://localhost:8080/user/0x用户地址

# 8. 启动 Nginx
sudo systemctl start nginx && sudo systemctl enable nginx

# 9. 验证外网访问
curl https://api.zyt.com/health
curl -I https://zyt.com/

# 10. 前端部署（构建 + 上传 + ?v= 缓存参数，见 DEPLOYMENT_ONLINE.md 第十节）
```

> ⚠️ 主网合约部署在应用部署**之前**完成（部署 → 字节码核对 → 参数核对 → bscscan 主网验证 → 白名单放行）；keeper START_BLOCK 用部署区块。

---

## 八、安全清单

| 检查项           | 操作                                        |
| ------------- | ----------------------------------------- |
| SSH 密钥登录     | 禁用密码登录，`PasswordAuthentication no`        |
| 防火墙          | `ufw allow 22,80,443/tcp`，封禁其他端口          |
| MySQL 远程访问   | `bind-address = 127.0.0.1`                 |
| 文件权限         | `chmod 600 .env`                           |
| 签名钱包私钥      | 独立钱包（仅定时触发），与资金完全隔离，不存大额资金               |
| 合约 owner      | 移交 Gnosis Safe 多签（营销 + 技术），单一 EOA 无权限   |
| CORS          | 生产改为前端域名                                   |
| HTTPS         | Let's Encrypt 证书 + HTTP→HTTPS 强制跳转          |
| API 限流        | 已内建 rateLimit + 管理端点鉴权（API_ADMIN_TOKEN）    |
| 日志脱敏         | 不打印 KEEPER_PRIVATE_KEY / 密码               |

---

## 九、监控与告警

### 9.1 健康检查端点

```bash
# /health 返回
{ "ok": true, "ts": 1788xxxx }
```

```bash
# 外部监控 (每60秒)
curl -f https://api.zyt.com/health || 发送告警
```

### 9.2 keeper 内置监控（5 规则）

| 规则 | 内容             | 默认阈值              |
| --- | -------------- | ----------------- |
| R1  | 底池突变           | poolUSDT 变化 >10%   |
| R2  | 大额卖出           | 单笔 > 池 5%          |
| R3  | 滑点跳变           | 档位跳变异常            |
| R4  | 索引延迟           | lastBlock 落后 >120  |
| R5  | 失败率            | 10min 窗口错误率 >30%  |

规则独立冷却（默认 10min）防告警风暴；告警走 ALERT_WEBHOOK_URL（上线前实测）。

### 9.3 关键指标

| 指标         | 命令                                   | 告警阈值                |
| ---------- | ------------------------------------ | ------------------- |
| keeper 存活  | `pm2 status`                         | 进程不存在               |
| API 响应    | `curl -w "%{time_total}" /health`    | > 3s                |
| 索引器延迟     | keeper 日志 R4 / `events` 表最大块高       | last_block 落后 >120 |
| 快照触发      | `SELECT day FROM snapshots ORDER BY day DESC LIMIT 1` | 当日无记录 = P0   |
| 对账        | `reconcile_results` 表                 | status != ok       |
| 磁盘使用      | `df -h /`                             | > 80%               |
| 内存使用      | `free -m`                             | < 500M 可用          |

### 9.4 日志管理

```bash
# PM2 日志轮转
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 30
```

---

## 十、运维手册

### keeper 重启 / 索引器重建

```bash
# 正常重启
pm2 restart zyt-keeper

# 索引器/账本数据异常 → 清空后从链上重放（events 为唯一事实源）
pm2 stop zyt-keeper
mysql -u zyt_keeper_app -p zyt_keeper -e "
  TRUNCATE events; TRUNCATE users; TRUNCATE pool_state;
  TRUNCATE snapshots; TRUNCATE reconcile_results; TRUNCATE force_sell;"
# .env START_BLOCK：若在 RPC 历史窗口内用部署区块，否则用最新块
pm2 start zyt-keeper
# 验证: ledger rebuild users=N / reconcile ok
```

### 手动补快照

```bash
cd /opt/zyt/zyt/zyt-keeper
timeout 120 node scripts/snapshot-now.js   # 手动触发当日快照（补快照用）
# 注意: 脚本因 ethers provider 轮询不自动退出，用 timeout 或跑完手动终止
```

### 多签操作（参数调整优先走多签）

```bash
# 调整 keeperAddress / 买入白名单 / 滑点档位 / 阶段阈值 / 通缩底线
# 在 Gnosis Safe 界面构造交易 → 多签确认 → 链上执行
# 执行后立即验证: eth_call 读取新值 + keeper 日志无异常
```

### 扩容

```bash
# keeper 单实例即可（互斥锁防多实例重复快照；多实例需 Redis 锁）
# 如需多实例: 配置 REDIS_URL 启用 SETNX 原子锁后 pm2 scale zyt-keeper 2
```

---

## 十一、上线检查清单

上线前逐项确认:

- [ ] MySQL zyt_keeper 已创建，7 张表自动建好
- [ ] 合约 9 个地址确认无误（与链上部署一致，bscscan 主网验证 9/9）
- [ ] `START_BLOCK` 正确（= 部署区块）
- [ ] `.env` 权限 600，生产新签名钱包（非 testnet/本地）
- [ ] owner 已移交 Gnosis Safe 多签；keeperAddress 已注册
- [ ] 买入白名单/滑点/阶段阈值按策略配置并核对
- [ ] Nginx HTTPS 已配置，HTTP→HTTPS 跳转
- [ ] CORS 已限制；API_ADMIN_TOKEN 已配置
- [ ] PM2 开机自启
- [ ] 健康检查端点外网可访问
- [ ] 数据库备份 cron 已配置
- [ ] SSL 自动续期已配置
- [ ] 前端能正常打开并连接钱包（BSC 主网 chainId 校验）
- [ ] 前端 `?v=` 缓存参数已更新
- [ ] keeper 日志无持续错误；reconcile diff=0
- [ ] 每日 08:00 快照连续验证 3 日无漏

---

> 文档版本: v1.0 (2026-09-02) ｜ 仿照 GYT docs/DEPLOYMENT.md 结构编制 ｜ 主网部署后回填合约地址与 START_BLOCK
