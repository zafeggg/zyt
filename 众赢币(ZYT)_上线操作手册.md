# 众赢币（ZYT）上线操作手册

> **配套文档**：《众赢币(ZYT)_上线流程清单.md》（勾选用）；本手册回答"每一步**做什么、怎么做、做到什么程度算通过**"。
> **约定**：`$` 开头为 shell 命令（Git Bash）；`【确认】`为通过标准；`<占位符>`按实际替换。
> **边界**：ZYT 独立运营，不使用 GYT 服务器；keeper 本地模式运行。
> **版本**：v2.0（2026-09-14）｜ **本版为「主网执行版」**：阶段 1 新增 1.3.7 主网参数总表、1.3.8 keeper 配置替换、1.3.9 前端配置替换、1.5 主网部署执行；testnet 内容保留作为参照，标注 `【参照】`。

---

## 主网待填参数总表（部署完成后逐项回填）

> 用法：部署主网后，从部署脚本输出中提取下列值，同时填入三处（前端 config / keeper .env / 文档），三处必须一致。

### A. 合约地址（9 项，deploy.js 输出）

| # | 合约 | 主网地址 | 已填前端 | 已填 keeper |
|---|---|---|---|---|
| 1 | ZYTConfig | `待填` | ☐ | ☐ |
| 2 | GSTToken | `待填` | ☐ | 不需（keeper 不读） |
| 3 | ZYTToken | `待填` | ☐ | ☐ |
| 4 | ZYTPoolManager | `待填` | ☐ | ☐ |
| 5 | ZYTMining | `待填` | ☐ | ☐ |
| 6 | ZYTReferral | `待填` | ☐ | 不需（keeper 不读） |
| 7 | ZYTDeflation | `待填` | ☐ | ☐ |
| 8 | ZYTForceSell | `待填` | ☐ | ☐ |
| 9 | ZYTCompute（库） | `待填` | 不需 | 不需 |

### B. 地址类参数（多签 / 钱包）

| 项 | 取值来源 | 主网地址 | 用途 |
|---|---|---|---|
| 营销地址 W3（营销 Safe） | app.safe.global 创建（BSC 主网）**已链上核验 2026-09-14：threshold 2 / owners 3（2/3 ✓）** | `0x1bc03Fe18F9BabBc32f0B4046E13e387E9D16786` | `MARKET_ADDRESS`（已在 `.env`）；`config.marketAddress()`；**前端 rootInvite** |
| 技术地址 W4（技术 Safe） | app.safe.global 创建（BSC 主网）**已链上核验 2026-09-14：threshold 2 / owners 2（2/2 ✓）** | `0x860D4704d6eee98Aa55A971Caf8BAA4134E8eec3` | `TECHNICAL_ADDRESS`（已在 `.env`）；`config.technicalAddress()`。⚠️ 2/2 任一 signer 丢失即永久锁死，建议改 2/3 或 1/2；keeper 保持 EOA 不上多签 |
| keeper 签名钱包 W5 | 新建独立 EOA | **⚠ 待填：`.env` 当前未设置 `KEEPER_ADDRESS`** | `KEEPER_ADDRESS`；keeper `.env` 签名私钥。**不填会缺省为 deployer，导致 owner 移交多签后无人可触发每日快照** |
| 治理多签 W2 | 钱包清单方案 A | `待填` | 部署后 `transferOwnership` 目标 |
| 部署钱包 W1 | 钱包清单方案 A | `待填` | 部署后退役冷备（私钥存本地 `.env`，不上服务器） |

**核验记录（2026-09-14，RPC `bsc.publicnode.com`，chainId 56）**

| Safe | 地址 | 字节码 | threshold | owners |
|---|---|---|---|---|
| 营销 W3 | `0x1bc03Fe18F9BabBc32f0B4046E13e387E9D16786` | SafeProxy 已部署 | 2 | `0x77B649f7…deB37`、`0x28E4A5B4…f20C4`、`0x2aE3BA7a…46A526` |
| 技术 W4 | `0x860D4704d6eee98Aa55A971Caf8BAA4134E8eec3` | SafeProxy 已部署 | 2 | `0x2aE3BA7a…46A526`、`0xE30471a7…a6eD1` |

> 注：`0x2aE3BA7a…46A526` 同时为两个 Safe 的 owner（交叉持有）；技术 Safe 2/2 的锁死风险已多次提示，上线前建议调整。

### C. 运行参数

| 项 | 主网取值 | 说明 |
|---|---|---|
| `CHAIN_ID` | `56` | keeper .env |
| `RPC_URL` | `待填`（主网 RPC） | keeper .env |
| `START_BLOCK` | `待填`（部署区块高度） | keeper .env，用于事件索引起点 |
| `poolStage1USDT` | `0` | 决策 17，初始即 stage2 |
| `poolStage2USDT` | `20000000` | 2000 万 U |
| `buyWhitelistEnabled` | `true` | 主网必须开启（防闪电贷） |
| `deflationFloor` | 500 万枚 | 通缩下限 |
| 滑点档位 tier1-4 | 1000 / 2000 / 3000 / 4000 | 对应 1/2/3/4% 触发 |
| 前端 `rootInvite` | 营销 Safe 地址 | `zyt-dapp/src/config/index.ts` BSC_MAINNET |
| 前端 `apiBase` | 主网 API 域名反代 | 或构建时 `VITE_API_BASE` 注入 |

---

## 阶段 0：上线准入与冻结（T-7 天）

### 0.1 确定上线范围
- **做什么**：列全本次上线的所有变更（合约参数 / 前端功能 / keeper 配置 / 文档）
- **怎么做**：
  ```bash
  $ git log --oneline <上一版tag>..HEAD        # 列出全部提交
  $ git diff --stat <上一版tag>..HEAD          # 变更文件统计
  ```
  整理为三列表格：变更点 / 影响面 / 回滚方式
- **【确认】** 表格经产品 + 技术双方确认，范围外需求一律进下版本

### 0.2 代码冻结
- **做什么**：关闭非修复类合并入口
- **怎么做**：仓库设置 release 分支保护（仅管理员可推）；群公告冻结时间点；此后变更需走审批
- **【确认】** 用一个测试 PR 验证合并被拒

### 0.3 版本规划
- **做什么**：定版本号、打 tag、写 CHANGELOG、锁定回滚基准
- **怎么做**：
  ```bash
  $ git tag -a vX.Y.Z -m "release: 一句话说明"
  $ git push origin vX.Y.Z
  ```
  在 CHANGELOG.md 追加本版变更；**单独记录**：回滚基准 = 当前生产版本号 + commit hash
- **【确认】** tag 可在远端查到；CHANGELOG 无遗漏提交

### 0.4 确定上线窗口
- **做什么**：选定执行时间
- **怎么做**：选业务低峰；**避开每日 08:00-08:10 快照/通缩窗口**（快照前后各留 1 小时缓冲）；建议 14:00-17:00（白天响应快、跨部门在线）
- **【确认】** 窗口写入群日历，参与人确认

### 0.5 组织与分工
- **做什么**：定角色与沟通机制
- **怎么做**：指定 决策人（Owner）/ 执行人 / 复核人；建上线专用群；准备操作记录模板（时间/命令/输出截图）
- **【确认】** 三角色人员群内 @ 确认到位

### 0.6 Go/No-Go 评审
- **做什么**：上线前最终决策会
- **怎么做**：逐项过《流程清单》；**一票否决项** = 审计高危未闭环 / 备份未实际恢复过 / 回滚未演练过 / 多签未就绪
- **【确认】** 全绿 → Go；任一否决项存在 → No-Go 并改期

---

## 阶段 1：上线前准备（T-5 至 T-1 天）

### 1.1 代码合并与构建

#### 1.1.1 合并 develop
```bash
$ git checkout develop && git pull
$ git merge --no-ff feature/xxx     # 逐个合并，冲突即解决
$ git push origin develop           # CI 必须全绿
```
**【确认】** CI 流水线最后一次运行绿色

#### 1.1.2 创建 release 分支
```bash
$ git checkout -b release/vX.Y.Z && git push -u origin release/vX.Y.Z
```
此后仅 P0 修复 cherry-pick 进入；每个 cherry-pick 需重新跑测试

#### 1.1.3 代码评审
- **怎么做**：PR 至少 1 名高级成员 approve；**资金/密钥/权限相关模块 2 人 approve**
- **【确认】** PR 合并记录中可见审批人

#### 1.1.4 生产构建
```bash
# 合约
$ cd F:/zyt/zyt-contracts && npx hardhat compile
# 前端
$ cd F:/zyt/zyt-dapp && npx vite build
```
**【确认】** compile 0 error；`dist/` 生成且 index.html 引用完整；记录构建产物哈希

#### 1.1.5 产物归档
- **怎么做**：`dist/` + `artifacts/` + 部署记录 打包为 `release-vX.Y.Z-YYYYMMDD.zip`，存本地归档目录 + 一份异介质
- **【确认】** 归档包可在干净环境解压还原

#### 1.1.6【ZYT】字节码一致性核对
```bash
$ cd F:/zyt/zyt-contracts && node scripts/probe-bytecode.js
```
**【确认】** 全部 match（ZYTMining 仅库链接占位符差异属正常，脚本已处理说明）

#### 1.1.7【ZYT】bscscan 源码验证
```bash
# testnet（已完成 9/9，作为主网流程参照）
$ npx hardhat run scripts/verify-all-testnet.js --network bscTestnet
# 主网（脚本已就绪 2026-09-14：scripts/verify-all-mainnet.js）
$ npx hardhat run scripts/verify-all-mainnet.js --network bsc
#   地址回填：填脚本内 ADDR_DEFAULTS，或环境变量注入 ZYT_CONFIG / ZYT_GST / …
#   自带三重防呆：地址完整性 / chainId 必须 56 / USDT 必须为 BSC 官方地址
```
**【确认】** 9/9 Successfully verified；bscscan 每个合约 `#code` 页绿色勾

#### 1.1.8【ZYT】前端缓存参数
- **怎么做**：编辑 `dist/index.html`，所有 `<script>/<link>` 引用追加 `?v=YYYYMMDDxx`（与本次发布日期一致）
- **【确认】** 无痕浏览器打开页面 → F12 view-source 逐条检查引用均带新 `?v=`

### 1.2 测试验收

#### 1.2.1 单元测试
```bash
$ cd F:/zyt/zyt-contracts && npx hardhat test
```
**【确认】** 44/44 全绿（新增用例后数字同步更新）

#### 1.2.2 冒烟测试

**【参照】testnet 全链路（上线前回归用）**
```bash
$ USDT_MOCK=1 npx hardhat run scripts/smoke-testnet.js --network bscTestnet
```
**【确认】** P0-P6 共 45/45 断言 PASS；如报 `no dividend`（当日分红已被领取）属正常，次日重跑

**【主网】小额真实链路冒烟（部署后、公告前执行）**
- 前提：白名单已放行测试地址（附录 D）、底池已注入、keeper 已切主网
- 步骤：用小额真实 USDT（建议 10-50U）走完整用户旅程
  1. 连接钱包 → 注册（填邀请码）→ 授权 USDT
  2. 入金 `deposit(amount, ref)` → 核对链上推荐绑定生效（`referrerOf(测试地址)` 非零）
  3. 次日 08:00 快照后：核对产出领取、分红领取
  4. 卖出小额：核对滑点档位与 30/30/40 分账
  5. keeper 侧：`/stats`、`/user`、`/force-sell` 数据与链上一致
- **【确认】** 全链路无 revert；入金金额与分账比例吻合；keeper 账本与链上一致；测试交易 hash 归档
- ⚠️ 主网测试资金真实消耗，金额务必小额，测试完成后评估是否继续持有

#### 1.2.3 UAT 业务验收
- **怎么做**：产品在 staging（或 testnet 前端）完整走用户旅程：连接钱包 → 授权 → 入金 → 产出 → 分红 → 卖出 → 转账；每步截图
- **【确认】** 验收单签字，截图归档

#### 1.2.4 性能压测（keeper API）
```bash
$ npx autocannon -d 30 -c 50 http://127.0.0.1:8080/stats
```
**【确认】** P95 延迟 < 500ms、非 2xx 比例 = 0；不达标先加限流/优化再上线

#### 1.2.5 安全扫描
```bash
$ npm audit --production      # contracts / dapp / keeper 三个目录各跑一次
```
**【确认】** 无 high/critical；有则升级依赖修复并回归
【ZYT】GoPlus 对主网合约地址检测：恶意标签 / 可升级风险 / 黑名单函数检查通过

#### 1.2.6【ZYT】审计闭环核对
- **怎么做**：把两轮审计报告的 finding 逐条制成状态表（编号/级别/结论/Fixed|ACK）
- **【确认】** 高危 100% Fixed；中危 Fixed 或有书面 ACK；表格双方签字

### 1.3 环境配置

#### 1.3.1 基础设施检查
```bash
# 证书有效期（主网域名上线前）
$ openssl s_client -connect <域名>:443 | openssl x509 -noout -dates
# 磁盘/内存
$ df -h && free -h
```
**【确认】** 证书剩余 > 30 天；磁盘使用 < 70%

#### 1.3.2 环境变量核对（脱敏）
```bash
$ grep -v -i "KEY\|PASSWORD\|SECRET\|PRIVATE" .env    # 非敏感项打印核对
$ grep -c -i "KEY\|PASSWORD\|SECRET" .env             # 敏感项只数键名，不打印值
```
- **【确认】** 非敏感项逐行与配置文档一致；敏感项键名齐全且值非空（长度抽查）
- **怎么做（防泄漏）**：核对过程屏幕共享给复核人，但不录屏不截图敏感值

#### 1.3.3【ZYT】合约参数核对表
- **怎么做**：用 hardhat console 或扩展 `scripts/probe-stage.mjs` 逐项读链上值并与部署记录比对：
  - `config.owner()` == W2 治理多签地址（**owner 移交后核对**）
  - `config.marketAddress()` == W3 营销 Safe（**同时作为前端 rootInvite 取值**）
  - `config.technicalAddress()` == W4 技术 Safe
  - `config.keeperAddress()` == 签名钱包地址（W5）
  - `config.buyWhitelistEnabled()` == true（**主网必须开启**）
  - `config.deflationFloor()` == 500 万枚
  - `pool.poolStage1USDT()/poolStage2USDT()` == 部署决策值（0 / 2000 万）
  - 滑点档位 tier1-4 == 1000/2000/3000/4000
  - `pool.buyWhitelist(<各白名单地址>)` == true
- **【确认】** 每项打印值与部署记录一致，形成核对表存档；任何一项不符即为 No-Go（owner 未移交、白名单总开关关闭属高危项）

#### 1.3.4【ZYT】Gnosis Safe 多签
- **状态（2026-09-14 已核验）**：营销 Safe `0x1bc03F…6786`（threshold 2 / owners 3）与技术 Safe `0x860D47…eec3`（threshold 2 / owners 2）均已在 BSC 主网部署，字节码为 SafeProxy；核验记录见顶部 B 表
- **怎么做**：①上述核验已完成，如需复核可再跑 `getOwners()` / `getThreshold()`；②**在 testnet 或用模拟交易完整走一遍** setUint 提案-签名-执行流程（签名人数、确认顺序、执行延迟）；③部署时以两个 Safe 地址注入 `MARKET_ADDRESS` / `TECHNICAL_ADDRESS`（二者已在 `zyt-contracts/.env`）
- **【确认】** 多签地址已接管合约 owner（`owner()` 返回 W2 治理 Safe 地址）；提案-签名-执行演练记录截图
- ⚠️ 技术 Safe 当前 2/2，任一 signer 丢失即永久锁死，建议调整为 2/3 或 1/2；keeper 保持 EOA，不纳入多签

#### 1.3.5【ZYT】keeper 签名钱包核对
```bash
$ cd F:/zyt/zyt-keeper && node -e "
import('ethers').then(({Wallet})=>{
  const w=new Wallet(require('dotenv').config().parsed.KEEPER_PRIVATE_KEY);
  console.log('signer =', w.address);
})"
```
**【确认】** 输出地址 == 链上 `config.keeperAddress()`；该地址不持有项目资金、私钥仅存于运行环境 .env（已被 .gitignore 排除）

#### 1.3.6 告警通道实测
```bash
$ curl -X POST "$ALERT_WEBHOOK_URL" -H "Content-Type: application/json" -d '{"text":"[TEST] 上线前告警通道验证"}'
```
**【确认】** 接收端（群/手机）真实收到消息；未收到则修复 webhook 后重测

#### 1.3.7【ZYT】keeper 配置替换（testnet → 主网）

逐项替换 `zyt-keeper/.env`，**替换后不复用 testnet 值**：

| 变量 | testnet 现值 | 主网改为 | 核对点 |
|---|---|---|---|
| `CHAIN_ID` | `97` | `56` | 与前端 chainId 一致 |
| `RPC_URL` | testnet publicnode | 主网 RPC | 可达性 + 支持 getLogs |
| `MINING_ADDR` | `0x1ffC…5703` | 主网 ZYTMining | 与前端 config 一致 |
| `POOL_ADDR` | `0x0209…DcfD` | 主网 ZYTPoolManager | 同上 |
| `DEFLATION_ADDR` | `0x16E8…29a9` | 主网 ZYTDeflation | 同上 |
| `CONFIG_ADDR` | `0x55F4…cDbd` | 主网 ZYTConfig | 同上 |
| `ZYT_ADDR` | `0xdF18…4166` | 主网 ZYTToken | 同上 |
| `FORCESELL_ADDR` | `0x2468…ce06` | 主网 ZYTForceSell | 同上 |
| `START_BLOCK` | `130555566` | **主网部署区块高度** | 事件索引起点，错填会漏事件或空跑 |
| `KEEPER_PRIVATE_KEY` | testnet 明文私钥 | **新建独立钱包**（严禁沿用） | 地址 == `config.keeperAddress()` |
| `DB_URL` | `zyt_keeper` 库 | **`zyt_keeper_mainnet`（2026-09-14 定案）** | 库创建成功；启动时 7 表自动建；MySQL 用户权限独立于 testnet 库 |
| `ALERT_WEBHOOK_URL` | 空 | 真实 webhook | 实测能收到告警 |
| `SNAPSHOT_CRON` | `0 0 * * *` | 保持（UTC 0 点 = 北京 08:00） | 时区已显式 UTC |

**【确认】** `node -e "import('dotenv').config()"` 逐项打印核对，敏感项只对数不打印；启动日志 `chain=56`、`signer=0x…`、`ledger: rebuild users=0`
⚠️ **私钥规范（2026-09-14 决策：明文 .env 方案）**：keeper 签名私钥明文存服务器 `zyt-keeper/.env`，须执行 `chmod 600 .env` + `git check-ignore .env` 复核；keeper 地址无资金权限（仅触发 dailySnapshot），泄露止损 = owner 调 `setAddress("keeperAddress", 新地址)`。完整规范见 `docs/主网密钥管理清单.md`；长期化解风险方式为 owner 转 Safe 多签

#### 1.3.8【ZYT】前端配置替换（testnet → 主网）

编辑 `zyt-dapp/src/config/index.ts` 的 `BSC_MAINNET` 分支：

| 字段 | 当前值 | 主网改为 |
|---|---|---|
| `contracts.config` / `gst` / `zyt` / `forceSell` / `pool` / `referral` / `mining` / `deflation` | 全空 | 主网 8 合约地址 |
| `contracts.usdt` | `0x55d3…7955` | 保持（BSC 官方 USDT） |
| `rootInvite` | 空 | 营销 Safe 地址（官方根邀请码） |
| `apiBase` | `/api` | 主网 API 域名反代，或构建时注入 `VITE_API_BASE` |
| `rpc` | binance dataseed | 可保持，建议配置备用 RPC |

**【确认】** `npm run typecheck` 通过；本地以 `VITE_CHAIN=bsc` 构建后在 bscscan 对照地址无误
**另需核对**：`VITE_CHAIN=bsc` 为构建时变量，构建命令需显式指定，避免误打 testnet 包

### 1.4 数据备份与恢复演练

#### 1.4.1 MySQL 全量备份
```bash
$ mysqldump -u zyt_keeper -p --single-transaction zyt_keeper > backup_zyt_keeper_$(date +%Y%m%d).sql
```
**【确认】** 文件生成、大小合理（`ls -lh`）、尾部有 "Dump completed"

#### 1.4.2 恢复演练（必须实际做一次）
```bash
$ mysql -u zyt_keeper -p -e "CREATE DATABASE zyt_keeper_restore"
$ mysql -u zyt_keeper -p zyt_keeper_restore < backup_zyt_keeper_YYYYMMDD.sql
$ mysql -u zyt_keeper -p -e "SELECT (SELECT count(*) FROM zyt_keeper_restore.events) evt, (SELECT count(*) FROM zyt_keeper_restore.users) usr"
```
**【确认】** 行数与原库一致；演练记录写入上线文档

#### 1.4.3【ZYT】合约部署产物冷备
- **怎么做**：`artifacts/`、abi、构造参数、部署 tx hash、部署私钥 → 拷贝至离线 U 盘（两份异地）
- **【确认】** 冷备清单签字；抽查 U 盘可读

#### 1.4.4【ZYT】资金状态快照
- **怎么做**：记录底池 GST/ZYT/USDT、多签余额、营销地址余额（bscscan 截图 + 数值表）
- **【确认】** 数值与 keeper `/stats` 一致，归档

### 1.5【ZYT】主网合约部署执行（T-1 前完成，T-0 只做应用层）

> 纪律：主网部署**不可回滚**。执行前确认阶段 0 的 Go 结论 + 钱包准备完成；执行中每步【确认】后才进下一步。

#### 1.5.1 部署环境变量（deploy.js 读取，缺一不可）

```bash
$ cd F:/zyt/zyt-contracts
# 推荐方式：交互确认（打印 chainId 与 deployer，人工输 yes 才发交易）
$ MARKET_ADDRESS=<W3 营销 Safe> \
  TECHNICAL_ADDRESS=<W4 技术 Safe> \
  KEEPER_ADDRESS=<W5 keeper 签名钱包> \
  WHITELIST=<首批白名单地址,逗号分隔> \
  npx hardhat run scripts/deploy.js --network bsc

# 脚本化方式（跳过交互确认，仅限已完整演练后使用）
$ CONFIRM_MAINNET=1 <同上四个变量> npm run deploy:mainnet
```

⚠️ 部署私钥存放在本地 `zyt-contracts/.env` 的 `PRIVATE_KEY`（不在服务器；规范见 `docs/主网密钥管理清单.md`）；部署前确认 deployer 已充 ≥0.05 BNB（gas）与 2.1 万 USDT（底池 initialize）；部署完成后立即清除或换回测试私钥。

| 变量 | 作用 | 缺省行为（**主网禁止依赖缺省**） |
|---|---|---|
| `CONFIRM_MAINNET=1` | 主网部署确认闸 | 未设则脚本拒绝执行 |
| `MARKET_ADDRESS` | 营销地址 | 缺省 = deployer（错误，资金进部署钱包） |
| `TECHNICAL_ADDRESS` | 技术地址 | 缺省 = deployer（错误） |
| `KEEPER_ADDRESS` | keeper 权限地址 | 缺省 = deployer（错误） |
| `WHITELIST` | 部署时批量加白 | 缺省空（主网将无人可入金） |
| `USDT_MAINNET` | 官方 USDT | 默认 `0x55d3…7955`，核对即可 |
| `ROUTER_MAINNET` | PancakeRouter | 默认 `0x10ED…024E`，核对即可 |
| `USDT_MOCK` | **绝对不可设 1** | 设 1 会用 MockUSDT，资产无效 |

**【确认】** 启动日志回显 network = bsc(56)、deployer 地址、四个地址参数；出块确认前人工二次核对参数

#### 1.5.2 部署产物归档
- 记录：9 合约地址、部署 tx hash、区块高度（作为 keeper `START_BLOCK`）、构造参数、gas 消耗
- **【确认】** 写入《主网待填参数总表》A/B/C 三表；artifacts 冷备

#### 1.5.3 字节码核对与源码验证
```bash
$ node scripts/probe-bytecode.js
$ npx hardhat run scripts/verify-all-mainnet.js --network bsc   # 脚本已就绪，先回填地址
```
**【确认】** 字节码全部 match；bscscan 9/9 合约页 `#code` 绿色勾

#### 1.5.4 参数核对（见 1.3.3）
**【确认】** owner / marketAddress / technicalAddress / keeperAddress / buyWhitelistEnabled / stage 阈值 / 滑点档位 / 白名单逐项一致

#### 1.5.5 owner 移交 W2 治理多签
```bash
# hardhat console 内（先确保 .env RPC 指向主网、使用部署私钥）
#   const cfg = await ethers.getContractAt("ZYTConfig", "<ZYTConfig地址>")
#   await (await cfg.transferOwnership("<W2 地址>")).wait()
#   await cfg.owner()     # 期望 == W2
```
**【确认】** `config.owner() == W2`；deployer 已无管理权限（尝试 setUint 应 revert）；移交 tx 归档
**后续所有参数/白名单变更均走 W2 多签提案-签名-执行**

#### 1.5.6 建池与底池注入
- 建 GST/USDT 池（约 2.1 万 U 等值）→ 注入底池 → **LP 100% 打黑洞**（公示销毁哈希）
- **【确认】** 池子可正常兑换；黑洞地址 LP 余额与公示哈希一致；`pool` 合约读到的底池值与注入量吻合

#### 1.5.7 keeper 切主网并首日验证
```bash
$ cd F:/zyt/zyt-keeper
$ node src/index.js     # 或 pm2 start src/index.js --name zyt-keeper
```
**【确认】** 启动日志 `chain=56` → `indexer: ok` → `ledger: rebuild` → `keeper: start cron` → `api: start`；首日 08:00 快照成功上链（`snapshotCount` 递增、MySQL `snapshots` 落库）

#### 1.5.8 白名单放行（上线前必做）
- 按本手册附录 D 批量加白首批用户地址（主网走 W2 多签）
- **【确认】** `pool.buyWhitelist(地址) == true` 且 `config.buyWhitelistEnabled() == true`

---

## 阶段 2：上线执行（T-0）

> 纪律：按序执行、**每步【确认】后才进下一步**；执行人操作、复核人核对输出、群内同步截图；计划外变更一律拒绝。

### T-30min 集合
- **做什么**：全员到群，过一遍当日 checklist
- **怎么做**：重申回滚基准版本、中止条件（**错误率 > 5% / 对账 diff > 0.1% / 资金数值异常 → 立即中止**）
- **【确认】** 所有人回复"就绪"

### 步骤 1：数据层变更（如有 schema 变更）
```bash
$ mysqldump ... > pre_deploy_backup.sql        # 先备份
$ mysql -u zyt_keeper -p zyt_keeper < migration_xxx.sql
```
**【确认】** 迁移脚本**幂等**（重复执行不报错）；旧版本代码可正常读写新表（向下兼容）

### 步骤 2：后端服务发布（如涉及）
- **怎么做（蓝绿优先）**：新版本部署到新目录/新端口 → `pm2 start` 新实例 → 健康检查 → 切流量 → `pm2 stop` 旧实例
- **【确认】** `pm2 status` 新实例 online；`/health` 返回 ok；错误日志 5 分钟无异常

### 步骤 3：【ZYT】keeper 发布
```bash
$ cd F:/zyt/zyt-keeper
$ node src/index.js        # 本地模式（正式长期运行建议挂 pm2：pm2 start src/index.js --name zyt-keeper）
```
**【确认】** 日志**依次**出现且无 error：
```
service: start chain=97
indexer: ok initial sync ... lastBlock=...
ledger: ok rebuild users=N
keeper: start cron="0 0 * * *" tz=UTC signer=0xdFA5...
monitor: start / forcesell: start / api: start
reconcile: ok ... 对账 N 用户一致
```
若报 `History has been pruned` → `.env` 的 `START_BLOCK` 改为当前最新块（见附录 B 查块命令）后重启

### 步骤 4：前端发布
```bash
$ cd F:/zyt/zyt-dapp && npx vite build
# 手动更新 dist/index.html 的 ?v=YYYYMMDDxx（与当日一致）
# 境外静态托管：Cloudflare Pages / Vercel（Git 直连自动构建）或境外 VPS
$ npx wrangler pages deploy dist --project-name=<项目名>   # Cloudflare Pages 示例
```
- **【确认】** 无痕浏览器访问 → view-source 中 `?v=` 为新值 → 页面功能加载无 404、控制台无报错
- 【注意】**每次只改 index.html 不改静态资源也要更新 `?v=`**——这是本项目历史踩坑点
- 【硬性约束，决策 24】**前端一律部署到境外托管，禁止部署到境内云主机**：2026-09-10 阿里云对承载前端的大陆 ECS 发「涉嫌欺诈」整改通知（币圈内容 + 无备案裸 IP 触发自动审查）；境内主机仅作内部用途，不承载任何对外页面
- 【合规提示】域名解析境外主机无需 ICP 备案；若解析境内主机，未备案会被直接阻断、备案涉币内容不通过，且运行期巡查会关闭站点并约谈负责人

### 步骤 5：DNS/流量切换（如涉及）
- **怎么做**：提前 24h 把 DNS TTL 降到 60s → 修改解析 → `dig <域名>` 验证 → 按灰度比例观察
- **【确认】** 解析指向新地址；新旧流量比例符合计划

---

## 阶段 3：上线后验证（T+0 至 T+2h）

### 3.1 核心链路冒烟（生产环境、真实钱包、小额资金）
按序执行并截图，每步失败即触发 P1 流程：

| # | 操作 | 验证点 |
|---|---|---|
| 1 | MetaMask / TP 连接 DApp | chainId=56 校验通过，地址正确显示 |
| 2 | USDT approve + 入金（如 10U） | ZYT 到账数量 = 入金 ÷ 快照价；算力 +10；动态额度 +50 |
| 3 | 产出 claim | ZYT 到账，动态额度已用值同步增加 |
| 4 | 分红领取 | 按算力比例分红到账 |
| 5 | 卖出（如 100 万 ZYT） | USDT 到账与滑点档位一致；GST 池减少；`/stats` slippage 变化 |
| 6 | 转账 100 ZYT 给测试地址 | 对方收 90（10% 税），强制卖出追踪窗口数据更新 |
| 7 | 全链路后查 `/stats` | pool 三项数值与 bscscan 读数一致 |

### 3.2 三方一致性核对
```bash
$ curl -s http://127.0.0.1:8080/stats | head -c 400
$ curl -s -X POST http://127.0.0.1:8080/reconcile -H "Authorization: Bearer <API_ADMIN_TOKEN>"
```
**【确认】** `/stats` 的 pool 值 == bscscan Read 页面值；`/reconcile` 返回 `diffUsers: 0, maxDiffPct: 0`

### 3.3 错误率与延迟
```bash
$ pm2 logs --lines 100 --err      # 或本地 tee 的日志文件
```
**【确认】** 最近 30 分钟错误日志为 0 或均为已知的非致命 warning；API 错误率 < 1%

### 3.4 反馈通道与公告
- **怎么做**：开启客服/群反馈渠道；发布上线公告（变更内容 + 已知问题 + 反馈方式）
- **【确认】** 公告已发；前 2 小时每 15 分钟扫一次反馈

---

## 阶段 4：监控要点（72h 加密 → 转常态）

### 4.1 每日固定巡检（建议 09:00 一次，快照后）
```bash
$ pm2 status                                   # ① keeper 进程 online
$ curl -s http://127.0.0.1:8080/health         # ② {"ok":true}
$ pm2 logs zyt-keeper --lines 30 --nostream    # ③ 昨晚 08:00 快照日志含 "keeper: ok snapshot day=N"
$ curl -s http://127.0.0.1:8080/stats | grep -o '"diff[^,]*'   # ④ 对账 0 差异（或查 reconcile_results 表）
$ mysqldump ... > daily_$(date +%Y%m%d).sql    # ⑤ 当日备份 + 核对文件大小
```

### 4.2 告警规则确认（上线首日）
- **【确认】** monitor 5 规则已激活（日志出现 `monitor: start rules=R1/R2/R3/R4/R5`）；R4 阈值 120 块、冷却 10 分钟生效
- 触发一次测试告警（如临时把 R4 阈值改 1 块跑一轮）验证触达

### 4.3 分级响应
| 级别 | 判定 | 响应 |
|---|---|---|
| P0 | 快照未在窗口完成 / 对账 diff > 0.1% / 资金异常 / 服务不可用 | 立即电话决策人，走回滚/止血 |
| P1 | API 错误率突增 / R1-R3 告警 | 15 分钟内响应，定位后 hotfix |
| P2 | 展示类小问题 | 记录进下版本 |

---

## 阶段 5：回滚预案（含实操命令）

### 5.1 决策
- **做什么**：P0 现象出现 → 决策人 **10 分钟内**拍板"回滚 / hotfix / 观察三选一"
- **怎么做**：群内发决策卡（现象 / 选择 / 理由 / 执行人）

### 5.2 前端回滚（分钟级）
```bash
$ scp -r <上一版dist目录>/* <user>@<目标>:<目录>/     # 上一版归档包直接覆盖
# index.html 的 ?v= 回退为上一版参数
```
**【确认】** 无痕访问 view-source 的 `?v=` 已变旧值；页面功能恢复

### 5.3 后端回滚
```bash
$ pm2 stop zyt-current && pm2 delete zyt-current
$ cd <上一版目录> && pm2 start ... --name zyt-current
```
**【确认】** `/health` ok、版本号回旧、错误日志恢复基线；**数据库不动**（只回代码）

### 5.4 keeper 回滚
```bash
$ git checkout <上一版tag> -- src/     # 或整个目录切回
# .env 的 START_BLOCK 对齐当前链上水位
$ node src/index.js
```
**【确认】** 启动日志全绿、reconcile 一致；snapshots 表数据**保留**用于事后对账

### 5.5【ZYT】合约异常处置（不可回滚 → 迁移预案）
1. **止血**：具备 pause 则多签执行暂停；无 pause 则多签调整白名单/参数限制入口
2. **留证**：当前池/用户余额链上快照（bscscan + keeper 导出）
3. **迁移**：新合约部署（testnet 演练过的流程）→ 前端与 keeper `.env` 切地址 → 资金按链上状态迁移 → 重新 verify
4. **公告**：向用户说明与补偿方案
- **注意**：此预案的每一步都应**提前演练**（testnet 全流程走一遍），上线后才有执行把握

### 5.6 回滚演练（上线前必须做）
- **怎么做**：在 staging 实际执行 5.2 + 5.3 各一次并计时
- **【确认】** 前端回滚 < 10 分钟、后端回滚 < 15 分钟，均恢复验证通过

---

## 附录 A：上线当日时间表

| 时间 | 动作 | 负责人 | 复核人 | 验证结果 |
|---|---|---|---|---|
| T-30min | 群集合、checklist 过审 | | | |
| T-20min | 最终备份（DB + 配置 + 归档确认） | | | |
| T-10min | 监控基线截图（当前指标） | | | |
| T-0 | 阶段 2 步骤 1-5 顺序执行 | | | 每步留痕 |
| T+30min | 阶段 3.1 核心链路冒烟 | | | |
| T+1h | 阶段 3.2 三方一致性核对 | | | |
| T+2h | 上线确认 / 回滚决策点 | | | |
| T+24h | 复盘会 + 转常态监控 | | | |

## 附录 B：常用命令速查

```bash
# 查 BSC 块高（START_BLOCK 对齐用）：主网 / testnet 分别如下
$ curl -s -X POST https://bsc-dataseed.binance.org -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'          # 主网，返回 16 进制，*1 转十进制
$ curl -s -X POST https://bsc-testnet-rpc.publicnode.com -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'          # testnet 参照

# 手动触发快照（补快照；会占用当日快照额度）
$ cd F:/zyt/zyt-keeper && timeout 120 node scripts/snapshot-now.js

# 手动对账
$ curl -s -X POST http://127.0.0.1:8080/reconcile -H "Authorization: Bearer <API_ADMIN_TOKEN>"

# 备份 / 恢复（主网库 `zyt_keeper_mainnet`，2026-09-14 定案）
$ mysqldump -u <user> -p --single-transaction <库名> > backup_$(date +%Y%m%d).sql
$ mysql -u <user> -p <库名> < backup_YYYYMMDD.sql

# keeper 启停
$ cd F:/zyt/zyt-keeper && node src/index.js
$ pm2 start src/index.js --name zyt-keeper && pm2 save

# 主网 verify（脚本已就绪：scripts/verify-all-mainnet.js，先回填 9 地址；含地址/链ID/USDT 三重防呆）
$ npx hardhat run scripts/verify-all-mainnet.js --network bsc
```

> 文档版本：v2.0（2026-09-14，主网执行版）｜ 配套：《众赢币(ZYT)_上线流程清单.md》《众赢币(ZYT)_技术方案.md》§8

---

## 附录 C：邀请码分发 SOP（运营）

> 版本 v2.0（2026-09-11）｜ 前置：前端已上线注册门禁（v15：连接钱包 → 链上注册判定 → 未注册须填邀请码注册，已注册直接进入项目）

### C.1 机制速览

- **邀请码 = 推荐人的钱包地址**（0x 开头 42 位），或等价的推荐链接（`https://<域名>/#/?ref=<地址>`）
- **v15 注册流程**：
  1. 用户打开页面 → 先连接钱包（多钱包环境弹选择框）
  2. 前端链上查 `ZYTMining` → `ZYTReferral.referrerOf(钱包地址)`
  3. **已注册**（不为零地址）→ 邀请码回填本机 → **直接进入项目**，不出现注册页
  4. **未注册**（零地址）→ 出现注册页：通过 `?ref=` 链接打开的自动填充邀请码；直接打开页面的输入框留空，需用户自己输入
  5. 点击「注册」→ 邀请码与本机注册标记落库 → 进入项目
- **刷新与重开**：本机已点过注册的用户刷新页面直接进入（不因链上未绑定而重复要求注册）；清缓存或换设备需重新注册
- **推荐绑定发生在首次入金**（`deposit(ref)`），注册时存的邀请码自动作为 ref 传入，绑定后不可改
- 推荐产出按决策 21 执行：上级可拿代数 = 其直推人数（直推 1 人拿第 1 代 7%，2 人解锁第 2 代，至 20 代封顶 0.5% 档）
- 存储按合约代次隔离：**合约重新部署后所有邀请码与注册记录失效**，需重新分发/输入

### C.2 官方初始码（冷启动）

| 项 | 决策 |
| -- | -- |
| 用途 | 第一批用户没有上游，官方码是唯一入口；建议对外**只发这一个码**，便于归因与控制 |
| 推荐取值 | **营销收款地址**（W3 / 市场 Safe）：推荐 7% 回营销多签 = 市场费用闭环，不外流 |
| 公示 | 官方码在公告/群公告置顶公示**全称地址**，防第三方冒充"官方邀请码"诈骗 |

**当前官方码**：
- testnet（第六套）：`0xB7233A003C37Beb100C4eFCF82793D24B90179F9`（= deployer，testnet 未单独部署营销多签）
  - 推荐链接：`https://<前端域名待定>/#/?ref=0xB7233A003C37Beb100C4eFCF82793D24B90179F9`
  - ⚠️ 原链接域名 `http://121.40.45.58`（阿里云 ECS）**已于 2026-09-10 下线**（内容安全涉诈通知，前端删除 + 端口关闭）；新域名上线后重新生成链接与二维码
  - 前端 `config/index.ts` 的 `rootInvite`（testnet）当前为本测试钱包占位值，与官方码保持一致
- 主网：待 W3 营销 Safe 搭建后替换（上线钱包准备清单_方案A W3），**官方码必须与 ZYTConfig.marketAddress 一致**，部署时用 `MARKET_ADDRESS` 环境变量传入 deploy.js；同时填入前端 `config/index.ts` 的 `BSC_MAINNET.rootInvite`
| 资金核对 | 每日对账含推荐分账（keeper reconcile），营销地址 7% 流入可在 BscScan 核对 |

### C.3 分发操作（运营 / 客服）

1. 生成官方推荐链接：登录 DApp（用营销地址钱包）→ 社区页 →「我的推荐链接」→ 复制
   - ⚠️ **分发必须使用带 `?ref=` 的完整链接**：v15 起直接打开域名不会预填邀请码，用户需自行输入；带参数的链接才会自动填充并降低流失
2. 二维码（海报/朋友圈用）：任意二维码生成器粘贴链接；落地页域名变更后需重新生成
3. 分发渠道：社群公告置顶 / 客服一对一 / 线下物料印刷二维码
4. 话术要点（合规）：
   - 「输入邀请码进入平台」；**禁止承诺收益、禁止「稳赚/保本」类表述**
   - 引导用户保存好邀请链接；入金时推荐关系自动绑定，无需手动操作
5. 成员二级传播：用户进入后 → 社区页复制**自己的**链接 → 转发即成为下级邀请码发行方（裂变自动进行，运营无需介入）
6. 用户反馈「刷新后要重新注册」时：确认为清缓存/换设备场景（本机注册记录丢失）；引导用原邀请链接重新打开并注册，未入金用户不受影响，已入金用户链上有绑定记录会自动放行

### C.4 测试期专用（testnet）

- 测试团队逃生入口：URL 追加 `skipInvite=1`（如 `https://<域名>/#/?skipInvite=1`），**仅限内部，不对外**；正式宣传物料绝不携带该参数
- **注册页不预填邀请码**（v15）：除 `?ref=` 链接外，输入框一律留空，需用户自己输入；根邀请码仅作为配置保留（`config.rootInvite`），不参与预填
- testnet 白名单当前关闭（`buyWhitelistEnabled=false`），人人可入金；**主网上线前必须恢复 on**（防闪电贷防线，见上线核对清单；白名单增删操作见附录 D）
- 换合约重部署后：旧邀请码与注册记录全部失效（存储 key 含合约代次），官方码链接需用新地址重新生成并重新分发

### C.5 FAQ（客服口径）

| 问题 | 口径 |
| -- | -- |
| 输错邀请码 / 提示无效 | 邀请码必须为 0x 开头的完整地址或推荐链接；请重新向邀请人索要完整链接后复制粘贴 |
| 想更换邀请码 | 入金前清空浏览器站点数据（含 `zyt_invite_*` 与 `zyt_reg_*` 两组记录）后，通过新邀请链接重新打开并注册即可；**入金后推荐关系已绑定，不可更改** |
| 刷新后需要重新注册吗 | 不需要。本机点过注册后刷新/重开直接进入；仅清缓存或换设备时才需重新注册（已入金用户在链上有绑定记录，任何时候都会自动放行） |
| 已注册但页面要求重新输入 | 属于清缓存/换设备场景；用原邀请链接重新打开即可。若钱包从未入金且本机记录丢失，链上无法识别，需重新注册 |
| 没有邀请码 | 联系邀请你加入社区的成员获取推荐链接；新用户请通过官方公告中的官方码进入 |
| 邀请码会过期吗 | 不会；但平台升级合约后历史邀请码失效，需通过最新推荐链接重新进入 |
| 邀请有产出吗 | 推荐产出随入金按链上规则结算（决策 21 代数规则），以页面展示为准，平台不作任何收益承诺 |

### C.6 风控要点

- 官方码地址全程公示，任何「非公示地址冒充官方」的行为需公告预警
- 注册门禁仅拦入口（前端 UI 层），合约层防刷靠买入白名单（主网必开）+ 快照锁价双防线
- 禁止在邀请物料中出现固定收益/回本周期字样；分账与代数规则以链上为准
- **合规红线（2026-09-10 阿里云事件后新增）**：宣传物料不得出现「收益 / 复利 / 分红 / 静态 / 出局 / 保本 / 回本」类表述，前端已统一改为中性机制描述（累计产出 / 每日分配 / 推荐产出），物料口径需与前端保持一致

---

## 附录 D：买入白名单操作 SOP（运营 / 技术）

> 版本 v1.0（2026-09-11）｜ 适用：testnet 联调放行、主网用户审核加白

### D.1 机制速览

| 项 | 内容 |
|---|---|
| 存储位置 | `ZYTPoolManager.buyWhitelist` mapping（地址 → 是否可买入） |
| 权限 | 仅 owner（主网 = 营销/治理 Gnosis Safe 多签；testnet = deployer EOA） |
| 生效点 | `ZYTMining.deposit()` 开头检查 `pool.buyWhitelist(msg.sender)`，非白名单直接 revert `Mining: not whitelisted` |
| 总开关 | `ZYTConfig.buyWhitelistEnabled`（主网必须保持 `true`，防闪电贷第一道防线） |
| 与阶段规则的关系 | 白名单只解决「能不能买」，阶段规则（stage2 额度 1:1 / stage3 白名单内自由）另行生效 |

### D.2 添加 / 移除白名单

**方式 1：脚本单个地址（testnet 已备）**
```bash
$ cd F:/zyt/zyt-contracts
$ # 编辑 scripts/whitelist-test-wallet.mjs 中的 WALLET 为目标地址
$ PRIVATE_KEY=<owner私钥> node scripts/whitelist-test-wallet.mjs
# 输出：白名单前 false → 放行 tx → 白名单已放行 ✓
```

**方式 2：BscScan 手动（主网多签场景，临时单个地址）**
1. 打开 `ZYTPoolManager` 合约地址 → Contract → Write Contract → Connect to Web3（连接 owner 多签钱包）
2. `setBuyWhitelist(address addr, bool enabled)` 填目标地址 + `true`
3. 多签成员依次确认 → 执行交易
4. 同入口用 `enabled=false` 移除

**方式 3：脚本批量（多地址，建议加白多个用户时使用）**
```javascript
// scripts/whitelist-batch.mjs（按需新建）
const addrs = ["0xAAA...", "0xBBB..."];
await pool.setBuyWhitelistBatch(addrs, true);
```

### D.3 核对与验证

```bash
# 查单个地址是否已加白（只读，任意 RPC 均可）
# ethers 控制台或脚本内：
#   await pool.buyWhitelist("0x目标地址")   → 期望 true
# 查总开关（主网必须 true）
#   await cfg.buyWhitelistEnabled()          → 期望 true
```

**【确认】三件事同时满足才算放行完成**：
1. `buyWhitelist(用户) == true`
2. `buyWhitelistEnabled == true`
3. 用户钱包已在目标链（BSC mainnet / testnet 97），交易不会因链不一致失败

### D.4 风控与注意

- **加白名单 = 授权该地址可动用底池买入**，仅对完成 KYC/社区审核的地址操作；批量加白前必须复核地址列表，避免误加攻击者地址
- 主网加白操作走 Gnosis Safe 多签（决策 3），单一执行人无法单独完成，防内鬼
- 白名单变更后到链上生效需等待交易确认（BSC 约 3 秒/块），客服口径为「5 分钟内生效」
- 移除白名单不影响用户已持有的资产与卖出能力（卖出不受白名单限制）
- testnet 联调期白名单常关（`buyWhitelistEnabled=false`），此时 `buyWhitelist` 值不产生拦截效果，属预期行为

---

## 附录 E：主网 TestUSDT 试运行与钱包两级策略（技术）

> 版本 v1.0（2026-09-14）｜ 决策：主网先以 TestUSDT 试运行，验证后重部署正式版（真实 USDT）；期间不消耗真实资金

### E.1 两阶段部署

| 阶段 | USDT | 目的 | 数据 |
| -- | -- | -- | -- |
| 试运行版 | TestUSDT（MockERC20 部署到主网，faucet 分发） | 主网环境全流程预演：入金/卖出/分红/推荐/快照/强制卖出/前端/keeper | 试运行数据作废 |
| 正式版 | 真实 USDT（0x55d398...7955） | 对外运营 | 干净起步 |

- 部署开关：`USDT_MOCK=1` 走 TestUSDT（deploy.js 已支持，faucet 5 万绕过真实 USDT 检查）
- **路径锁定：测试完成后重部署正式版，同合约切 usdt 地址被否决**（假币换真币口子 + 账实差异风险）

### E.2 钱包两级策略（2026-09-14 拍板）

| 钱包 | 试运行版 | 正式版 | 安保要求 |
| -- | -- | -- | -- |
| **测试部署钱包** | owner（部署 TestUSDT 版） | 弃用 | 低：独立 EOA、无真实资金，仍须防泄漏（主网地址公开，泄漏仅影响测试合约） |
| **上线部署钱包** | 不出现 | owner（部署正式版） | 高：keystore 加固 / 离线签名，按《docs/主网密钥管理清单.md》执行（gen-deployer-keystore.mjs） |
| keeper 签名钱包 | 0xdFA5 触发快照 | 同一私钥复用，对新合约重新接线 | 中：仅触发器无资金权限 |
| 营销 / 技术 Safe | 可先用 EOA 代理 | 正式版必须 W3/W4 Safe（MARKET_ADDRESS / TECHNICAL_ADDRESS 传入） | 多签 |

- **钱包体系一次搭建两版通用**（EOA 私钥与合约地址解耦），重部署只同步配置：新合约接线（setConfig/keeperAddress/setKeeper/白名单）+ keeper .env 换址 + 前端 config 换址
- 试运行版 owner（测试部署钱包）与正式版 owner（上线部署钱包）不同属**预期行为**，正式版上线核对时确认 owner = 上线部署钱包地址

### E.3 试运行 → 正式版切换清单（SOP 摘要）

1. 试运行版全流程回归通过（含 08:00 快照连续、强制卖出窗口、前端全功能）
2. 生成/加固上线部署钱包（keystore），冷环境保管助记词
3. 正式版部署：上线部署钱包执行 `USDT_MAINNET=<真实USDT> MARKET_ADDRESS=<W3> TECHNICAL_ADDRESS=<W4> CONFIRM_MAINNET=1 node scripts/deploy.js --network bscMainnet`
4. bscscan verify 全部合约（含真实 USDT 地址核对）
5. keeper / 前端 / 白名单 / 官方邀请码（= W3）全链路换址
6. 正式版首笔入金小额验证（真 USDT 100U）→ 全量开放
7. 试运行版合约公告废弃，前端下线其入口
