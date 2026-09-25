# 众赢币（ZYT）上线操作手册

> **配套文档**：《众赢币(ZYT)_上线流程清单.md》（勾选用）；本手册回答"每一步**做什么、怎么做、做到什么程度算通过**"。
> **约定**：`$` 开头为 shell 命令（Git Bash）；`【确认】`为通过标准；`<占位符>`按实际替换。
> **边界**：ZYT 独立运营，不使用 GYT 服务器；keeper 本地模式运行。
> **版本**：v2.0（2026-09-14）｜ **本版为「主网执行版」**：阶段 1 新增 1.3.7 主网参数总表、1.3.8 keeper 配置替换、1.3.9 前端配置替换、1.5 主网部署执行；testnet 内容保留作为参照，标注 `【参照】`。

---

## ⚠️ v9 口径变更说明（2026-09-24，执行前必读）

> v9 弃 GST，改 USDT↔ZYT 单币直换（真实 PancakeSwap V2 pair 底池）。本手册以下差异在执行时生效，
> 与正文冲突处以本节为准（正文 v8 步骤保留作为流程骨架参照）：

| 项 | v8（正文） | v9（执行口径） |
|---|---|---|
| 合约数量 | 10（含 GSTToken） | **8**（删 GSTToken；Creator 改为「初始建池 + LP 锁仓」） |
| 初始建池 | 手动 Pancake 建 GST/ZYT 池 + PAIR_ADDRESS 回填 | **deploy.js 自动执行 createInitialPool**（2.1万U + 21亿ZYT），无需手动建池 |
| deploy 前置 | deployer 持 2.1万 USDT + 21万 GST | **仅需 2.1万 USDT + BNB gas**（GST 不复存在） |
| 部署确认 | 交互输 yes / CONFIRM_MAINNET=1 | 沿用 |
| pair 接线 | 手动 setPair + setWhiteList(pair) | **脚本自动三处接线**（config/zyt/pool）+ pair 白名单 |
| verify 脚本 | verify-all-mainnet.js（10 合约） | 待适配 v9（8 合约 + lib），执行前核对 ADDR_DEFAULTS |
| keeper .env | SNAPSHOT_CRON=1 0 * * *（08:01） | 沿用 08:01；新增 v9 合约地址 8 个（无 GST 地址） |
| keeper 对账 | daySoldGST/snapshotPoolUSDT 口径 | 真池 4 字段对账（deposit/withdraw/dynamicQuota/dynamicWithdrawn）+ 受赠值 |
| 前端 config | GST 地址 + Router | **删除 GST/Router**；新增 factory（testnet/mainnet 分流）；合约地址 8 个 |
| 前端交易 | convertPowerToZyt（approve→mining） | **mining.buy()**（approve USDT→mining）；卖出 approve 对象仍为 pool |
| 验收清单 | 1.5.1b 手动建池 + 三项接线 | **改为：部署日志确认「Initial pool created」+ 「Pair wired」+ LP 锁仓量 > 0** |
| 强卖窗口 | 60% 封顶（旧文案） | **50% 封顶**（20/30/40/50 累计，keeper forcesell.js 已同步） |
| smoke 脚本 | smoke-testnet.js（v8 口径） | 未适配 v9，testnet 验收以 hardhat test + 部署日志代替 |

**v9 新增上线验收项**：
1. `creator.lockedLiquidity() > 0`（LP 锁仓生效）
2. `zyt.totalSupply() == 21亿`（一次铸出，此后只减不增）
3. `pool.poolUSDT() == 2.1万U` 且 `pool.poolZYT() == 21亿`（初始比例 1:100000，价格 0.00001U）
4. 直接对 pair 转 ZYT 应 revert `ZYT: pair inflow gated`（卖闸生效）
5. keeper 首次 dailySnapshot 后 `pool.poolUSDT()` 不变、`poolZYT()` 减约 2%、价格上升（U 回池 sync 生效）

---

## 主网待填参数总表（部署完成后逐项回填）

> 用法：部署主网后，从部署脚本输出中提取下列值，同时填入三处（前端 config / keeper .env / 文档），三处必须一致。

### A. 合约地址（10 项，deploy.js 输出）

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
| 10 | ZYTLiquidityCreator | `待填` | 不需 | 需（索引 BasePoolCreated） |

### B. 地址类参数（多签 / 钱包）

| 项 | 取值来源 | 主网地址 | 用途 |
|---|---|---|---|
| 营销地址 W3（营销 Safe） | app.safe.global 创建（BSC 主网）**已链上核验 2026-09-14：threshold 2 / owners 3（2/3 ✓）** | `0x1bc03Fe18F9BabBc32f0B4046E13e387E9D16786` | `MARKET_ADDRESS`（已在 `.env`）；`config.marketAddress()`；**前端 rootInvite** |
| 技术地址 W4（技术 Safe） | app.safe.global 创建（BSC 主网）**已链上核验 2026-09-14：threshold 2 / owners 2（2/2 ✓）** | `0x860D4704d6eee98Aa55A971Caf8BAA4134E8eec3` | `TECHNICAL_ADDRESS`（已在 `.env`）；`config.technicalAddress()`。⚠️ 2/2 任一 signer 丢失即永久锁死，建议改 2/3 或 1/2；keeper 保持 EOA 不上多签 |
| keeper 签名钱包 W5 | keeper 独立 EOA（私钥存 `zyt-keeper/.env`）；**2026-09-14 确认并已填入 `.env`** | `0x09BeD12b5956E1E53668Aa10E242766E3aE3B641` | `KEEPER_ADDRESS`（已填）；keeper 侧 `KEEPER_PRIVATE_KEY` 为同一钱包。⚠️ testnet 链上 `keeperAddress` 仍为 `0xdFA5…a480`，与本地私钥不一致，testnet 快照需先对齐或停跑 |
| 治理多签 W2 | app.safe.global 创建（BSC 主网）**已链上核验 2026-09-14：threshold 2 / owners 3（2/3 ✓，owner 集合与 W3 一致）** | `0xa67E65FA6daa80eFFEE911E042C0f5b0C8718C33` | **正式版** owner 移交目标（`transferOwnership`）；试运行版不移交，owner 留 W1 |
| 部署钱包 W1 | 钱包清单方案 A | `待填` | 部署后退役冷备（私钥存本地 `.env`，不上服务器） |

**核验记录（2026-09-14，RPC `bsc.publicnode.com`，chainId 56）**

| Safe | 地址 | 字节码 | threshold | owners |
|---|---|---|---|---|
| 治理 W2 | `0xa67E65FA6daa80eFFEE911E042C0f5b0C8718C33` | SafeProxy 已部署 | 2 | `0x77B649f7…`、`0x2aE3BA7a…`、`0x28E4A5B4…`（与 W3 为同一组三人） |
| 营销 W3 | `0x1bc03Fe18F9BabBc32f0B4046E13e387E9D16786` | SafeProxy 已部署 | 2 | `0x77B649f7…deB37`、`0x28E4A5B4…f20C4`、`0x2aE3BA7a…46A526` |
| 技术 W4 | `0x860D4704d6eee98Aa55A971Caf8BAA4134E8eec3` | SafeProxy 已部署 | 2 | `0x2aE3BA7a…46A526`、`0xE30471a7…a6eD1` |

> 权限分布观察：W2 与 W3 由同一组三人控制（各为 2/3），W4 为 2/2 且与 W2/W3 共享一名签名人。实际效果是两个签名人即可动用营销资金或治理参数，好处是团队小、操作快，代价是治理与资金权限未做人员分离。人手允许时建议为 W2 引入独立签名人。

> 注：`0x2aE3BA7a…46A526` 同时为三个 Safe 的 owner（交叉持有）；技术 Safe W4 为 2/2，任一 signer 丢失即永久锁死，上线前建议调整为 2/3 或 1/2。

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
- **怎么做**：选业务低峰；**避开每日 08:01-08:11 快照/通缩窗口**（快照前后各留 1 小时缓冲）；建议 14:00-17:00（白天响应快、跨部门在线）
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
  3. 次日 08:01 快照后：核对分红领取（每日产出已停用，claimReward 应被拒）
  4. 卖出小额：核对滑点档位与 30/30/40 分账
  5. keeper 侧：`/stats`、`/user`、`/force-sell` 数据与链上一致
- **【确认】** 全链路无 revert；入金金额与分账比例吻合；keeper 账本与链上一致；测试交易 hash 归档
- ⚠️ 主网测试资金真实消耗，金额务必小额，测试完成后评估是否继续持有

#### 1.2.3 UAT 业务验收
- **怎么做**：产品在 staging（或 testnet 前端）完整走用户旅程：连接钱包 → 授权 → 入金 → 兑换（阶段 2 起）→ 分红 → 卖出 → 转账；每步截图
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
- **状态（2026-09-14 已核验，共三个 Safe）**：治理 W2 `0xa67E65…8C33`（2/3）、营销 W3 `0x1bc03F…6786`（2/3）、技术 W4 `0x860D47…eec3`（2/2），均在 BSC 主网部署且字节码为 SafeProxy；核验记录见顶部表格
- **怎么做**：①核验已完成，如需复核可再跑 `getOwners()` / `getThreshold()`；②**在 testnet 或用模拟交易完整走一遍** setUint 提案-签名-执行流程（签名人数、确认顺序、执行延迟）；③部署时以 W3/W4 注入 `MARKET_ADDRESS` / `TECHNICAL_ADDRESS`（已在 `zyt-contracts/.env`）；④正式版部署后 owner 移交 W2（1.5.5）
- **【确认】** 正式版：`owner()` 返回 W2 治理多签；提案-签名-执行演练记录截图
- ⚠️ 技术 Safe W4 当前 2/2，任一 signer 丢失即永久锁死，建议调整为 2/3 或 1/2；keeper 保持 EOA，不纳入多签
- ⚠️ W2 与 W3 由同一组三人控制，两个签名人即可同时满足两者阈值，治理与资金权限未做人员分离

#### 1.3.5【ZYT】keeper 签名钱包核对
```bash
$ cd F:/zyt/zyt-keeper && node -e "
import('ethers').then(({Wallet})=>{
  const w=new Wallet(require('dotenv').config().parsed.KEEPER_PRIVATE_KEY);
  console.log('signer =', w.address);
})"
```
**【确认】** 输出地址 == 链上 `config.keeperAddress()`；该地址不持有项目资金、私钥仅存于运行环境 .env（已被 .gitignore 排除）

**三方一致性检查（主网部署前必做，2026-09-14 新增）**

| # | 位置 | 应为 |
|---|---|---|
| 1 | `zyt-contracts/.env` 的 `KEEPER_ADDRESS` | `0x09BeD12b5956E1E53668Aa10E242766E3aE3B641`（已填） |
| 2 | `zyt-keeper/.env` 的 `KEEPER_PRIVATE_KEY` 推导地址 | 同一地址 |
| 3 | 部署后链上 `config.keeperAddress()` | 同一地址 |

三项不一致会导致每日快照调用被合约拒绝（`msg.sender != keeperAddress`），链路静默断裂。
核对命令（不打印私钥）：
```bash
$ node -e 'const fs=require("fs");const pk=fs.readFileSync("F:/zyt/zyt-keeper/.env","utf8").match(/^KEEPER_PRIVATE_KEY=(.+)$/m)[1].trim();console.log("keeper 地址:", new (require("ethers").Wallet)(pk).address)'
```

⚠️ **当前遗留（testnet）**：testnet 第五套链上 `keeperAddress` = `0xdFA550005B75DA1930C65732Db46baD5cB50a480`，与本地私钥地址 `0x09Be…B641` 不一致。testnet 若继续试运行快照，需 owner 调 `setAddress("keeperAddress", 0x09BeD12b5956E1E53668Aa10E242766E3aE3B641)` 对齐；若停跑 testnet 则可忽略（主网部署时按本表填入即为一致）。

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
| `KEEPER_PRIVATE_KEY` | keeper 独立钱包私钥 | **保持不变**（该钱包即正式 keeper 签名钱包 `0x09BeD12b5956E1E53668Aa10E242766E3aE3B641`，2026-09-14 确认） | 推导地址 == `contracts/.env` 的 `KEEPER_ADDRESS` == 部署后链上 `config.keeperAddress()`（三方一致，见 1.3.5） |
| `DB_URL` | `zyt_keeper` 库 | **`zyt_keeper_mainnet`（2026-09-14 定案）** | 库创建成功；启动时 7 表自动建；MySQL 用户权限独立于 testnet 库 |
| `ALERT_WEBHOOK_URL` | 空 | 真实 webhook | 实测能收到告警 |
| `SNAPSHOT_CRON` | `1 0 * * *` | 保持（UTC 00:01 = 北京 08:01） | 时区已显式 UTC |

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
> **两种模式（附录 E 两级策略）**：**模式 A 试运行版**（TestUSDT，本次执行，owner 留 W1，不移交）｜ **模式 B 正式版**（真实 USDT + 全新上线部署钱包 + owner 移交 W2）。二者为两套独立合约，不可混用。

#### 1.5.1 部署环境变量与命令（deploy.js 读取）

**模式 A：试运行版（TestUSDT，2026-09-14 本次执行）**

```bash
$ cd F:/zyt/zyt-contracts
$ USDT_MOCK=1 npx hardhat run scripts/deploy.js --network bsc
#   MARKET_ADDRESS / TECHNICAL_ADDRESS / KEEPER_ADDRESS 已在 .env 中：
#     营销 Safe 0x1bc03Fe18F9BabBc32f0B4046E13e387E9D16786
#     技术 Safe 0x860D4704d6eee98Aa55A971Caf8BAA4134E8eec3
#     keeper   0x09BeD12b5956E1E53668Aa10E242766E3aE3B641
#   WHITELIST 留空（部署后另行加白，见附录 D）
#   交互确认会打印 chainId 56 与 deployer，输 yes 才发交易
```
- 费用：仅消耗真实 BNB（gas）；USDT 由 faucet 自动发 5 万 TestUSDT
- owner：留测试部署钱包 W1 `0xB7233A…79F9`，**不移交多签**（便于试运行期调参与加白）
- 输出需额外记录：**TestUSDT 合约地址**（前端 `BSC_MAINNET.usdt` 与 verify 都要用）

**模式 B：正式版（真实 USDT，试运行通过后执行）**

```bash
$ MARKET_ADDRESS=0x1bc03Fe18F9BabBc32f0B4046E13e387E9D16786 \
  TECHNICAL_ADDRESS=0x860D4704d6eee98Aa55A971Caf8BAA4134E8eec3 \
  KEEPER_ADDRESS=0x09BeD12b5956E1E53668Aa10E242766E3aE3B641 \
  WHITELIST=<首批白名单地址,逗号分隔> \
  npx hardhat run scripts/deploy.js --network bsc
# 脚本化：CONFIRM_MAINNET=1 前缀可跳过交互确认（仅限已完整演练后）
```
- 前置：**全新上线部署钱包**（不沿用 W1）+ 2.1 万真实 USDT + ≥0.05 BNB
- 部署后：owner 移交 W2 `0xa67E65FA6daa80eFFEE911E042C0f5b0C8718C33`（见 1.5.5）

⚠️ **路径锁定（附录 E）**：试运行版与正式版是两套独立合约，不可在同合约上切换 usdt 地址（假币换真币口子）；试运行数据作废，正式版干净起步。
⚠️ 部署私钥规范见 `docs/主网密钥管理清单.md`（本地 `.env` 明文方案 + 三不原则）；部署完成后立即清除或换回测试私钥。

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
| `GST_RESERVE` | GST 释放储备池地址（LP 补充来源） | 缺省 = deployer；主网建议填 W2 治理多签 |
| `PAIR_ADDRESS` | ZYT/GST 交易对地址 | 缺省空；手动建池完成后回填并重跑，或由多签 setPair |

**【确认】** 启动日志回显 network = bsc(56)、deployer 地址、四个地址参数；出块确认前人工二次核对参数

#### 1.5.1b【ZYT】初始建池与 Creator 接线（手动步骤，不可省略）

> 底池创建的原料来自初始 LP。初始 LP 必须手动建立，合约不提供建池函数，避免部署脚本持有大额资产。

**步骤 1：手动建立 ZYT/GST 池**

在 PancakeSwap 连接部署钱包添加流动性：

| 侧 | 数量 | 价值 |
|---|---|---|
| GST | 21,000 枚 | 21,000 U |
| ZYT | 2,100,000,000 枚 | 21,000 U |

比例必须为 1 GST 对 100,000 ZYT，与记账价一致。偏差会导致后续 `addLiquidity` 按错比例退回。

**【确认】** 记录生成的 pair 地址（LP Token 合约地址）

**步骤 2：把 pair 接线到合约（四项，缺一不可）**

合约已部署的情况下用多签执行下列四项。

| 动作 | 目标合约 | 作用 |
|---|---|---|
| `zyt.setWhiteList(pair, true)` | ZYTToken | pair 接收 ZYT 时豁免强制卖出初始化 |
| `zyt.setWhiteList(router, true)` | ZYTToken | Router 经 transferFrom 拉取 ZYT，不豁免会被当作收币用户登记进 userList |
| `gst.setTransferAllowed(pair, true)` | GSTToken | pair 接收 GST（Creator 注入 LP）。不漏则 `addLiquidity` 直接 revert |
| `creator.setPair(pair)` | ZYTLiquidityCreator | 底池创建的目标交易对 |

若建池在部署之前完成，可在首次部署时直接传 `PAIR_ADDRESS=<pair>`，脚本会自动完成上述四项。

**【确认】** `zyt.isWhiteList(pair)` 与 `zyt.isWhiteList(router)` 均为 true，`gst.transferAllowed(pair)` 为 true，`creator.pair()` 等于 pair 地址

**步骤 2b：GST 储备池出口接线（P1-11，漏了 Creator 取不到 GST）**

| 动作 | 目标合约 | 作用 |
|---|---|---|
| `gst.setCreator(<ZYTLiquidityCreator>)` | GSTToken | 把储备池的唯一出口限定为 Creator，使「1:1 挂钩释放」在链上被强制 |

部署脚本在第 14 段已自动执行本项。手动建池或 Creator 重新部署时需重做，并同步 `creator.setReserve(<储备池地址>)`。

**【确认】** `gst.creator()` 与 `creator` 合约地址一致；`gst.reserve()` 与 `creator.gstReserve()` 一致（两者不一致会导致 Creator 取不到 GST，入金直接 revert）

**步骤 3：验收首笔入金**

用小额真实入金跑一次，逐项确认：

| 检查项 | 预期 |
|---|---|
| `creator.totalLiquidityCreated()` | 大于 0 |
| `zyt.balanceOf(0x…dEaD)` | 增加（LP Token 已锁） |
| `pool.poolUSDT()` | 增加入金额的 60% |
| `gst.balanceOf(reserve)` | 减少入金额的等值枚数 |
| `zyt.getUserCount()` | 不因 Router 或 Creator 而增加 |
| `mining.userInfo(<入金人>)` | `depositTotal` 增加，`withdrawTotal` 不变（入金不发 ZYT） |
| `pool.daySoldGST()` | 保持 0（P1-10：入金不写当日卖出量，滑点维持基准档） |

#### 1.5.2 部署产物归档
- 记录：9 合约地址、**TestUSDT 地址（模式 A）**、部署 tx hash、区块高度（作为 keeper `START_BLOCK`）、构造参数、gas 消耗
- **【确认】** 写入《主网待填参数总表》A/B/C 三表；artifacts 冷备

#### 1.5.3 字节码核对与源码验证
```bash
$ node scripts/probe-bytecode.js
$ npx hardhat run scripts/verify-all-mainnet.js --network bsc   # 脚本已就绪，先回填地址
```
**【确认】** 字节码全部 match；bscscan 9/9 合约页 `#code` 绿色勾

#### 1.5.4 参数核对（见 1.3.3）
**【确认】** owner / marketAddress / technicalAddress / keeperAddress / buyWhitelistEnabled / stage 阈值 / 滑点档位 / 白名单逐项一致

#### 1.5.5 owner 移交 W2 治理多签（正式版必做；试运行版跳过）

> **试运行版（TestUSDT）不移交**：owner 留测试部署钱包 W1，方便单人快速调参与加白。移交动作在正式版部署后执行，见附录 E.3。

```bash
# hardhat console 内（先确保 .env RPC 指向主网、使用上线部署钱包私钥）
#   const cfg = await ethers.getContractAt("ZYTConfig", "<ZYTConfig地址>")
#   await (await cfg.transferOwnership("0xa67E65FA6daa80eFFEE911E042C0f5b0C8718C33")).wait()
#   await cfg.owner()     # 期望 == 0xa67E65FA6daa80eFFEE911E042C0f5b0C8718C33
```
**【确认】** `config.owner() == W2 治理多签`；原部署钱包已无管理权限（尝试 `setUint` 应 revert）；移交 tx 归档
**移交后所有参数/白名单变更均走 W2 多签提案 → 2 人签名 → 执行（SOP 见附录 D）**

#### 1.5.6 建池与底池注入
- 建 GST/USDT 池（约 2.1 万 U 等值）→ 注入底池 → **LP 100% 打黑洞**（公示销毁哈希）
- **【确认】** 池子可正常兑换；黑洞地址 LP 余额与公示哈希一致；`pool` 合约读到的底池值与注入量吻合

#### 1.5.7 keeper 切主网并首日验证
```bash
$ cd F:/zyt/zyt-keeper
$ node src/index.js     # 或 pm2 start src/index.js --name zyt-keeper
```
**【确认】** 启动日志 `chain=56` → `indexer: ok` → `ledger: rebuild` → `keeper: start cron` → `api: start`；首日 08:01 快照成功上链（`snapshotCount` 递增、MySQL `snapshots` 落库）

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
keeper: start cron="1 0 * * *" tz=UTC signer=0x09Be...
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
| 2 | USDT approve + 入金（如 10U） | 算力 +10；入金不发 ZYT（阶段 1 手中无币）；`pool.daySoldGST()` 保持 0 |
| 3 | 产出 claim | 已停用（2026-09-23）：`claimReward` 应 revert `Mining: reward disabled` |
| 4 | 分红提取 | 次日可提取前一日分红；`dividendOf(地址)` 的 pending 增加，提取后清零（三阶段均可，阶段 1 亦可） |
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
$ pm2 logs zyt-keeper --lines 30 --nostream    # ③ 昨晚 08:01 快照日志含 "keeper: ok snapshot day=N"
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
| **测试部署钱包 W1** | owner（部署 TestUSDT 版）`0xB7233A003C37Beb100C4eFCF82793D24B90179F9` | 弃用 | 低：独立 EOA、无真实资金，仍须防泄漏（主网地址公开，泄漏仅影响测试合约） |
| **上线部署钱包** | 不出现 | owner（部署正式版），部署后移交 W2 | 高：按《docs/主网密钥管理清单.md》执行 |
| **治理多签 W2** | 不参与（试运行 owner 留 W1） | owner（`transferOwnership` 目标）`0xa67E65FA6daa80eFFEE911E042C0f5b0C8718C33`（2/3 ✓ 已核验） | 多签 |
| keeper 签名钱包 | `0x09BeD12b5956E1E53668Aa10E242766E3aE3B641` 触发快照 | 同一私钥复用，对新合约重新接线 | 中：仅触发器无资金权限 |
| 营销 / 技术 Safe | 营销 `0x1bc03F…6786`（2/3）、技术 `0x860D47…eec3`（2/2），可直接用于试运行版 | 正式版必须 W3/W4 Safe（MARKET_ADDRESS / TECHNICAL_ADDRESS 传入） | 多签 |

> 修正记录（2026-09-14）：本表原记 keeper 签名钱包为 `0xdFA5…480`，该值对应 testnet 第六套链上配置；主网 keeper 钱包已定案为 `0x09BeD12b5956E1E53668Aa10E242766E3aE3B641`（由 `zyt-keeper/.env` 私钥推导并核对一致）。

- **钱包体系一次搭建两版通用**（EOA 私钥与合约地址解耦），重部署只同步配置：新合约接线（setConfig/keeperAddress/setKeeper/白名单）+ keeper .env 换址 + 前端 config 换址
- 试运行版 owner（测试部署钱包）与正式版 owner（上线部署钱包）不同属**预期行为**，正式版上线核对时确认 owner = 上线部署钱包地址

### E.3 试运行 → 正式版切换清单（SOP 摘要）

1. 试运行版全流程回归通过（含 08:01 快照连续、强制卖出窗口、前端全功能）
2. 生成/加固上线部署钱包（keystore），冷环境保管助记词
3. 正式版部署：上线部署钱包执行 `USDT_MAINNET=<真实USDT> MARKET_ADDRESS=<W3> TECHNICAL_ADDRESS=<W4> CONFIRM_MAINNET=1 node scripts/deploy.js --network bscMainnet`
4. bscscan verify 全部合约（含真实 USDT 地址核对）
5. keeper / 前端 / 白名单 / 官方邀请码（= W3）全链路换址
6. 正式版首笔入金小额验证（真 USDT 100U）→ 全量开放
7. 试运行版合约公告废弃，前端下线其入口
