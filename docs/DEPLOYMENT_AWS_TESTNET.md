# ZYT 众赢币 — AWS 测试链部署流程

> **适用场景**：合约已部署在 BSC 测试链（chainId 97，第十套 v9.1），需要把链下服务（keeper）与前端（dapp）部署到 AWS Ubuntu 服务器，供测试与演示使用。  
> **与主网部署的三处关键差异**：链参数走 testnet；USDT 用 Mock 代币；keeper 签名钱包必须复用已登记在合约里的地址，不能用新钱包。  
> **关联文档**：`docs/DEPLOYMENT_AWS_MAINNET.md`（主网正式版部署流程，含需替换项清单）/ `docs/主网上线防复发检查清单.md` / `zyt-keeper/deploy/nginx-zyt.conf`  
> **编制日期**：2026-09-25

---

## 〇、前置信息清单

动手前先把下面两张表填齐。缺任何一项都会在后续卡住。


### 0.1 链侧信息（测试链，已确认值）

| 项                   | 值                                                     |
| ------------------- | ----------------------------------------------------- |
| 网络                  | BSC Testnet                                           |
| chainId             | 97                                                    |
| RPC                 | `https://bsc-testnet-rpc.publicnode.com`              |
| 合约套件                | 第十套 v9.1（2026-09-24，双计修复版）                            |
| USDT 口径             | MockUSDT（非官方 USDT）                                    |
| ZYTConfig           | `0x8402D46f5974301028Ee461d485748b71b0dc487`          |
| ZYTToken            | `0x9D434F75564410d6e41664716defEd92d95985C1`          |
| ZYTPoolManager      | `0x36fa17d24dD706c5a9F61e4Afb47eD3C357b349e`          |
| ZYTMining           | `0x7e3507050db25AD09f2D772Df72C4bea3bae0b04`          |
| ZYTDeflation        | `0x80a98C926755604A5582289eecd3eB25C816EF8b`          |
| ZYTForceSell        | `0xCC89c59Cc9b47C7D32545F8f53E0633d3e01a90D`          |
| ZYTReferral         | `0xf6Fa72Dd11E0426419D3c3aA75e91730E75B0C4C`          |
| ZYTLiquidityCreator | `0x9bFccB1ADb2da1d634aC9CF426e5e276754a6F74`          |
| MockUSDT            | `0x33F797D0cC0a5462809c957641A09B37FeeFF41A`          |
| Pair（ZYT/USDT）      | `0xc16B3D23fc1C923EA35fBbfc6B4f1d54dbcAB0aa`          |
| 部署者地址               | `0xB7233A003C37Beb100C4eFCF82793D24B90179F9`          |
| keeper 签名地址         | `0x09BeD12b5956E1E53668Aa10E242766E3aE3B641`          |
| 索引起点块               | `132873780`（部署块 132873786 前 6 块）                      |
| 部署记录文件              | `zyt-contracts/deployments/bscTestnet-20260924.json` |

> **keeper 钱包必须复用**。`0x09BeD12b...` 已写进 `ZYTConfig.keeperAddress` 与 `ZYTForceSell.keeper`，换成新钱包后每日快照交易会被合约拒绝。该地址需要持有测试链 BNB 支付 gas，部署记录里记为 0.05 BNB。

### 0.2 服务器侧信息（待填）

| 项       | 填什么                                    |
| ------- | -------------------------------------- |
| AWS 区域  | 建议选 `ap-southeast-1`（新加坡）或 `us-east-1` |
| 实例类型    | t3.small（2 核 2G）                       |
| 操作系统    | Ubuntu Server 24.04 LTS                |
| 弹性 IP   | 分配后关联实例                                |
| 域名      | AWS Route 53 注册的域名                     |
| 部署路径    | `/opt/zyt/zyt`                         |
| 站点根目录   | `/var/www/html`                        |
| 服务器登录用户 | `ubuntu`（AWS Ubuntu 镜像默认）              |

---

## 一、部署边界

先明确哪些组件上服务器，避免多余操作。

| 组件              | 是否上服务器 | 说明                                     |
| --------------- | ------ | -------------------------------------- |
| `zyt-contracts` | 否      | 合约已部署到测试链，服务器只作备份，不参与运行                |
| `zyt-keeper`    | 是      | Node 常驻进程，含索引器、每日快照、账本对账、监控告警、HTTP API |
| `zyt-dapp`      | 是      | 本地构建出的静态产物，由 Nginx 托管                  |

**运行架构**

```
用户浏览器
     │
     ▼
 Nginx :80 / :443
     │
     ├── /                → /var/www/html        前端静态文件
     └── /api/            → 127.0.0.1:8080       keeper API
                                  │
                                  ├── MySQL 127.0.0.1:3306  （账本持久化）
                                  └── BSC Testnet RPC        （事件索引与快照写交易）
```

---

## 二、AWS 控制台操作

### 步骤 1 创建服务器实例

**做什么**：开一台 Ubuntu 服务器。

**怎么做**：

1. 进入 EC2 控制台，点 Launch instance
2. Name 填 `zyt-testnet`
3. AMI 选 `Ubuntu Server 24.04 LTS (HVM), SSD Volume Type`
4. Instance type 选 `t3.small`
5. Key pair 选已有密钥或新建，下载 `.pem` 保存好
6. Network settings 点 Edit，确认勾选 `Allow SSH traffic from` 并填 `My IP`
7. Configure storage 改为 `20 GiB gp3`
8. 点 Launch instance

**怎么验证**：实例列表里状态显示 `Running`，且 Status check 两项通过。

### 步骤 2 绑定弹性 IP

**做什么**：固定公网地址，避免重启后 IP 变化导致域名解析失效。

**怎么做**：

1. 左侧菜单 Elastic IPs，点 Allocate Elastic IP address
2. 直接点 Allocate
3. 选中新地址，Actions 里选 Associate Elastic IP address
4. Instance 选刚才建的那台，点 Associate

**怎么验证**：弹性 IP 列表的 Associated instance 显示你的实例 ID。记下这个 IP，后面统一用 `<弹性IP>` 表示。

### 步骤 3 配置安全组

**做什么**：只开放必要端口。

**怎么做**：EC2 实例详情页 Security 标签，点安全组 ID 进入，编辑 Inbound rules，添加三条。

| 类型    | 端口  | 来源        | 用途      |
| ----- | --- | --------- | ------- |
| SSH   | 22  | My IP     | 远程登录    |
| HTTP  | 80  | 0.0.0.0/0 | 页面与证书签发 |
| HTTPS | 443 | 0.0.0.0/0 | 加密访问    |

**不要开放 8080**。keeper 的 API 只经 Nginx 反代访问，直接暴露到公网属于多余风险面。

**怎么验证**：Inbound rules 列表共 3 条，没有 8080 或 3306。

### 步骤 4 确认域名托管状态

**做什么**：确认域名的 Hosted Zone 已存在。

**怎么做**：Route 53 控制台左侧 Hosted zones，找到你的域名。

**怎么验证**：能看到该域名，Name servers 有 4 条记录。AWS 注册的域名会自动创建 Hosted Zone，无需手动建。此时先不加 A 记录，等 HTTPS 签发时再加。

---

## 三、服务器初始化

以下命令都在服务器上执行，登录方式：

```bash
ssh -i <你的密钥文件.pem> ubuntu@<弹性IP>
```

若提示密钥权限过宽，本地先执行 `chmod 600 <密钥文件.pem>`。

### 步骤 5 更新系统

**做什么**：同步软件源与安全补丁。

**怎么做**：

```bash
sudo apt update && sudo apt upgrade -y
```

**怎么验证**：无报错，末尾显示升级完成。

### 步骤 6 设置时区为 UTC

**做什么**：统一服务器时区。

**怎么做**：

```bash
sudo timedatectl set-timezone UTC
timedatectl
```

**怎么验证**：输出里有 `Time zone: UTC`。keeper 的 cron 表达式按 UTC 解释（配置项 `SNAPSHOT_CRON_TZ=UTC`），系统时区统一为 UTC 后，日志时间与触发时刻不会错位。

### 步骤 7 安装运行时

**做什么**：装 Nginx、MySQL、Git、curl、Node 22、PM2。

**怎么做**：

```bash
sudo apt install -y nginx mysql-server git curl unzip

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo npm install -g pm2
```

**怎么验证**：

```bash
nginx -v
mysql --version
node --version
npm --version
pm2 -v
```

五项都要有输出。`node --version` 显示 `v22.x`。

### 步骤 8 启用服务

**做什么**：启动 Nginx 与 MySQL 并设开机自启。

**怎么做**：

```bash
sudo systemctl start nginx && sudo systemctl enable nginx
sudo systemctl start mysql && sudo systemctl enable mysql
```

**怎么验证**：

```bash
systemctl is-active nginx mysql
```

两行都输出 `active`。

### 步骤 9 准备目录

**做什么**：建部署目录与站点目录，并授权给当前用户，避免后续每次操作都要 sudo。

**怎么做**：

```bash
sudo mkdir -p /opt/zyt /var/www/html /var/log/zyt
sudo chown -R ubuntu:ubuntu /opt/zyt /var/www/html /var/log/zyt
```

**怎么验证**：

```bash
ls -ld /opt/zyt /var/www/html /var/log/zyt
```

三行属主均为 `ubuntu ubuntu`。

### 步骤 10 配置防火墙

**做什么**：开启 ufw 并只放行 22、80、443。

**怎么做**：

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

执行前确认 SSH 端口是 22，否则启用后会被锁在外面。

**怎么验证**：

```bash
sudo ufw status
```

输出里 22、80、443 三条均为 ALLOW，且 `Status: active`。

---

## 四、数据库

### 步骤 11 创建数据库

**做什么**：建账本库。

**怎么做**：

```bash
sudo mysql -e "CREATE DATABASE zyt_keeper CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

**怎么验证**：

```bash
sudo mysql -e "SHOW DATABASES;" | grep zyt_keeper
```

有输出即可。

### 步骤 12 创建专用用户

**做什么**：建最小权限账号，避免业务用 root 连库。

**怎么做**：把 `<强密码>` 换成自己生成的随机串。

```bash
sudo mysql -e "CREATE USER 'zyt_keeper'@'localhost' IDENTIFIED BY '<强密码>';"
sudo mysql -e "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX ON zyt_keeper.* TO 'zyt_keeper'@'localhost';"
sudo mysql -e "FLUSH PRIVILEGES;"
```

> 本地 `.env` 里现用的密码是 `zyt_keeper_pass`，测试环境改不改都行，但只要服务器可从公网访问，就建议换掉。本流程的配置命令统一用 `<强密码>` 占位。

**怎么验证**：

```bash
mysql -u zyt_keeper -p'<强密码>' -h 127.0.0.1 zyt_keeper -e "SELECT 1;"
```

返回 `1` 即通。注意这里必须带 `-h 127.0.0.1`，走 TCP 才能验证 keeper 的连接方式。

### 步骤 13 确认 MySQL 只监听本地

**做什么**：确认数据库不对外暴露。

**怎么做**：

```bash
sudo grep -E "^bind-address" /etc/mysql/mysql.conf.d/mysqld.cnf
```

**怎么验证**：输出 `bind-address = 127.0.0.1`。若被注释掉了，取消注释后 `sudo systemctl restart mysql`。

建表不用手动做。keeper 启动时 `src/db.js` 会执行幂等 DDL 自动建表，共 7 张：`events`、`users`、`snapshots`、`pool_state`、`keeper_runs`、`reconcile_results`、`force_sell`。

---

## 五、上传代码

两台机器通用约定：本地是 Windows，路径用 `F:/zyt/...` 写法（Git Bash 里可直接用正斜杠）；服务器路径统一 `/opt/zyt/zyt`。

### 步骤 14 传送 keeper（方式 A，git clone）

**做什么**：从仓库拉取代码。仓库已核查干净，`node_modules`、`data`、`logs`、`.env` 均未被跟踪，可直接拉。

**怎么做**：

先在服务器上生成部署密钥：

```bash
ssh-keygen -t ed25519 -C "zyt-aws" -f ~/.ssh/id_zyt -N ""
cat ~/.ssh/id_zyt.pub
```

把输出的公钥贴到 GitHub 仓库的 Settings → Deploy keys，勾选只读。

配置 SSH 并克隆：

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/id_zyt
  IdentitiesOnly yes
EOF

cd /opt/zyt/zyt && git clone git@github.com:zafeggg/zyt.git .
```

**怎么验证**：

```bash
ls /opt/zyt/zyt-keeper/src/index.js
```

文件存在即可。

### 步骤 15 传送 keeper（方式 B，打包上传）

**做什么**：不走 git 时用打包方式上传，适合不便下发仓库权限的场景。

**怎么做**：本地 Git Bash 执行。

```bash
cd F:/zyt

tar --exclude='zyt-keeper/node_modules' \
    --exclude='zyt-keeper/data' \
    --exclude='zyt-keeper/logs' \
    --exclude='zyt-keeper/backups' \
    --exclude='zyt-keeper/.env' \
    --exclude='zyt-keeper/.env.mainnet' \
    --exclude='zyt-contracts' \
    --exclude='zyt-dapp' \
    -czf keeper.tar.gz zyt-keeper

ls -lh keeper.tar.gz
scp keeper.tar.gz ubuntu@<弹性IP>:/tmp/
```

服务器上解包：

```bash
cd /opt/zyt && tar -xzf /tmp/keeper.tar.gz
```

**怎么验证**：`keeper.tar.gz` 体积应在 200KB 量级。若超过 20M，说明 `node_modules` 没排除掉，重新打包。

### 步骤 16 安装 keeper 依赖

**做什么**：在服务器上装依赖。本地 Windows 的 `node_modules` 含平台相关二进制，不能在 Linux 上运行，必须重装。

**怎么做**：

```bash
cd /opt/zyt/zyt-keeper
npm ci --omit=dev
```

**怎么验证**：

```bash
ls /opt/zyt/zyt-keeper/node_modules | wc -l
```

输出应为几十，不是 0。

### 步骤 17 构建前端

**做什么**：在本地构建测试链版本。测试链要显式指定 `VITE_CHAIN=bscTestnet`，默认的 `npm run build:bsc` 走的是主网分支。

**怎么做**：本地 Git Bash 执行。

```bash
cd F:/zyt/zyt-dapp
VITE_CHAIN=bscTestnet npm run build
```

构建命令里的 `build` 脚本会先跑 `vue-tsc --noEmit` 做类型检查，再执行 `vite build`。测试链分支的 `apiBase` 默认为 `/api`，由 Nginx 同源反代，无需另设 `VITE_API_BASE`。

**怎么验证**：

```bash
ls dist/index.html dist/assets
```

两处都存在。构建过程零类型错误。

### 步骤 18 上传前端产物

**做什么**：把构建产物推到站点目录。

**怎么做**：本地 Git Bash 执行。

```bash
cd F:/zyt/zyt-dapp/dist
tar -czf ../../dapp-dist.tar.gz .
cd ../..

scp dapp-dist.tar.gz ubuntu@<弹性IP>:/tmp/
```

打包命令末尾的 `.` 不可省略，也不可换成 `dist`。差一个点会让服务器上多出一层 `/var/www/html/dist/index.html`，页面直接白屏。

服务器上部署：

```bash
cd /var/www/html

# 先备份旧版，便于回退
sudo tar -czf /root/www-backup-$(date +%F-%H%M).tar.gz . 2>/dev/null

# 清掉旧版 assets，避免新旧文件混用
sudo rm -rf /var/www/html/assets

sudo tar -xzf /tmp/dapp-dist.tar.gz -C /var/www/html
sudo chown -R www-data:www-data /var/www/html
```

**怎么验证**：

```bash
ls /var/www/html/index.html /var/www/html/assets
```

两处都存在，且 `assets/` 里的文件名后缀带新的构建哈希。

---

## 六、keeper 配置


### 步骤 19 写入环境文件

**做什么**：填测试链参数。`zyt-keeper/.env` 不要从本地上传，在服务器上重写更干净。

**怎么做**：

```bash
cd /opt/zyt/zyt-keeper
cat > .env <<'EOF'
# ===== 链（BSC 测试链）=====
CHAIN_ID=97
RPC_URL=https://bsc-testnet-rpc.publicnode.com

# ===== 合约地址（第十套 v9.1，2026-09-24）=====
MINING_ADDR=0x7e3507050db25AD09f2D772Df72C4bea3bae0b04
POOL_ADDR=0x36fa17d24dD706c5a9F61e4Afb47eD3C357b349e
DEFLATION_ADDR=0x80a98C926755604A5582289eecd3eB25C816EF8b
CONFIG_ADDR=0x8402D46f5974301028Ee461d485748b71b0dc487
ZYT_ADDR=0x9D434F75564410d6e41664716defEd92d95985C1
FORCESELL_ADDR=0xCC89c59Cc9b47C7D32545F8f53E0633d3e01a90D
CREATOR_ADDR=0x9bFccB1ADb2da1d634aC9CF426e5e276754a6F74
REFERRAL_ADDR=0xf6Fa72Dd11E0426419D3c3aA75e91730E75B0C4C

# ===== 索引起点（部署块 132873786 前 6 块）=====
START_BLOCK=132873780
INDEXER_POLL_MS=30000
BLOCK_RANGE=1000

# ===== 每日快照（北京 08:01 = UTC 00:01）=====
SNAPSHOT_CRON=1 0 * * *
SNAPSHOT_CRON_TZ=UTC
RETRY_TIMES=3
RETRY_DELAY_MS=30000

# ===== 签名钱包（必须复用已登记地址 0x09BeD12b...）=====
KEEPER_PRIVATE_KEY=<该地址对应私钥>

# ===== API =====
API_PORT=8080
API_ADMIN_TOKEN=<随机长串>
API_RATE_LIMIT=100
CORS_ORIGIN=*

# ===== 存储 =====
DB_URL=mysql://zyt_keeper:<强密码>@127.0.0.1:3306/zyt_keeper

# ===== 强制卖出追踪与到期结算 =====
FORCESELL_ENABLED=true
FORCESELL_SYNC_MS=600000
# 到期自动销毁调度：默认关闭，开启后 keeper 会真实销毁未卖足用户的代币（链上不可逆）
FORCESELL_SETTLE_ENABLED=false
FORCESELL_SETTLE_MS=3600000
FORCESELL_SETTLE_MAX_PER_RUN=10
FORCESELL_SETTLE_TX_GAP_MS=3000

# ===== 告警（可留空）=====
ALERT_WEBHOOK_URL=
EOF

chmod 600 .env
```

**怎么验证**：

```bash
ls -l /opt/zyt/zyt-keeper/.env
grep -c "=" /opt/zyt/zyt-keeper/.env
```

权限位显示 `-rw-------`，键值行有二十余行。

### 步骤 20 核对四项易错配置

**做什么**：逐项确认下面四条，这几处出错后系统会静默异常，不会报错。

**怎么做**：

```bash
grep -E "^(DB_URL|API_PORT|START_BLOCK|CREATOR_ADDR)=" /opt/zyt/zyt-keeper/.env
```

**怎么验证**：

| 键              | 期望值                                                  | 填错的后果                                      |
| -------------- | ---------------------------------------------------- | ------------------------------------------ |
| `DB_URL`       | `mysql://zyt_keeper:<强密码>@127.0.0.1:3306/zyt_keeper` | 键名写成 `DB_PATH` 会被完全忽略，程序落回内存库，重启后账本归零并全量重扫 |
| `API_PORT`     | `8080`                                               | 与 Nginx 反代端口不一致时，Nginx 连不上 keeper          |
| `START_BLOCK`  | `132873780`                                          | 填 0 会从创世块扫，耗时很久；填大了漏事件                     |
| `CREATOR_ADDR` | `0x9bFccB1A...`                                      | 留空则跳过订阅，前端底池累计数据缺失                         |

### 步骤 21 探测 RPC 可用性

**做什么**：确认所选节点能返回历史日志。部分免费节点对归档请求返回 403 或 `-32701` 剪枝错误。

**怎么做**：

```bash
cd /opt/zyt/zyt-keeper
node scripts/rpc-probe.mjs 0x7e3507050db25AD09f2D772Df72C4bea3bae0b04 132873780
```

**怎么验证**：脚本输出各候选节点的探测结果。若 `publicnode` 不可用，换用列表中可用的节点填进 `.env` 的 `RPC_URL`。

### 步骤 22 前台试跑

**做什么**：确认服务能正常起来，并观察账本重建。

**怎么做**：

```bash
cd /opt/zyt/zyt-keeper
node src/index.js
```

**怎么验证**：日志依次出现索引器启动、账本重建 `users=N`、快照机器人就绪 `tz=UTC`、API 就绪 `http://0.0.0.0:8080`。确认无误后按 `Ctrl+C` 退出。

### 步骤 23 转 PM2 守护

**做什么**：用进程管理器常驻，避免 SSH 断开后进程退出。

**怎么做**：

```bash
cd /opt/zyt/zyt-keeper
pm2 start src/index.js --name zyt-keeper
pm2 save
pm2 startup
```

`pm2 startup` 会打印一条 `sudo env PATH=...` 开头的命令，复制并执行它，开机自启才会生效。

**怎么验证**：

```bash
pm2 status
curl http://127.0.0.1:8080/health
```

`pm2 status` 显示 `online`；`curl` 返回 JSON，不是 connection refused。

### 步骤 24 配置日志轮转

**做什么**：防止日志把磁盘写满。

**怎么做**：

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 30
```

**怎么验证**：

```bash
pm2 conf pm2-logrotate
```

能看到 `max_size` 与 `retain` 两项已设。

---

## 七、Nginx 与域名


### 步骤 25 写站点配置

**做什么**：配一处同域站点，前端静态与 API 反代共用一个域名。仓库里已有模板 `zyt-keeper/deploy/nginx-zyt.conf`，以它为基准。

**怎么做**：

```bash
sudo tee /etc/nginx/sites-available/zyt > /dev/null <<'EOF'
server {
    listen 80;
    server_name <你的域名>;

    # ---------- 前端静态（Vite 构建产物）----------
    root /var/www/html;
    index index.html;

    # index.html 强制校验，assets 长缓存，避免旧版复活
    location = /index.html {
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }
    location / {
        try_files $uri $uri/ /index.html;
    }

    # ---------- API 反代到 keeper ----------
    # 末尾斜杠不可省略：keeper 路由不带 /api 前缀，需由此剥离
    location /api/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        proxy_connect_timeout 10s;
    }
}
EOF
```

把 `<你的域名>` 换成实际域名。

**怎么验证**：

```bash
grep -n "server_name\|proxy_pass" /etc/nginx/sites-available/zyt
```

确认 `server_name` 是实际域名，`proxy_pass` 末尾带斜杠。

### 步骤 26 启用站点

**做什么**：挂上软链，去掉默认站点，避免冲突。

**怎么做**：

```bash
sudo ln -sf /etc/nginx/sites-available/zyt /etc/nginx/sites-enabled/zyt
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
```

**怎么验证**：`nginx -t` 输出 `syntax is ok` 与 `test is successful`。

### 步骤 27 重载 Nginx

**做什么**：让配置生效。

**怎么做**：

```bash
sudo systemctl reload nginx
```

**怎么验证**：

```bash
curl -I http://127.0.0.1/
```

返回 `HTTP/1.1 200 OK`。

### 步骤 28 添加 DNS 解析

**做什么**：把域名指向弹性 IP。

**怎么做**：

1. Route 53 控制台进入你的域名 Hosted zone
2. 点 Create record
3. Record name 留空（表示根域名），Record type 选 `A`
4. Value 填 `<弹性IP>`
5. TTL 填 `300`
6. 点 Create records

**怎么验证**：

```bash
nslookup <你的域名> 8.8.8.8
```

返回的 Address 等于弹性 IP。DNS 生效通常需要 1 到 5 分钟。

### 步骤 29 签发 HTTPS 证书

**做什么**：申请 Let's Encrypt 证书并自动改写 Nginx 配置。

**怎么做**：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <你的域名>
```

过程中会问是否把 HTTP 请求重定向到 HTTPS，选重定向。certbot 会自动往站点配置里追加 443 server 块。

**怎么验证**：

```bash
sudo certbot certificates
curl -I https://<你的域名>
```

证书列表显示有效，`curl` 返回 200。另外确认自动续期定时任务存在：

```bash
systemctl list-timers | grep certbot
```

---

## 八、端到端验收

按顺序执行，每步都要通过再进下一步。

### 步骤 30 服务状态

**做什么**：确认各模块在线。

**怎么做**：

```bash
pm2 status
systemctl is-active nginx mysql
```

**怎么验证**：`pm2 status` 显示 `zyt-keeper` 为 `online`，重启次数为 0；两个 systemd 服务均为 `active`。

### 步骤 31 本地 API 直连

**做什么**：排除 Nginx 因素，先验 keeper 本身。

**怎么做**：

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/stats
```

**怎么验证**：`/health` 返回 `{"ok":true,...}`；`/stats` 返回池数据，`pool_zyt` 接近 20.4 亿量级。

### 步骤 32 经 Nginx 的 API

**做什么**：这一步专门验前缀剥离是否正确，是整条链路最容易出问题的一环。

**怎么做**：

```bash
curl https://<你的域名>/api/stats
curl https://<你的域名>/api/user/0x87C0aF08c0F974E86CAC508faA239bB1Cc2f2241
```

**怎么验证**：两个请求都返回 JSON。若返回 404，说明第 25 步的 `proxy_pass` 末尾漏了斜杠，keeper 收到的是 `/api/stats` 而非 `/stats`。

### 步骤 33 页面访问

**做什么**：验前端可用。

**怎么做**：浏览器打开 `https://<你的域名>`，观察首屏渲染与地址栏锁图标。

**怎么验证**：页面正常显示，锁图标正常，浏览器控制台无 404 请求。

### 步骤 34 钱包连接与链切换

**做什么**：验前端与测试链的对接。

**怎么做**：

1. 浏览器装上 MetaMask，切到 BSC Testnet
2. 打开页面点连接钱包
3. 若提示网络不符，按页面提示一键切换

**怎么验证**：地址正确显示，页面数据来自 API 而非降级为链上直连。数据来源标记可在底池面板或控制台查看。

### 步骤 35 对账

**做什么**：核对链下账本与链上状态。

**怎么做**：

```bash
curl -X POST -H "x-admin-token: <API_ADMIN_TOKEN 的值>" http://127.0.0.1:8080/reconcile
```

**怎么验证**：返回差异列表。理想为空，或仅含「零入金地址」一类已知项，即那些只接收 ZYT 后卖出、本地无入金记录的地址。若返回 403，说明 `API_ADMIN_TOKEN` 没配或值不匹配。

### 步骤 36 快照手测

**做什么**：确认 keeper 能成功发起写交易。

**怎么做**：

```bash
cd /opt/zyt/zyt-keeper
timeout 120 npm run snapshot
```

该脚本因 provider 轮询不会自动退出，用 `timeout` 限制。

**怎么验证**：

1. 命令输出交易哈希
2. BscScan 测试链上能看到 `DailySnapshot` 事件
3. keeper 钱包 BNB 余额减少

### 步骤 37 重启幂等

**做什么**：确认账本持久化生效，重启不会全量重扫。

**怎么做**：

```bash
pm2 restart zyt-keeper
sleep 15
pm2 logs zyt-keeper --lines 40
```

**怎么验证**：日志里的账本用户数从 MySQL 加载而出，索引游标从上次位置续上，没有出现从 `START_BLOCK` 重新扫块的记录。

---

## 九、日常运维

### 常用命令

```bash
pm2 status                                # 进程状态
pm2 logs zyt-keeper --lines 100           # 查看日志
pm2 restart zyt-keeper                    # 重启
sudo systemctl reload nginx               # 重载 Nginx
```

### 更新代码

```bash
cd /opt/zyt
git pull
cd zyt-keeper && npm ci --omit=dev
pm2 restart zyt-keeper
```

前端更新需在本地重新构建后按步骤 18 上传。

### 仓库现成的运维脚本

| 脚本                                    | 用途                 |
| ------------------------------------- | ------------------ |
| `npm run snapshot`                    | 立即触发一次每日快照         |
| `npm run reconcile`                   | 手动跑一次链上链下对账        |
| `node scripts/api-check.mjs`          | 巡检 API 各端点         |
| `node scripts/cron-smoke.mjs`         | 校验 cron 表达式与触发时刻   |
| `node scripts/monitor-check.mjs`      | 单独跑一次监控规则          |
| `node scripts/forcesell-sync-now.mjs` | 立即同步强制卖出窗口状态       |
| `node scripts/backfill-history.mjs`   | 历史事件补拉，用于补账本缺口     |
| `node scripts/rpc-probe.mjs`          | 探测各公共 RPC 对历史日志的支持 |

### 数据库备份

```bash
sudo crontab -e
```

加入两行（把 `<强密码>` 换掉）：

```
0 3 * * * mysqldump -u zyt_keeper -p'<强密码>' zyt_keeper | gzip > /var/backups/zyt_$(date +\%Y\%m\%d).sql.gz
0 4 * * * find /var/backups/ -name "zyt_*.sql.gz" -mtime +30 -delete
```

### 账本重建

账本数据异常时，从链上重放。`events` 表是唯一事实源。

```bash
pm2 stop zyt-keeper
mysql -u zyt_keeper -p'<强密码>' zyt_keeper -e "
  TRUNCATE events; TRUNCATE users; TRUNCATE pool_state;
  TRUNCATE snapshots; TRUNCATE reconcile_results; TRUNCATE force_sell;"
pm2 start zyt-keeper
```

**怎么验证**：日志出现 `ledger rebuild users=N` 与 `reconcile ok`。

---

## 十、检查清单

部署完成后逐项打勾。

- [ ] 实例运行中，弹性 IP 已关联
- [ ] 安全组仅开放 22、80、443
- [ ] Nginx、MySQL 均为 active 且开机自启
- [ ] 数据库 `zyt_keeper` 已建，7 张表由 keeper 自动创建完成
- [ ] keeper 代码已上传至 `/opt/zyt/zyt/zyt-keeper`
- [ ] `npm ci --omit=dev` 执行完成，`node_modules` 非空
- [ ] `.env` 权限 600，八项合约地址与实际部署一致
- [ ] `DB_URL` 指向 MySQL，非 `:memory:`
- [ ] `START_BLOCK=132873780`
- [ ] `API_PORT=8080`，与 Nginx 反代端口一致
- [ ] `KEEPER_PRIVATE_KEY` 对应地址为 `0x09BeD12b...`，且该地址有测试链 BNB
- [ ] `API_ADMIN_TOKEN` 已配置
- [ ] 前端以 `VITE_CHAIN=bscTestnet` 构建，产物位于 `/var/www/html`
- [ ] Nginx `proxy_pass` 末尾带斜杠
- [ ] HTTPS 证书已签发，HTTP 自动跳转
- [ ] DNS A 记录指向弹性 IP
- [ ] `/health`、`/stats`、`/api/stats` 三个端点均正常
- [ ] 页面可打开，钱包可连接，数据来自 API
- [ ] 对账差异为空或仅含已知项
- [ ] 快照手测成功，链上可见 `DailySnapshot` 事件
- [ ] PM2 开机自启已配置
- [ ] 数据库备份 cron 已配置

---

## 附录 A 已知易错点

按出错概率排序。

| #  | 易错点                      | 表现                           | 处置                                         |
| -- | ------------------------ | ---------------------------- | ------------------------------------------ |
| 1  | Nginx `proxy_pass` 末尾漏斜杠 | `/api/*` 全部 404              | 改为 `proxy_pass http://127.0.0.1:8080/;`    |
| 2  | 环境变量写成 `DB_PATH`         | 程序静默跑内存库，重启账本归零              | 键名必须是 `DB_URL`，且值为 `mysql://` 开头           |
| 3  | 前端用 `npm run build:bsc`  | 构建出主网版本，指向 chainId 56        | 测试链用 `VITE_CHAIN=bscTestnet npm run build` |
| 4  | 上传了本地 `node_modules`     | Linux 上原生模块加载失败              | 服务器上 `npm ci --omit=dev` 重装                |
| 5  | 前端打包时多一层目录               | 站点根出现 `dist/index.html`，页面白屏 | 在 `dist` 目录内执行 `tar -czf ... .`            |
| 6  | `START_BLOCK` 填 0        | 从创世块扫，耗费极长时间                 | 填 `132873780`                              |
| 7  | 换新钱包做 keeper 签名          | 快照交易被合约拒绝                    | 必须复用 `0x09BeD12b...` 对应私钥                  |
| 8  | 开放了 8080 到公网             | API 直接被外部访问                  | 安全组不开该端口，仅 Nginx 内网反代                      |
| 9  | 服务器时区非 UTC               | 快照触发时刻错位                     | `timedatectl set-timezone UTC`             |
| 10 | 未配 `API_ADMIN_TOKEN`     | `/reconcile` 恒返 403          | 在 `.env` 中配置强随机串                           |

## 附录 B 与主网部署的差异对照

| 项             | 测试链（本文档）                                   | 主网                       |
| ------------- | ------------------------------------------ | ------------------------ |
| `CHAIN_ID`    | 97                                         | 56                       |
| RPC           | `bsc-testnet-rpc.publicnode.com`           | `bsc-rpc.publicnode.com` |
| USDT          | MockUSDT `0x33F797D0...`                   | 真实 USDT `0x55d39832...`  |
| keeper 签名钱包   | 必须复用 `0x09BeD12b...`                       | 建议新建独立钱包                 |
| 合约 owner      | 部署者 EOA                                    | Gnosis Safe 多签           |
| `CORS_ORIGIN` | 可留 `*`                                     | 改为前端域名                   |
| 合约地址核对        | 对照 `deployments/bscTestnet-20260924.json` | 对照主网部署记录                 |
| 白名单           | 测试阶段按需放开                                   | 上线前必须开启买入白名单             |

---

> 文档版本 v1.0（2026-09-25）｜适用范围：BSC 测试链 + AWS Ubuntu 单机部署
