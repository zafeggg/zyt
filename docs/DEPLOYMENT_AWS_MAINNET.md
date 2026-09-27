# ZYT 众赢币 — BSC 主网正式版部署流程（合约 + 服务器）

> **适用场景**：v9.1 合约部署到 BSC 主网（chainId 56，真实 USDT），链下服务（keeper）与前端（dapp）部署到境外 Ubuntu 服务器对外提供服务。
> **本文档与测试链版本的关系**：步骤骨架沿用 `docs/DEPLOYMENT_AWS_TESTNET.md`，主网差异集中在链参数、代币口径、钱包与多签、白名单、域名与合规五处。
> **配套门禁**：`docs/主网上线防复发检查清单.md`、`docs/主网密钥管理清单.md`
> **编制日期**：2026-09-26

---

## 〇、前置信息清单

### 0.1 你必须更换的内容（先看这一节）

下表逐项列出主网部署前必须替换的私钥、密码、地址与域名。**打勾后才进入后续步骤**。

#### A. 本地 `zyt-contracts/.env`（部署机，私钥不上服务器）

| 变量 | 当前值（测试链） | 主网要换成 | 说明 |
| -- | -- | -- | -- |
| `PRIVATE_KEY` | 测试链 deployer 私钥 | **主网 deployer 私钥**（新钱包，非测试钱包） | 部署 9 合约并成为 owner；部署后立即清除或换回测试私钥 |
| `MARKET_ADDRESS` | 测试链用部署者地址 | **主网营销 Safe** `0x1bc03Fe18F9BabBc32f0B4046E13e387E9D16786` | 滑点与代数奖励的营销收款地址 |
| `TECHNICAL_ADDRESS` | 测试链用普通地址 | **主网技术 Safe** `0x860D4704d6eee98Aa55A971Caf8BAA4134E8eec3` | 10% 技术运维收款地址 |
| `KEEPER_ADDRESS` | `0x09BeD12b5956E1E53668Aa10E242766E3aE3B641` | **新建独立 keeper 钱包地址** | 主网可新建（测试链因合约已登记只能复用）；无资金权限，仅触发每日快照 |
| `BSC_MAINNET_RPC` | publicnode | **`https://bsc-dataseed1.bnbchain.org`**（备选 dataseed2/3） | 部署脚本与 hardhat 兼容性最佳；publicnode 对部署返回 `to:""` 会崩 hardhat |
| `BSCSCAN_API_KEY` | 已有 | 沿用或更换 | verify 用 |

#### B. 服务器 `zyt-keeper/.env`（部署后写入，`chmod 600`）

| 变量 | 要填什么 | 来源 |
| -- | -- | -- |
| `CHAIN_ID` | `56` | 固定值 |
| `RPC_URL` | 主网 RPC，推荐与部署同源或专用归档节点 | 见步骤 21 探测 |
| 9 个合约地址 | 主网部署记录 JSON 逐项复制 | `deployments/mainnet-<日期>.json` |
| `START_BLOCK` | **主网部署块号减 6** | 部署输出或区块浏览器 |
| `KEEPER_PRIVATE_KEY` | 与 `KEEPER_ADDRESS` 同钥的私钥 | 新建钱包生成 |
| `API_ADMIN_TOKEN` | **新生成的随机长串** | `openssl rand -hex 32` |
| `DB_URL` 密码 | **新强密码**（不要与测试链相同） | 步骤 12 创建用户时设定 |
| `CORS_ORIGIN` | 前端正式域名，例如 `https://your-domain.com` | 不要留 `*` |
| `ALERT_WEBHOOK_URL` | 告警渠道地址（可留空） | 企业微信/钉钉/Slack Webhook |

#### C. 前端 `zyt-dapp/src/config/index.ts` 的 `BSC_MAINNET` 段

| 字段 | 当前值（主网 TestUSDT 试运行版） | 主网正式版要换成 |
| -- | -- | -- |
| `rpc` | `https://bsc-rpc.publicnode.com` | 内网可达的主网 RPC（浏览器需能直连） |
| `rootInvite` | 营销 Safe `0x1bc03Fe1...` | 沿用营销 Safe 或改为运营指定地址 |
| `contracts.config` | `0x7247791B...` | 新部署地址 |
| `contracts.zyt` | `0xAB4c090C...` | 新部署地址 |
| `contracts.pool` | `0xe2b0DdB4...` | 新部署地址 |
| `contracts.mining` | `0xFC97Bf17...` | 新部署地址 |
| `contracts.deflation` | `0x95e60944...` | 新部署地址 |
| `contracts.forceSell` | `0xD944f0A5...` | 新部署地址 |
| `contracts.referral` | `0x74285fC2...` | 新部署地址 |
| `contracts.creator` | 空串 | 新部署地址（v9 锁仓合约，必填） |
| `contracts.usdt` | TestUSDT `0x4cd6d102...` | **真实 USDT `0x55d398326f99059fF775485246999027B3197955`** |
| `contracts.gst` | 旧字段 | 留空串（v9 已弃 GST） |

#### D. 服务器与域名侧

| 项 | 要准备什么 |
| -- | -- |
| 服务器 | 境外 Ubuntu 24.04（AWS ap-southeast-1 或其它境外区域），2 核 4G 起 |
| 弹性 IP / 公网 IP | 固定 IP，避免换 IP 后 DNS 失效 |
| 域名 | 境外注册与解析，免 ICP；A 记录指向服务器 IP |
| TLS 证书 | Let's Encrypt（certbot）或商业证书，需可收验证邮件 |
| 服务器登录用户 | `ubuntu`（AWS 镜像默认）或自建账号，禁用 root 直接登录 |
| MySQL 密码 | 新强密码（步骤 11、12 设定） |
| 备份存储 | 数据库备份落盘路径或对象存储（可选） |

> **不需要更换的部分**：营销 Safe 与技术 Safe 地址（主网既有）、Math/AMM 依赖（Pancake V2 主网 Router/Factory 已内置在合约）、`zyt-keeper/deploy/nginx-zyt.conf` 模板可直接复用。

### 0.2 链侧信息（主网，部署后回填）

| 项 | 值 |
| -- | -- |
| 网络 | BSC Mainnet |
| chainId | `56` |
| RPC（部署） | `https://bsc-dataseed1.bnbchain.org` |
| RPC（keeper） | 待填（步骤 21 探测后确定） |
| USDT | `0x55d398326f99059fF775485246999027B3197955`（真实 USDT，18 位小数） |
| ZYTConfig | 待回填 |
| ZYTToken | 待回填 |
| ZYTPoolManager | 待回填 |
| ZYTMining | 待回填 |
| ZYTDeflation | 待回填 |
| ZYTForceSell | 待回填 |
| ZYTReferral | 待回填 |
| ZYTLiquidityCreator | 待回填 |
| Pair（ZYT/USDT） | 待回填 |
| 部署者地址 | 待回填（主网 deployer EOA） |
| keeper 签名地址 | 待回填（新建） |
| 索引起点块 | 待回填（部署块减 6） |
| 部署记录文件 | `zyt-contracts/deployments/mainnet-<日期>.json` |

### 0.3 服务器侧信息（部署前填写）

| 项 | 填什么 |
| -- | -- |
| AWS 区域 | 建议 `ap-southeast-1`（新加坡，境外合规） |
| 实例类型 | `t3.medium`（2 核 4G，主网数据量大于测试） |
| 操作系统 | Ubuntu Server 24.04 LTS |
| 弹性 IP | 分配后关联实例 |
| 域名 | 境外注册，A 记录指向弹性 IP |
| 部署路径 | `/opt/zyt/zyt` |
| 站点根目录 | `/var/www/html` |
| 服务器登录用户 | `ubuntu` |

---

## 一、部署边界

| 组件 | 是否上服务器 | 说明 |
| -- | -- | -- |
| `zyt-contracts` | 否 | 合约部署在本地执行，服务器只放部署记录备份 |
| `zyt-keeper` | 是 | Node 常驻进程，含索引器、每日快照、账本对账、监控告警、HTTP API |
| `zyt-dapp` | 是 | 本地构建产物，Nginx 托管 |

**运行架构**

```
用户浏览器（MetaMask / TokenPocket）
        │
        ▼
  Nginx :80 / :443
        │
        ├── /             → /var/www/html         前端静态文件
        └── /api/         → 127.0.0.1:8080        keeper API
                                 │
                                 ├── MySQL 127.0.0.1:3306   账本持久化
                                 └── BSC Mainnet RPC        事件索引 + 每日快照写交易
```

---

## 二、合约部署（本地执行，先过门禁 A）

### 步骤 0 部署前门禁（FAIL 必须为 0）

**做什么**：跑脚本检查源码修复特征、编译时效、keeper 口径、前端配置，防止把旧字节码部署上主网。

**怎么做**：

```bash
cd F:/zyt/zyt-contracts
node scripts/mainnet-preflight.mjs
```

**怎么验证**：输出 `FAIL 0`。存在 FAIL 时按提示修复后重跑。重点确认三项修复在源码里：`to != pool`（卖出双计）、`_inTax`（转账税分发）、`downlineCount`（代数 = 直推数）。

### 步骤 1 确认 .env 与钱包余额

**做什么**：把 0.1 节 A 表的变量全部替换为主网值，并给 deployer 备足 gas 与 USDT。

**怎么做**：

```bash
cd F:/zyt/zyt-contracts
grep -E "^(PRIVATE_KEY|MARKET_ADDRESS|TECHNICAL_ADDRESS|KEEPER_ADDRESS|BSC_MAINNET_RPC)=" .env | sed 's/=0x\(..........\).*/=0x\1.../'
```

**怎么验证**：

| 项 | 要求 |
| -- | -- |
| deployer BNB | ≥ 0.15 BNB（9 合约 + 建池 + 接线，留足余量） |
| deployer USDT | ≥ 21000 USDT（初始底池，`createInitialPool` 直接扣） |
| `.env` 未入库 | `git check-ignore zyt-contracts/.env` 有输出 |
| 目录不在云同步 | `zyt-contracts/` 不在 OneDrive / 网盘路径下 |

### 步骤 2 部署合约

**做什么**：部署 v9.1 全套（真实 USDT，不用 Mock）。

**怎么做**：

```bash
cd F:/zyt/zyt-contracts
# 交互确认（输入 yes）；脚本化场景改用 CONFIRM_MAINNET=1
npx hardhat run scripts/deploy.js --network bsc
```

**怎么验证**：脚本尾部输出 9 合约地址 + Pair + Market + Technical + Keeper，并打印部署记录文件名。核对：

| 核对项 | 期望 |
| -- | -- |
| Market | `0x1bc03Fe18F9BabBc32f0B4046E13e387E9D16786` |
| Technical | `0x860D4704d6eee98Aa55A971Caf8BAA4134E8eec3` |
| Keeper | 你新建的 keeper 地址 |
| USDT | `0x55d39832...`（无 "TestUSDT" 提示） |
| LP 持有量（Creator 托管） | > 0 |
| 初始价 | 0.00001 U 量级 |

脚本会把完整记录写入 `deployments/mainnet-<日期>.json`（含地址、构造参数、角色、部署块、索引起点），后续 verify、部署后核对、keeper 与前端接线全部以该文件为唯一事实源，无需手抄地址。

### 步骤 3 部署后门禁（字节码一致性）

**做什么**：把链上字节码与本地编译产物逐合约比对（剥离 metadata 后 sha256），杜绝「工厂地址对但实现旧」的事故。

**怎么做**：

```bash
cd F:/zyt/zyt-contracts
node scripts/mainnet-preflight.mjs --addr deployments/mainnet-<日期>.json
```

**怎么验证**：全部合约一致，`FAIL 0`。任何不一致立即重部署。

### 步骤 4 合约 verify（bscscan）

**做什么**：逐个 verify，便于用户与审计方自证源码。

**怎么做**：

```bash
cd F:/zyt/zyt-contracts
npx hardhat run scripts/verify-all-mainnet.js --network bsc
```

**怎么验证**：10/10 全部 verified。脚本自动读取 `deployments/` 下最新的主网记录，构造参数与库链接由记录推导；真实 USDT 已由币安 verify，脚本自动跳过。指定记录用 `VERIFY_FILE=deployments/xxx.json`。若报 proxy 或 bytecode 错误，按附录 B 处理。

### 步骤 5 部署后核对（一条命令覆盖 35+ 项）

**做什么**：用脚本核对角色接线、Token 接线、白名单七项、池与建池、14 项运营参数、USDT 口径、卖闸实测。手工 console 逐条查容易漏项。

**怎么做**：

```bash
cd F:/zyt/zyt-contracts
node scripts/post-deploy-check-mainnet.mjs                      # 自动读最新主网记录
node scripts/post-deploy-check-mainnet.mjs --addr deployments/mainnet-<日期>.json   # 指定记录
node scripts/post-deploy-check-mainnet.mjs --fix                 # 发现接线缺失时自动补齐（需 owner 私钥）
```

**怎么验证**：输出 `失败 0 项`。各项期望值如下，脚本已内置比对：

| 分组 | 检查项 | 主网期望 |
| -- | -- | -- |
| 角色 | marketAddress / technicalAddress / keeperAddress | 与部署记录 roles 一致 |
| 角色 | ForceSell.keeper | 与 keeperAddress 一致 |
| Token | minter / ledger / pool / forceSell / creator / configAddr / pairAddress | 与部署记录一致 |
| 白名单 | creator / pool / mining / deflation / market / technical / pair | 全部 true |
| 池 | 池 USDT（soft） | 21000（运营后变化属正常，标 ⚠️ 不阻断） |
| 池 | 池 ZYT（soft） | 21 亿（同上） |
| 池 | swapGate | false（空闲态） |
| 池 | LP 持有量 > 0（Creator 托管，供通缩抽池） | 满足 |
| 参数 | zytMaxSupply / minDeposit / maxDeposit / deflationFloor | 21 亿 / 100 / 500 / 500 万 |
| 参数 | powerRate / dynamicQuotaMul / buyQuotaRate / poolRate | 10000 / 5 / 10000 / 6000 |
| 参数 | staticExitMul / deflationRate / transferSlippage / dailyCompoundRate | 2 / 200 / 1000 / 100 |
| 门控 | 直转 pair 被卖闸拦截 | 拦截成立 |

### 步骤 6 买入门控确认（v9 无用户白名单）

**做什么**：v9 已移除 v8 的「用户买入白名单」，买入门控由三处构成。

| 门控 | 合约位置 | 主网上线建议 |
| -- | -- | -- |
| 阶段 1 禁买 | `PoolManager.getStage()` 读 `poolStage1USDT` | 上线初期保持 stage 1（只卖），池 U 达阈值后自动进入 stage 2 |
| 卖闸 | `ZYTToken` 流入 pair 限 pool/creator | 保持开启，防绕过合约直接卖 |
| 买入闸 | `ZYTToken` 流出 pair 需 `pool.swapGate()` | 保持开启，防外部直接调 pair 抢跑 |

**怎么验证**：步骤 5 的脚本已实测「直转 pair 被拦截」并打印 `swapGate` 状态。若需临时放开买入测试，用 `config.setUint("poolStage1USDT", 小额)`，测完改回 10000000。

---

## 三、服务器准备

### 步骤 7 创建实例与弹性 IP

**做什么**：在 AWS 控制台建 Ubuntu 实例并绑定固定 IP。

**怎么做**：EC2 → 启动实例 → `Ubuntu Server 24.04 LTS` → 实例类型 `t3.medium` → 存储 30G gp3 → 安全组先只开 22（后续加 80/443）→ 启动后「弹性 IP」分配并关联。

**怎么验证**：`ssh -i <密钥> ubuntu@<弹性IP>` 能登录。

### 步骤 8 安全组与域名

**做什么**：放行 HTTP/HTTPS，准备域名解析。

**怎么做**：安全组入站加 80/tcp、443/tcp（来源 `0.0.0.0/0`），22/tcp 建议限公司或个人 IP。域名添加 A 记录指向弹性 IP。

**怎么验证**：`dig +short your-domain.com` 返回弹性 IP。

### 步骤 9 系统初始化

**做什么**：更新系统、设时区、装运行时。

**怎么做**：

```bash
sudo apt update && sudo apt upgrade -y
sudo timedatectl set-timezone UTC          # keeper 快照按 UTC，务必设 UTC
timedatectl
# Node 22（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git nginx mysql-server
node -v && npm -v && nginx -v && mysql --version
# PM2 与 certbot
sudo npm install -g pm2
sudo apt install -y certbot python3-certbot-nginx
```

**怎么验证**：`node -v` 出 22.x，`timedatectl` 显示 `Time zone: UTC`，`pm2 -v` 有输出。

### 步骤 10 目录与防火墙

**怎么做**：

```bash
sudo mkdir -p /opt/zyt && sudo chown -R ubuntu:ubuntu /opt/zyt
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable
sudo ufw status
```

**怎么验证**：`ufw status` 显示 22/80/443 允许。

---

## 四、数据库

### 步骤 11 创建数据库

```bash
sudo mysql <<'SQL'
CREATE DATABASE zyt_keeper CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
SQL
```

### 步骤 12 创建专用用户（**换新强密码**）

```bash
sudo mysql <<'SQL'
CREATE USER 'zyt_keeper'@'127.0.0.1' IDENTIFIED BY '<新强密码>';
GRANT ALL PRIVILEGES ON zyt_keeper.* TO 'zyt_keeper'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
# 验证
mysql -h 127.0.0.1 -u zyt_keeper -p zyt_keeper -e "SELECT 1;"
```

**怎么验证**：能连接并返回 1。密码记入 0.1 节 B 表，后续写进 keeper `.env` 的 `DB_URL`。

### 步骤 13 确认 MySQL 只监听本地

```bash
sudo ss -lntp | grep 3306        # 期望 127.0.0.1:3306，不是 0.0.0.0
grep -n "bind-address" /etc/mysql/mysql.conf.d/mysqld.cnf
```

**怎么验证**：绑定地址为 `127.0.0.1`。若为 `0.0.0.0`，改配置后 `sudo systemctl restart mysql`。

---

## 五、上传代码

### 步骤 14 上传 keeper（二选一）

**方式 A：Git（推荐，便于后续更新）**

```bash
sudo mkdir -p /opt/zyt && cd /opt/zyt
git clone <你的仓库地址> zyt
cd zyt/zyt-keeper
```

**方式 B：打包上传**

```bash
# 本地 Windows
cd F:/zyt
tar -czf keeper.tar.gz --exclude=node_modules --exclude=.env zyt-keeper
scp -i <密钥> keeper.tar.gz ubuntu@<弹性IP>:/opt/zyt/
# 服务器
cd /opt/zyt && mkdir -p zyt && tar -xzf keeper.tar.gz -C zyt
```

**怎么验证**：`ls /opt/zyt/zyt/zyt-keeper/src/index.js` 存在。

### 步骤 15 安装 keeper 依赖

```bash
cd /opt/zyt/zyt/zyt-keeper
npm install --omit=dev
node --check src/index.js && echo "语法 OK"
```

**注意**：`.env` 不要从本地上传，在服务器上重写（下一步）。

### 步骤 16 构建前端（本地执行）

```bash
# 本地 Windows
cd F:/zyt/zyt-dapp
# 先把 config 的 BSC_MAINNET 段全部换为主网正式地址（见 0.1 节 C 表）
npx vue-tsc --noEmit
VITE_CHAIN=bsc npx vite build
cp -r dist/* ../dapp-dist-tmp/ 2>/dev/null || true
```

**怎么验证**：`dist/index.html` 与 `dist/assets/` 生成；`vue-tsc` 零错误。

### 步骤 17 上传前端产物

```bash
cd F:/zyt
tar -czf dapp-dist.tar.gz -C zyt-dapp dist
scp -i <密钥> dapp-dist.tar.gz ubuntu@<弹性IP>:/tmp/
# 服务器
sudo mkdir -p /var/www/html
sudo tar -xzf /tmp/dapp-dist.tar.gz -C /tmp/
sudo rm -rf /var/www/html/*            # 清旧产物，避免新旧 assets 混用
sudo cp -r /tmp/dist/* /var/www/html/
sudo chown -R www-data:www-data /var/www/html
```

**怎么验证**：`ls /var/www/html/index.html` 存在。

---

## 六、keeper 配置

### 步骤 18 写入环境文件（主网口径）

**做什么**：在服务器上直接新建 `.env`，填入主网参数。**带 `<...>` 的项必须替换为你自己的值**。

**怎么做**：

```bash
cd /opt/zyt/zyt/zyt-keeper
cat > .env <<'EOF'
# ===== 链（BSC 主网）=====
CHAIN_ID=56
RPC_URL=<主网 RPC，步骤 21 探测后确定，如 https://bsc-rpc.publicnode.com>

# ===== 合约地址（主网正式版，从 deployments/mainnet-<日期>.json 复制）=====
MINING_ADDR=<ZYTMining>
POOL_ADDR=<ZYTPoolManager>
DEFLATION_ADDR=<ZYTDeflation>
CONFIG_ADDR=<ZYTConfig>
ZYT_ADDR=<ZYTToken>
FORCESELL_ADDR=<ZYTForceSell>
CREATOR_ADDR=<ZYTLiquidityCreator>
REFERRAL_ADDR=<ZYTReferral>

# ===== 索引起点（主网部署块号减 6）=====
START_BLOCK=<部署块 - 6>
INDEXER_POLL_MS=30000
BLOCK_RANGE=1000

# ===== 每日快照（北京 08:01 = UTC 00:01）=====
SNAPSHOT_CRON=1 0 * * *
SNAPSHOT_CRON_TZ=UTC
RETRY_TIMES=3
RETRY_DELAY_MS=30000

# ===== 签名钱包（与部署时的 KEEPER_ADDRESS 同钥）=====
KEEPER_PRIVATE_KEY=<keeper 私钥，0x + 64 位十六进制>

# ===== API =====
API_PORT=8080
API_ADMIN_TOKEN=<openssl rand -hex 32 生成>
API_RATE_LIMIT=100
CORS_ORIGIN=https://<你的域名>

# ===== 存储 =====
DB_URL=mysql://zyt_keeper:<步骤 12 的强密码>@127.0.0.1:3306/zyt_keeper

# ===== 强制卖出追踪与到期结算 =====
FORCESELL_ENABLED=true
FORCESELL_SYNC_MS=600000
# 到期自动销毁：确认运营方接受「未卖足按差额销毁」后再开 true
FORCESELL_SETTLE_ENABLED=false
FORCESELL_SETTLE_MS=3600000
FORCESELL_SETTLE_MAX_PER_RUN=10
FORCESELL_SETTLE_TX_GAP_MS=3000

# ===== 告警（可留空）=====
ALERT_WEBHOOK_URL=<告警 Webhook 或留空>
EOF
chmod 600 .env
```

**怎么验证**：

```bash
ls -l .env                 # 期望 -rw-------
grep -c "=" .env           # 二十余行
grep -c "<" .env           # 期望 0（没有漏替换的占位符）
```

### 步骤 19 核对易错配置

```bash
grep -E "^(CHAIN_ID|DB_URL|API_PORT|START_BLOCK|CREATOR_ADDR|CORS_ORIGIN|KEEPER_PRIVATE_KEY)=" .env | sed 's/\(KEY=0x..\).*/\1.../'
```

| 键 | 期望 | 填错的后果 |
| -- | -- | -- |
| `CHAIN_ID` | `56` | 填 97 会索引测试链，链上地址读不到，账本恒空 |
| `DB_URL` | `mysql://...@127.0.0.1:3306/zyt_keeper` | 键名写错会被忽略，落回内存库，重启即丢账本 |
| `API_PORT` | `8080` | 与 Nginx 反代端口不一致时 Nginx 502 |
| `START_BLOCK` | 部署块减 6 | 填 0 从创世扫，耗时极长；填大了漏事件 |
| `CREATOR_ADDR` | 非空 | 留空则跳过订阅，前端底池数据缺失 |
| `CORS_ORIGIN` | 正式域名 | 留 `*` 会让任意站点调用你的 API |
| `KEEPER_PRIVATE_KEY` | `0x` + 64 位 | 填错则每日快照交易被合约拒绝 |

### 步骤 20 keeper 接口一致性检查

```bash
cd /opt/zyt/zyt/zyt-keeper
node scripts/check-keeper-interfaces.mjs --probe
```

**怎么验证**：无缺失项。检查项包含 ABI 声明与链上合约一致、11 项必填环境变量齐全、快照接口可调用。

### 步骤 21 探测 RPC 可用性

**做什么**：主网节点对历史 `eth_getLogs` 的限制差异很大，先探测再定 `RPC_URL`。

**怎么做**：

```bash
cd /opt/zyt/zyt/zyt-keeper
node scripts/rpc-probe.mjs <MINING_ADDR> <START_BLOCK>
```

**怎么验证**：输出各候选节点结果，选可返回历史日志且无 `-32701` 剪枝错误的节点填回 `.env`。若全部受限，改用付费归档节点（Ankr / QuickNode / NodeReal）。

### 步骤 22 前台试跑

```bash
cd /opt/zyt/zyt/zyt-keeper
node src/index.js
```

**怎么验证**：日志依次出现

| 日志 | 含义 |
| -- | -- |
| `service: start chain=56` | 链配置正确 |
| `indexer: ok initial sync +N events` | 事件索引正常 |
| `ledger: ok rebuild users=N` | 账本重建（主网初始 N=0） |
| `keeper: start cron="1 0 * * *" tz=UTC signer=0x...` | 快照调度就绪，signer 应为你的 keeper 地址 |
| `api: start http://0.0.0.0:8080` | API 就绪 |

确认无误后 `Ctrl+C`。

### 步骤 23 转 PM2 守护

```bash
cd /opt/zyt/zyt/zyt-keeper
pm2 start src/index.js --name zyt-keeper --time
pm2 save
pm2 startup            # 按提示执行输出的一行 sudo 命令
pm2 status
```

**怎么验证**：`pm2 status` 显示 `online`；`pm2 logs zyt-keeper --lines 30` 无 error。

### 步骤 24 日志轮转

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
```

**怎么验证**：`pm2 conf pm2-logrotate` 有输出。

---

## 七、Nginx 与域名

### 步骤 25 写站点配置

**做什么**：静态站 + `/api/` 反代 keeper。模板在 `zyt-keeper/deploy/nginx-zyt.conf`。

**怎么做**：

```bash
sudo cp /opt/zyt/zyt/zyt-keeper/deploy/nginx-zyt.conf /etc/nginx/sites-available/zyt
sudo sed -i 's/server_name .*/server_name <你的域名>;/' /etc/nginx/sites-available/zyt
sudo ln -sf /etc/nginx/sites-available/zyt /etc/nginx/sites-enabled/zyt
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
```

**怎么验证**：`nginx -t` 输出 `syntax is ok` 与 `test is successful`。配置要点复核：

| 要点 | 说明 |
| -- | -- |
| `root /var/www/html` | 前端产物目录 |
| `location /api/ { proxy_pass http://127.0.0.1:8080/; }` | 反代 keeper，注意末尾斜杠 |
| `try_files $uri $uri/ /index.html` | SPA 路由回退 |
| `gzip on` + static 缓存头 | 首屏性能 |

### 步骤 26 启用并重载

```bash
sudo systemctl reload nginx
sudo systemctl enable nginx
curl -sI http://<你的域名>/ | head -3
```

**怎么验证**：返回 `HTTP/1.1 200`。

### 步骤 27 签发 HTTPS 证书

```bash
sudo certbot --nginx -d <你的域名> --redirect -m <你的邮箱> --agree-tos -n
sudo certbot renew --dry-run
```

**怎么验证**：`curl -sI https://<你的域名>/` 返回 200；`certbot renew --dry-run` 成功。

---

## 八、端到端验收

### 步骤 28 服务状态

```bash
pm2 status
sudo systemctl status nginx --no-pager | head -5
sudo ss -lntp | grep -E ":(80|443|8080|3306)"
```

**怎么验证**：keeper `online`、nginx active、80/443/8080 监听、3306 仅本地。

### 步骤 29 本地 API 直连

```bash
curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8080/stats | head -c 300; echo
```

**怎么验证**：`/health` 返回 `{"ok":true}`；`/stats` 的 `pool.pool_usdt` 为 21000 量级、`price` 约 1e13、`stage` 为 1。

### 步骤 30 经 Nginx 的 API

```bash
curl -s https://<你的域名>/api/health
curl -s https://<你的域名>/api/stats | head -c 200; echo
```

**怎么验证**：与步骤 29 结果一致。

### 步骤 31 页面与钱包

**怎么做**：浏览器打开 `https://<你的域名>`，MetaMask 切到 BSC 主网，连接钱包，看到仪表盘数据。

**怎么验证**：池数据、价格、阶段、销毁数、LP 持有量均非 `--` 且与 `/api/stats` 一致；邀请码可绑定；买入在阶段 1 显示禁用。

### 步骤 32 链上对账

```bash
cd /opt/zyt/zyt/zyt-keeper
node scripts/reconcile.js
```

**怎么验证**：输出「对账 N 用户一致」。若不一致，用下面命令以链上为准重建账本：

```bash
node scripts/rebuild-ledger-from-chain.mjs
```

### 步骤 33 快照手测（不污染权重）

```bash
# 方式 A（服务器侧，走 keeper 内部逻辑，force 模式）
cd /opt/zyt/zyt/zyt-keeper
node scripts/snapshot-now.js

# 方式 B（部署机侧，直接发链上交易；会读 keeper /stats 自动取权重）
#   本地 Windows 执行
cd F:/zyt/zyt-contracts
node scripts/trigger-snapshot.mjs --dry          # 只检查不发交易
node scripts/trigger-snapshot.mjs                # 真实触发（内置 0 权重拒绝）
```

**注意**：`totalPower` 传 0 会让当日分红分母为 0，用户无法结算该日分红，且同日不可重跑。方式 B 内置了 0 值拒绝保护，优先使用方式 B。

**怎么验证**：`/stats` 的 `lastSnapshot.day` 变为当日；主网首日无用户时可先跳过，让 cron 自然触发。

### 步骤 34 重启幂等

```bash
pm2 restart zyt-keeper
pm2 logs zyt-keeper --lines 20
```

**怎么验证**：重启后索引器从 DB 游标续接（不重扫历史），账本 `users=N` 保持，API 恢复。

---

## 九、上线前 24 小时与上线后观察

### 上线前 24h（小额真金全流程）

| 步骤 | 操作 | 期望 |
| -- | -- | -- |
| 1 | 用团队钱包入金 100 U | 40% 直发、60% 组 LP 销毁、算力与买额到账 |
| 2 | 卖出部分 ZYT | 滑点 5% 起，30/30/40 分配，`withdrawTotal` 等于卖出实收 |
| 3 | 次日查分红 | `/api/dividend/<地址>` 的 `todayAccrual` > 0 |
| 4 | 提取分红 | 链上到账，`pending` 归零 |
| 5 | 推荐绑定 | 上级关系固化，代数 = 直推数 |
| 6 | 记录页 | 入金/买入/卖出/转账流水齐全 |
| 7 | 合约 verify | bscscan 上 10/10 verified |

### 上线后 48h

| 时点 | 检查 |
| -- | -- |
| T+8h | `/stats` 的 `todayDeposit`、`networkPower`、`burned` 有值 |
| 次日 08:05 | `lastSnapshot.day` 为当日（cron + 防漏自检双保险） |
| T+24h | 对账一致；池 USDT 随入金增长、池 ZYT 随通缩下降 |
| T+48h | 监控无 R1/R4/R5 告警；keeper BNB 余额充足 |

---

## 十、日常运维

### 常用命令

```bash
pm2 status && pm2 logs zyt-keeper --lines 100
sudo systemctl reload nginx
curl -s http://127.0.0.1:8080/stats | head -c 200; echo
```

### 更新代码

```bash
cd /opt/zyt/zyt/zyt-keeper
git pull
npm install --omit=dev
pm2 restart zyt-keeper
# 前端产物更新（本地构建后上传，步骤 16-17）
```

### 数据库备份

```bash
sudo mkdir -p /var/backups/zyt
sudo crontab -e
# 加一行（每日 03:30 备份，保留 14 天）
30 3 * * * mysqldump -u zyt_keeper -p'<数据库密码>' zyt_keeper | gzip > /var/backups/zyt/zyt_$(date +\%F).sql.gz && find /var/backups/zyt -name "*.sql.gz" -mtime +14 -delete
```

### 账本重建（数据与链上不一致时）

```bash
cd /opt/zyt/zyt/zyt-keeper
node scripts/rebuild-ledger-from-chain.mjs
node scripts/reconcile.js
```

### 监控告警

- keeper 内置 R1 到 R5 规则（大额卖出、索引延迟、错误率、池异常、通缩），输出到 `keeper_runs` 表与 `ALERT_WEBHOOK_URL`
- 建议把 `pm2` 崩溃通知与服务器磁盘、内存告警一并接入

---

## 十一、上线检查清单

### 合约侧

- [ ] 门禁 A 通过（`mainnet-preflight.mjs` FAIL 0）
- [ ] 部署记录 JSON 归档 `deployments/mainnet-<日期>.json`
- [ ] 门禁 B 通过（字节码一致性，剔 metadata 后 sha256 全一致）
- [ ] verify 10/10
- [ ] 参数核对（0.2 节表 + 步骤 5）
- [ ] 买入门控确认（stage 1 禁买 / swapGate 复位 / 卖闸生效）
- [ ] owner 是否转 Gnosis Safe（长期项，可上线后执行）

### keeper 侧

- [ ] `.env` 无 `<...>` 占位符（`grep -c "<" .env` 为 0）
- [ ] `git check-ignore .env` 有输出（未入库）
- [ ] `check-keeper-interfaces.mjs --probe` 无缺失
- [ ] `rpc-probe.mjs` 选定的 RPC 可查历史日志
- [ ] keeper 地址 BNB 余额 ≥ 0.05
- [ ] PM2 守护 + 开机自启（`pm2 startup`）
- [ ] 日志轮转已配
- [ ] DB 备份 cron 已配

### 前端侧

- [ ] `BSC_MAINNET` 段 10 个地址全部换为正式版
- [ ] `usdt` 为真实 USDT `0x55d39832...`
- [ ] `apiBase` 为同源 `/api`
- [ ] `vue-tsc` 零错，`VITE_CHAIN=bsc vite build` 成功
- [ ] 文案三语无收益承诺字样

### 服务器侧

- [ ] 时区 UTC
- [ ] MySQL 仅监听 127.0.0.1
- [ ] Nginx 反代与 SPA 回退正常
- [ ] HTTPS 证书签发并自动续期

### 上线前 24h 与上线后

- [ ] 小额真金全流程通过（步骤 34 表）
- [ ] 次日 08:05 快照验证
- [ ] 48h 监控无告警

---

## 附录 A 需替换项速查（一页版）

| 类别 | 位置 | 需替换 |
| -- | -- | -- |
| 私钥 | 本地 `zyt-contracts/.env` | `PRIVATE_KEY` 换主网 deployer |
| 私钥 | 服务器 `zyt-keeper/.env` | `KEEPER_PRIVATE_KEY` 新建 keeper 钥 |
| 地址 | 本地 `zyt-contracts/.env` | `MARKET_ADDRESS`、`TECHNICAL_ADDRESS`、`KEEPER_ADDRESS` |
| 地址 | 服务器 `zyt-keeper/.env` | 8 个合约地址 + `START_BLOCK` |
| 地址 | 前端 `zyt-dapp/src/config/index.ts` | `BSC_MAINNET.contracts` 10 项 + `usdt` 真实地址 |
| 密码 | 服务器 MySQL | `zyt_keeper` 用户强密码，写入 `DB_URL` |
| 令牌 | 服务器 `.env` | `API_ADMIN_TOKEN` 随机新串 |
| 域名 | `.env` / Nginx / 前端 | `CORS_ORIGIN`、`server_name`、DNS A 记录 |
| 邮箱 | certbot | 证书通知邮箱 |
| 钱包 | MetaMask | 添加 BSC 主网自定义网络（chainId 56） |

---

## 附录 B 已知易错点（沿用测试链踩坑）

| 坑 | 现象 | 规避 |
| -- | -- | -- |
| publicnode 用于部署 | hardhat 崩（返回 `to:""`） | 部署改用 `bsc-dataseed1/2/3.bnbchain.org` |
| 公共 RPC 剪枝历史 | 索引器 `-32701`，账本缺事件 | 用 `rpc-probe.mjs` 选节点；keeper 已内置剪枝自愈与 DB 游标续接 |
| 链下账本用入库时间算入金日 | 算力/入单差 1% | keeper 已改用链上 `block_time`；接口层用链上现值反推 |
| 改源码忘编译 | 部署旧字节码 | 门禁 A 检查 artifacts mtime，门禁 B 比对字节码 |
| 快照传 0 权重 | 分红分母错误 | 只用 `trigger-snapshot.mjs`（内置 0 值拒绝） |
| 快照被系统睡眠跳过 | 当日无快照 | keeper 已加启动自检 + 每 10min 幂等补跑 |
| `pkill` 在 Windows Git Bash 无效 | 旧进程占用 8080，新进程起不来 | 用任务管理器或等价方式结束进程 |
| `.env` 从本地上传 | 私钥可能混入旧值 | 服务器上重写，本地不上传 |
| 域名注册在境内 | 需 ICP，流程受阻 | 域名境外注册与解析 |

---

## 附录 C 与测试链部署的差异对照

| 项 | 测试链（DEPLOYMENT_AWS_TESTNET.md） | 主网（本文档） |
| -- | -- | -- |
| `CHAIN_ID` | 97 | 56 |
| RPC | publicnode testnet | bsc-dataseed1/2/3 与探测后的 keeper RPC |
| USDT | MockUSDT | 真实 USDT，需 approve 流程一致但余额真实 |
| 初始底池 | Mock 铸造 2.1 万 | deployer 真实持 21000 USDT |
| keeper 钱包 | 必须复用已登记地址 | 可新建（部署时写入） |
| 合约 owner | 部署者 EOA | 建议转 Gnosis Safe |
| `CORS_ORIGIN` | `*` 可用 | 必须为正式域名 |
| 买入白名单 | v8 有（`toggle-whitelist-mainnet.mjs`） | v9 已移除，靠阶段 + 卖闸 + swapGate 门控 |
| 门禁脚本 | 可跳过 | 门禁 A / B 必须 FAIL 0 |
| verify | 可选 | 必须 10/10 |

---

> 文档版本 v1.0（2026-09-26）｜适用范围：BSC 主网（chainId 56）+ 境外 Ubuntu 单机部署
> 文档维护：主网部署完成后，把 0.2 节表逐项回填，并把部署记录 JSON 路径补进本节底部。
