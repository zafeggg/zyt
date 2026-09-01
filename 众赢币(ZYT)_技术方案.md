# 众赢币（ZYT）技术方案 v7（冻结版）

> 参考项目：NBDAO（web3nbdao.github.io/nbdao）
> 目标链：**BNB Smart Chain**（BSC mainnet）
> 底池代币：**古水币 GST**（**项目自建**，总量 3.33 亿枚，初始价 1 USDT，前端对用户隐藏）
> 入金代币：**USDT 仅限**（不支持 BNB 入金）
> 主代币：**众赢币 ZYT**（总量 21 亿枚，初始价 0.00001 USDT）
> 前端入口参考：`https://web3nbdao.github.io/nbdao/#/?ref=11522693`

> **v7 更新说明（2026-08-27）**：
> - **通缩时刻明确**：每日 **08:00–08:10（北京时间）** 由 Keeper 执行，8 点后通缩（Ave 显示供应减少 / 价格上涨）
> - **买入白名单**：`buyWhitelistEnabled` 全程启用（阶段 2/3 仅白名单可买，多签增删），**防闪电贷掏空底池**
> - **当日快照基准价**：买入/卖出计价统一用 08:00 快照锁定价（防价格操纵，闪电贷单笔交易无法影响当日价格）
> - **链上卖出统计**：ZYTToken 新增 `UserSellInfo` + `userList` 遍历接口（供 Ave/TP 审核与链下对账）
> - **阶段门槛确认**：<1000 万 U 只卖不买 / 1000-2000 万 U 白名单额度 1:1 / ≥2000 万 U 白名单内自由买卖
> - 决策记录扩至 **16 项**（§7.3 新增 #14/#15/#16）
> - **v6 冻结基线**：13 项决策确认；GST 其余永久锁定；不采用 UUPS；滑点基准 = 底池 GST 数量减少（1/2/3/4% → 10/20/40/80%）

---

## 0. 项目定位

### 0.1 与 NBDAO 的关系
- 界面与功能模块 1:1 对应（仪表板 / 兑换 / 算力 / LP / 记录 / 社区），参数略调
- 底池从「NBDAO 单代币」改为「**GST 计价底池 + ZYT 流通代币**」双层，GST 为项目自建
- 本项目独立重写合约 + 前端，不复用 NBDAO 编译产物

### 0.2 核心特性（已确认）

| 类别 | 关键点 |
|---|---|
| GST 供应 | 总量 3.33 亿枚，初始价 1 USDT；底池注入 2.1 万枚（等值 2.1 万 U），其余**永久锁定**（多签地址，底池外零流通） |
| ZYT 供应 | 总量 21 亿枚；初始底池 2.1 万 U 等值 GST + 21 亿 ZYT（LP 100% 打入黑洞销毁） |
| 初始价格 | 1 ZYT = 0.00001 USDT（底池比例决定） |
| 入金 | **仅 USDT**；100% 进入；40% 营销/生态、60% 注入底池；**买入需白名单** |
| 算力 | 入金即获算力；1000U → 1000 算力，日复利 +1% |
| 动态奖励 | 1 代 7%、2-10 代各 2%、11-20 代各 0.5%；另 10% 归技术运维与社区 |
| 动态额度 | **动态收益额度 = 累计入金 × 5**（如入单 1000U → 额度 5000U）；额度耗尽后**停发收益，复投（新入金）恢复** |
| 静态出局 | 累计提取 ≥ 2 × 入金 → 停止静态产出 |
| 通缩 | **每日 08:00–08:10（北京时间）** 底池 2%（1% 销毁 + 1% 算力加权分红），直到底池剩 500 万枚；**8 点后执行 → Ave 显示供应减少/价格上涨** |
| 买入白名单 | **全程启用**（防闪电贷）：阶段 2/3 仅白名单地址可买入，多签增删；阶段 1 本就只卖不买 |
| 当日快照基准价 | 买入/卖出计价统一用 **08:00 快照锁定价**（快照时 GST 美元值 ÷ 快照时池 ZYT），当日恒定、次日刷新；闪电贷单笔交易无法操纵当日价格 |
| 滑点（下跌控盘） | **每日 08:00 快照底池古水币（GST）数量为基准**；当日底池 GST 减少 ≥1%→滑点 10%、≥2%→20%、≥3%→40%、≥4%→80%；未达档位为基础 5% |
| 滑点分配 | 30% 营销地址 + 30% 算力加权 + 40% 黑洞销毁 |
| 阶段门控 | 底池 <1000 万 U：只卖不买；1000-2000 万 U：白名单内按额度买（额度 = 入金额度 1:1）；≥2000 万 U：白名单内自由买卖 |
| 强制卖出 | 首次收币后两个月内分 4 次 15 天周期：20% / 10% / 10% / 10%，未执行自动销毁 |
| 转账 | 转账视同卖出，扣 10% 滑点；接收钱包同样启动强制卖出 |
| 链上卖出统计 | ZYTToken 记录每个用户卖出次数/累计卖出量/首收时间，提供 `userList` 遍历接口（Ave/TP 审核与链下对账用） |
| 下跌控盘 | **不用紧急回购**：下跌时（底池古水币 GST 数量减少）滑点自动逐档升高，阻止套利砸盘、保护底池 |

### 0.3 技术取舍
- **去中心化优先**：所有经济逻辑（入金、出金、销毁、出局、强制卖出、动态滑点、额度）全部上链；前端只读 + 签名
- **GST 为项目自建底池币**：作为 USDT 与 ZYT 之间的计价层与滑点承受层，前端不暴露；用户只看到 USDT ↔ ZYT
- **静态/动态双出局链上记账**：静态 = 累计提取 ≥ 2×入金；动态 = 动态收益（推荐 + 产出）≥ 5×入金，额度耗尽停发、复投恢复
- **买入白名单 = 防闪电贷第一道防线**：非白名单地址无法调用买入/入金，脚本化攻击者无入场通道
- **当日快照基准价 = 防价格操纵第二道防线**：买入/卖出统一用 08:00 快照锁定价（TWAP 简化版），单笔交易内的池价波动无法传导到 ZYT 计价
- **动态滑点 = 下跌控盘**：每日 08:00 快照底池古水币（GST）数量为基准，当日卖出按 GST 减少比例自动升档滑点，代替回购机制抑制砸盘
- **每日快照/通缩 08:00–08:10（北京时间，与 Ave 平台同步）**：8 点后执行，参数化可调
- **多签 + 紧急暂停**：营销/技术地址走 Gnosis Safe 多签；合约支持 pause（无紧急回购）

---

## 1. 系统架构总览

### 1.1 四层架构

```
┌──────────────────────────────────────────────────────────┐
│  用户层：浏览器 + 钱包插件（MetaMask / TP / OKX Web3）   │
└────────────────────────┬─────────────────────────────────┘
                         │ RPC + 签名
┌────────────────────────▼─────────────────────────────────┐
│  前端 DApp：Vue3 + Vant + ethers v6（移动端 H5）          │
│  仪表板 · 兑换 · 算力 · 记录 · 社区 · 简/繁/英          │
└────────────────────────┬─────────────────────────────────┘
                         │ 合约调用 / 事件订阅 / 链下数据 API
┌────────────────────────▼─────────────────────────────────┐
│  链下服务层（Node.js / 云函数 / 托管数据库）              │
│  Keeper 快照机器人 · 数据索引 · 链下账本 · 监控告警      │
└────────────────────────┬─────────────────────────────────┘
                         │ 定时合约调用（Keeper）/ 事件同步
┌────────────────────────▼─────────────────────────────────┐
│  ZYT 合约体系（BSC 链上，9 模块）                         │
│  GSTToken · ZYTToken · ZYTPool · ZYTMining · ZYTCompute  │
│  ZYTReferral · ZYTDeflation · ZYTForceSell · ZYTConfig   │
└────────────────────────┬─────────────────────────────────┘
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
   PancakeSwap V2（USDT↔GST 兑换）   BSC 官方 USDT
```

### 1.2 合约拆分（9 模块）

| 合约 | 职责 | 关键函数 |
|---|---|---|
| **GSTToken** | BEP20 底池代币（自建，3.33 亿枚，1U 起步）；底池部分转出，其余锁定 | transfer/burn、lockSupply |
| **ZYTToken** | BEP20 主代币；含转账税/销毁/强制卖出 hook；**用户卖出统计（sellInfo + userList 遍历接口）** | transfer/transferFrom、_beforeTokenTransfer、burn、getUserCount/getUserAt/getSellInfo |
| **ZYTPoolManager** | 底池记账（GST+ZYT）、阶段门控、**买入白名单**、**当日快照基准价 + 动态滑点档位** | getStage()、getCurrentSlippage()、updateSnapshot()、recordGSTIn/Out、setBuyWhitelist() |
| **ZYTMining** | 入金/入单（**白名单校验**）、算力发放、每日产出领取、动态额度控制 | deposit()、claim()、dailyRelease()、checkQuota() |
| **ZYTCompute** | 算力复利 + 静态/动态双出局阈值 | powerOf()、checkExit()、checkQuota() |
| **ZYTReferral** | 推荐关系绑定、动态分账（1代7% / 2-10代2% / 11-20代0.5% / 10% 营销） | bindRef()、distributeRefBonus() |
| **ZYTDeflation** | 每日 2% 通缩（1% 销毁 + 1% 算力加权分红）+ **快照基准价更新** | dailySnapshot() |
| **ZYTForceSell** | 4 窗口强制卖出检查 + 状态位 | checkAndBurn()、recordTransfer() |
| **ZYTConfig** | 全局参数、**白名单开关**、紧急开关（pause） | setParam()（多签）、pause()/unpause() |

### 1.3 合约依赖

```
GSTToken ──供池──> ZYTPoolManager
ZYTToken ──hook──> ZYTForceSell
   │                  │
   │                  └─> ZYTPoolManager (扣滑点，按 GST 快照基准；卖出统计上报)
   │
   ├──> ZYTMining ──> ZYTCompute (算力/静态2×/动态5×额度)
   │      └─> ZYTReferral (分账，计入动态额度)
   │
   ├──> ZYTDeflation (每日触发：通缩 + 更新滑点/价格快照基准)
   │
   └──> ZYTConfig (参数源 / 白名单开关 / 紧急暂停)
```

### 1.4 链下服务架构（项目运行必需，方案补充）

> 链上合约不会「自己动」：每日快照/通缩/算力发放需要定时触发；前端仪表板数据需要聚合索引。链下服务层是让项目稳定运营的关键，与合约、前端并行开发。

| 子服务 | 职责 | 技术选型 |
|---|---|---|
| **Keeper 快照机器人** | 每日 **08:00–08:10（北京时间）** 触发 `dailySnapshot()`（通缩 + 滑点/价格基准更新）/ `dailyRelease()`；失败重试与补快照 | Node.js + node-cron（或 Chainlink Automation） |
| **链上数据索引** | 聚合 Deposit/Sell/Snapshot/Burn 事件，供前端仪表板查询 | Ponder / The Graph / Moralis Streams |
| **链下账本** | 算力日复利 +1%、静态/动态出局阈值、动态额度、强制卖出窗口的逐用户预计算；链上为最终依据 | PostgreSQL + Redis |
| **监控告警** | 合约调用失败率、底池突变、大额转账、索引延迟 | 自建（Node + TG Bot / 邮件）或 Tenderly Alerts |
| **对账任务** | 每日链下账本与链上合约状态对账（含 **userList 逐用户交叉校验**），发现差异告警 | cron + SQL 比对 |

**架构原则**：
- **链上**：资金安全相关（入金/出金/销毁/分红/额度），只相信合约状态
- **链下**：性能相关（展示、预计算、统计），允许延迟与近似，但**不允许与链上产生金额分歧**
- 每日对账是链下服务的强制项，差异超过阈值（如 0.1%）自动暂停前端展示并告警

---

## 2. 完整参数表

| 分类 | 参数 | 默认值 | 备注 |
|---|---|---|---|
| GST 供应 | GST 总量 | 3_3300_0000 × 1e18 | 333,000,000 |
| GST 供应 | GST 初始价 | 1 USDT | 底池 2.1 万 U 等值 |
| GST 供应 | 底池注入 | 2.1 万枚 | 等值 2.1 万 U |
| GST 供应 | 其余供应 | 永久锁定 | 多签地址锁定，底池外零流通（已确认） |
| ZYT 供应 | ZYT 总量 | 21_0000_0000 × 1e18 | 2,100,000,000 |
| ZYT 供应 | 初始底池 ZYT | 全量 21 亿 | 100% 注入底池 |
| ZYT 供应 | 初始价格 | 0.00001 U/ZYT | = 21000 / 21e8 |
| ZYT 供应 | LP 锁定 | 100% 打黑洞销毁 | 不走第三方锁仓服务 |
| 入金 | 入金代币 | **仅 USDT** | 不支持 BNB |
| 入金 | 最小/最大入金 | 100 / 500 U | 参数可调（minDeposit/maxDeposit） |
| 入金 | **买入权限** | **白名单** | **全程启用**：非白名单地址 `deposit()` 直接拒绝（多签增删） |
| 入金 | 营销分成 | 40% | 划到 Gnosis Safe 多签地址 |
| 入金 | 底池注入 | 60% | 经 PancakeSwap 换 GST 注入底池，按**当日快照基准价** mint ZYT 给用户 |
| 定价 | **计价基准** | **当日快照锁定价** | 08:00 快照时 GST 美元值 ÷ 快照时池 ZYT，当日恒定；买入/卖出统一使用 |
| 算力 | 算力倍率 | 1.0 | 入金额 × 倍率 = 算力 |
| 算力 | 日复利率 | 1% / 天 | 1000/1010/1020.1/... |
| 算力 | 算力补偿公式 | power = base × (1.01)^n | n = 入金后天数 |
| 动态额度 | 额度倍数 | 5 | 动态收益额度 = 累计入金 × 5（入单 1000U → 5000U） |
| 动态额度 | 额度耗尽 | 停发收益 | 复投（新入金）后额度恢复 |
| 推荐 | 1 代 | 7% | 直推 |
| 推荐 | 2-10 代 | 各 2% | |
| 推荐 | 11-20 代 | 各 0.5% | |
| 推荐 | 技术运维 | 10% | 固定地址（多签） |
| 出局 | 静态倍数 | 2 | withdrawTotal ≥ 2 × depositTotal 时停发 |
| 通缩 | 每日通缩率 | 2% | poolZYT × 2% |
| 通缩 | **执行时刻** | **08:00–08:10 北京时间** | 8 点后通缩 → Ave 显示供应减/价格上涨；自然日键、迟到可补 |
| 通缩 | 销毁占比 | 1%（总通缩的 50%） | 打黑洞 |
| 通缩 | 分红占比 | 1%（总通缩的 50%） | 按算力加权 |
| 通缩 | 通缩底线 | 5_000_000 枚 | 达到后停止每日通缩 |
| 滑点 | 基础滑点 | 5% | 底池 GST 减少 < 1% 时 |
| 滑点 | 快照基准 | 每日 08:00 | 更新 snapshotPoolGST（底池古水币数量），当日判定基准 |
| 滑点 | 档位 1（底池 GST 减少 ≥1%） | 10% | 相对当日快照基准 |
| 滑点 | 档位 2（底池 GST 减少 ≥2%） | 20% | |
| 滑点 | 档位 3（底池 GST 减少 ≥3%） | 40% | |
| 滑点 | 档位 4（底池 GST 减少 ≥4%） | 80% | |
| 滑点 | 分配 | 30% 营销 + 30% 算力 + 40% 黑洞 | 所有档位统一 |
| 滑点 | 转账滑点 | 10% | 转账视同卖出 |
| 阶段 | 阶段 1 | 底池 < 1000 万 U | **只卖不买**（买入通道完全关闭） |
| 阶段 | 阶段 2 | 1000-2000 万 U | **白名单内**买入，买币额度 = 入金额度（1:1） |
| 阶段 | 阶段 3 | ≥ 2000 万 U | **白名单内**自由买卖（不限额度） |
| 卖出统计 | 链上记录 | UserSellInfo | 卖出次数/累计卖出/首收时间/窗口位图 + userList 遍历接口 |
| 强制卖出 | 窗口 1 | 0-15 天 | 未卖 20% → 销毁 20% |
| 强制卖出 | 窗口 2 | 15-30 天 | 未卖 10% → 销毁 10% |
| 强制卖出 | 窗口 3 | 30-45 天 | 未卖 10% → 销毁 10% |
| 强制卖出 | 窗口 4 | 45-60 天 | 未卖 10% → 销毁 10% |
| 强制卖出 | 接收方 | 同样启动 | |
| 时间 | 快照时间 | 08:00 北京时间 | 与 Ave 平台同步；通缩紧随其后执行 |
| 治理 | 营销/技术地址 | Gnosis Safe 多签 | 2/3 或 3/5，多签 |
| 治理 | 白名单管理 | 多签增删 | buyWhitelistEnabled 开关 + setBuyWhitelist() |
| 治理 | 紧急暂停 | pause() 预留 | 仅暂停，无紧急回购 |
| 多语言 | 语言包 | 简体 / 繁体 / 英文 | zh-CN / zh-TW / en |

---

## 3. 关键流程

### 3.1 入金流程（仅 USDT，白名单校验 + 快照基准价）

```
[前端] 用户输入 USDT 金额 + 推荐人 ref（非白名单用户隐藏入金入口，仅展示卖出）
   │
   ▼
[ZYTMining.deposit(usdtAmount, ref)]
   │
   ├─ 1. 校验：
   │       ├─ 阶段 ≥ 2（阶段 1 只卖不买，直接拒绝）
   │       ├─ **buyWhitelist[user] == true（防闪电贷第一道防线，非白名单拒绝）**
   │       ├─ 金额在 [minDeposit, maxDeposit]
   │       └─ 阶段 2 时：本笔入金后 lpQuota ≤ 入金额度（1:1）
   ├─ 2. 转账 USDT：user → ZYTPoolManager（TransferFrom）
   ├─ 3. 划拨 40%：ZYTPool → MARKET（多签地址）
   ├─ 4. 注入底池：60% USDT 经 PancakeSwap 换为 GST → 入 ZYT 底池
   ├─ 5. mint ZYT：60% × usdtAmount / **snapshotPrice（当日 08:00 快照锁定价）** → user
   │       snapshotPrice = 快照时 poolGST_USDT_value / 快照时 poolZYT（当日恒定）
   ├─ 6. 记录：userDepositTotal[user] += usdtAmount
   │       阶段 2 时：userLP[user] += usdtAmount（买币额度 = 入金额度 1:1）
   ├─ 7. 计算算力：power = usdtAmount × POWER_RATE
   ├─ 8. 写入：userPower[user] += power；userPowerBase[user] = power
   ├─ 9. 刷新动态额度：dynamicQuota[user] = depositTotal × 5（复投恢复收益）
   ├─ 10. 推荐分账：ZYTReferral.distribute(user, usdtAmount, ref)
   │       ├─ 1 代 7% → mint 给 ref（计入 ref 的动态额度消耗）
   │       ├─ 2-10 代各 2% → mint 给上级链
   │       └─ 10% → TECHNICAL（多签地址）
   └─ 11. 事件：Deposited(user, usdt, zytMinted, powerAdded, quota, ref)
```

### 3.2 每日快照与通缩（08:00–08:10 北京时间）

```
[Keeper] 08:00–08:10 窗口调用 ZYTDeflation.dailySnapshot()（UTC cron: 0 0 * * *）
   │
   ├─ 1. 更新滑点基准：snapshotPoolGST = 当前底池古水币数量（当日卖出判定基准）
   ├─ 2. **更新计价基准：snapshotPrice = 当前 poolGST_USDT_value / poolZYT（当日买入/卖出统一锁定价）**
   ├─ 3. 读取 poolZYT；若 ≤ 5_000_000 → 跳过通缩部分
   ├─ 4. burnAmount = poolZYT × 2%
   ├─ 5. burnToBlackhole = burnAmount / 2 → ZYTToken.burn（总供应 -1%）
   ├─ 6. dividendAmount = burnAmount / 2 → 累计到 dividendPool
   ├─ 7. ZYTMining.dailyRelease()
   │       ├─ totalPower = 全网 Σ userPower
   │       ├─ dailyRelease = dailyRewardPool（参数控制）
   │       ├─ 对每个用户：
   │       │   ├─ 检查动态额度：dynamicWithdrawn ≥ dynamicQuota → 跳过（无收益）
   │       │   ├─ 检查静态出局：withdrawTotal ≥ 2×depositTotal → 跳过
   │       │   └─ userShare = userPower / totalPower × dailyRelease
   │       │       → userPendingReward[user]（claim 时计入 dynamicWithdrawn）
   │       └─ 事件：SnapshotExecuted(day, burned, dividend, released, snapshotGST, snapshotPrice)
   └─ 8. 额度耗尽用户：前端展示「复投入金 N U 恢复收益」引导
```

> 💡 **Ave 显示上涨**：通缩在 08:00 后执行 → 总供应减少 → Ave 拉取数据显示供应下降、价格上行箭头。

### 3.3 卖出 / 转账（含强制卖出 hook、动态滑点、快照基准价）

```
[任意 transfer / transferFrom] 触发 _beforeTokenTransfer
   │
   ├─ 1. 若 to == 白名单（底池/合约）→ 跳过部分 hook
   ├─ 2. ZYTForceSell.checkAndBurn(from, to, amount)
   │       ├─ 首次收币记录 firstReceiveTime[user]
   │       ├─ 4 个 15 天窗口检查（0-15/15-30/30-45/45-60 天）
   │       │   未达最低卖出比例 → 自动销毁对应比例
   │       └─ 接收方同样启动 firstReceiveTime
   ├─ 3. **卖出统计上报：ZYTToken.sellInfo[user] 更新（次数/累计卖出/时间），新增用户入 userList**
   ├─ 4. 动态滑点判定（ZYTPool.getCurrentSlippage）：
   │       reduction = (snapshotPoolGST - poolGST) / snapshotPoolGST
   │       ├─ reduction < 1%  → 5%（基础）
   │       ├─ reduction ≥ 1%  → 10%
   │       ├─ reduction ≥ 2%  → 20%
   │       ├─ reduction ≥ 3%  → 40%
   │       └─ reduction ≥ 4%  → 80%（底池古水币减少越深滑点越高 = 控盘）
   ├─ 5. 滑点 = amount × slippageRate
   │       ├─ 30% → MARKET（多签）
   │       ├─ 30% → 累计到 dividendPool（算力加权）
   │       └─ 40% → 黑洞销毁
   ├─ 6. 若卖出（to == ZYTPool）：
   │       ├─ USDT 出 = 净 ZYT × **snapshotPrice（当日快照锁定价，防闪电贷操纵）**
   │       └─ ZYTPool 转 USDT 给 user
   ├─ 7. 记账：
   │       ├─ userWithdrawTotal[user] += usdtOut（静态 2 倍判断）
   │       └─ ZYTCompute.checkExit()：达标即 userPower = 0
   └─ 8. 事件：Sold/Transferred + ForceSellBurned + SlippageCollected(rate)
```

### 3.4 阶段门控（白名单贯穿阶段 2/3）

```
[入金时] ZYTMining.deposit
   │
   └─ 检查 stage = ZYTPool.getStage()
        ├─ stage=1 (底池 < 10M U)：拒绝入金（只卖不买）
        ├─ stage=2 (10M ≤ 底池 < 20M U)：
        │     ├─ **require(buyWhitelist[user])（防闪电贷）**
        │     └─ 校验：本笔入金后 lpQuota ≤ 入金额度（1:1，入单 1000U 可买 1000U 币）
        └─ stage=3 (底池 ≥ 20M U)：
              **require(buyWhitelist[user])（白名单内自由，不限额度）**
```

### 3.5 推荐关系与动态额度

```
[入金时] 携带 ref
   │
   ├─ 若 ref == address(0) || ref == user → 无推荐
   └─ 否则按 20 代链分账：
        ├─ 1 代：amount × 7% → mint 给 ref
        ├─ 2-10 代：各 amount × 2% → mint 给上级链
        ├─ 11-20 代：各 amount × 0.5% → mint 给更上级链
        ├─ 10% → TECHNICAL_ADDRESS
        └─ 所有推荐奖励 mint 的同时：dynamicWithdrawn[收款人] += 奖励
            （动态额度=5×入金，累计消耗达额度 → 停发；复投恢复）
```

---

## 4. 前端架构

### 4.1 页面与组件（按 NBDAO 三张图还原）

| 截图 | 组件 | 功能 |
|---|---|---|
| 图 1 顶部 | Header | 钱包地址缩写、语言切换（简/繁/英）、社区入口 |
| 图 1 中部 | DataDashboard | 8 项核心数据（总供应、销毁、算力、LP 等）+ 底池 + 市价 + 当前滑点档位 |
| 图 1 下部 | MyAssets | 累计收益 + 钱包余额（含提现/充值图标） |
| 图 2 | TokenSelector | 弹窗：BNB / NBDAO（→ ZYT） / USDT 三选一（BNB 仅展示禁用） |
| 图 3 | SwapPanel | 卖出输入 + 比例按钮（20/50/70/MAX）+ **实时滑点档位显示** + 确认 |
| 底部 | Footer | Telegram / Twitter 入口 |

> 动态额度提示：仪表板/收益区展示「动态额度剩余」，额度耗尽时展示「复投入金恢复收益」引导按钮。
> 滑点提示：卖出面板实时显示当前档位（如「当前滑点 20%：底池古水币减少 2%」），避免用户意外成交。
> **白名单提示（v7 新增）**：非白名单用户隐藏入金/买入入口，仅展示卖出与「申请白名单」引导。

### 4.2 完整页面树

```
src/
├─ views/
│  ├─ Home.vue                  # 仪表板（图 1）
│  ├─ Swap.vue                  # 兑换面板（图 2、3；非白名单仅显示卖出）
│  ├─ Mining.vue                # 算力与每日产出（含额度展示）
│  ├─ Liquidity.vue             # LP 记录与我的贡献
│  ├─ Records.vue               # 交易/销毁/产出记录
│  └─ Community.vue             # 社区与公告
├─ components/
│  ├─ WalletConnect.vue
│  ├─ DataDashboard.vue
│  ├─ TokenSelector.vue         # 代币选择弹窗
│  ├─ SwapPanel.vue
│  ├─ PowerCard.vue
│  ├─ QuotaCard.vue             # 动态额度展示 + 复投引导
│  ├─ SlippageBadge.vue         # 当前滑点档位徽标
│  └─ PoolCard.vue
├─ composables/
│  ├─ useWallet.ts
│  ├─ useZYTContract.ts
│  └─ usePool.ts
├─ store/                       # pinia
├─ i18n/                        # zh-CN / zh-TW / en
└─ assets/
```

### 4.3 技术栈

| 类别 | 选型 | 理由 |
|---|---|---|
| 框架 | Vue 3 + Vite + TS | 与 NBDAO 同栈，移动端 H5 体验佳 |
| 组件库 | Vant 4 | 移动端 H5，对应 NBDAO 的视觉风格 |
| Web3 | ethers.js v6 | 主流、轻量、TS 友好 |
| 状态 | pinia | Vue3 官方推荐 |
| 时间 | dayjs | 轻量；快照时间 08:00 北京时间展示 |
| 样式 | SCSS + CSS Vars | 主题切换预留 |
| 多语言 | vue-i18n | zh-CN / zh-TW / en 三包 |
| 部署 | GitHub Pages / CloudStudio | 与 NBDAO 同形式 |

### 4.4 前端增强（传播与稳定性）

| 增强项 | 说明 | 优先级 |
|---|---|---|
| **推荐链接系统** | URL 携带 `?ref=0x…` 参数解析 + 二维码生成；此类盘传播全靠邀请链接 | 高 |
| **Sentry 错误监控** | 前端报错自动收集上报 | 中 |
| **PWA 优化** | 可安装到手机桌面、弱网可用 | 低 |
| **钱包多兼容** | 兼容 `window.ethereum` 注入协议（MetaMask/TP/OKX）；**已实现 TP 内置 DApp 访问**：EIP-6963 钱包发现 + isTokenPocket 识别 + 会话静默恢复 + 事件容错（2026-09-01） | 高 |
| **额度 + 滑点引导** | 额度耗尽时高亮复投按钮；滑点档位升高时警示提示 | 中 |
| **白名单申请引导（v7 新增）** | 非白名单用户展示「申请白名单」入口与流程说明 | 中 |

---

## 5. 关键数据状态

### 5.1 全局（ZYTConfig）

```solidity
struct GlobalConfig {
    uint256 gstMaxSupply;           // 3.33e8
    uint256 zytMaxSupply;           // 2.1e9
    uint256 minDeposit;             // 100e18
    uint256 maxDeposit;             // 500e18
    uint256 marketingRate;          // 4000 (40%)
    uint256 powerRate;              // 10000 (1.0)
    uint256 dailyCompoundRate;      // 100 (1%)
    uint256 dynamicQuotaMul;        // 5 (动态额度 = 入金 × 5)
    uint256 staticExitMul;          // 2 (静态出局)
    uint256 deflationRate;          // 200 (2%)
    uint256 deflationFloor;         // 5e6
    bool    buyWhitelistEnabled;    // v7: 买入白名单开关（默认 true，全程启用）
    uint256 baseSlippage;           // 500 (5%)
    uint256 slippageTier1;          // 1000 (10%) 底池 GST 减少 ≥1%
    uint256 slippageTier2;          // 2000 (20%) 底池 GST 减少 ≥2%
    uint256 slippageTier3;          // 4000 (40%) 底池 GST 减少 ≥3%
    uint256 slippageTier4;          // 8000 (80%) 底池 GST 减少 ≥4%
    uint256 transferSlippage;       // 1000 (10%)
    uint256 poolStage1USDT;         // 10_000_000e18
    uint256 poolStage2USDT;         // 20_000_000e18
    uint256 snapshotTime;           // 28800 (08:00 UTC+8，与 Ave 同步)
    address marketAddress;          // 营销多签（Gnosis Safe）
    address technicalAddress;       // 技术多签（Gnosis Safe）
    address blackHole;              // 0x...dEaD
    address router;                 // PancakeSwap V2 Router
    address usdt;                   // BSC 官方 USDT
}
```

### 5.2 用户（UserState）

```solidity
struct UserState {
    uint256 depositTotal;           // 累计入金 USDT（1e18）
    uint256 withdrawTotal;          // 累计提取 USDT（静态 2 倍判断）
    uint256 dynamicQuota;           // 动态收益额度 = depositTotal × 5
    uint256 dynamicWithdrawn;       // 已消耗动态额度（推荐+产出）
    uint256 power;                  // 当前算力
    uint256 powerBase;              // 算力基数
    uint256 powerCompoundDay;       // 算力复利计数
    uint256 pendingReward;          // 待领取产出
    uint256 pendingDividend;        // 待领取分红
    uint256 firstReceiveTime;       // 首次收币时间
    uint256 windowFlags;            // 4 窗口位图（已卖/已销毁）
    uint256 referrer;               // 直推上级
    uint256 lpQuota;                // 阶段 2 买币额度（= 入金额度 1:1）
}
```

### 5.3 底池（PoolState）

```solidity
struct PoolState {
    uint256 poolGST;                // 底池 GST 数量
    uint256 poolZYT;                // 底池 ZYT 数量
    uint256 poolUSDT;               // 折算 USDT（= poolGST × GST 价格，阶段判断）
    uint256 snapshotPoolGST;        // 每日 08:00 快照基准（底池古水币数量，当日滑点判定）
    uint256 snapshotPrice;          // v7: 当日 08:00 快照锁定价（买入/卖出统一计价基准，防闪电贷）
    uint256 totalSupply;            // 当前流通（含底池）
    uint256 burned;                 // 累计销毁
    uint256 dividendPool;           // 待分配分红池
    uint256 dailyRewardPool;        // 每日释放池
}
```

### 5.4 用户卖出统计（ZYTToken，v7 新增）

```solidity
struct UserSellInfo {
    uint256 sellCount;              // 卖出次数
    uint256 totalSellZyt;           // 累计卖出 ZYT
    uint256 totalSellUsdt;          // 累计卖出折合 USDT
    uint256 firstReceiveAt;         // 首次收币时间（强制卖出起点）
    uint256 lastSellAt;             // 最近卖出时间
    uint256 windowFlags;            // 4 窗口位图（与 ZYTForceSell 共用）
}
mapping(address => UserSellInfo) public sellInfo;   // 按用户查询
address[] public userList;                          // 用户列表（新增时 push 一次）
mapping(address => uint256) public userIndex;       // 去重索引

// 只读接口（供 Ave/TP 审核、链下对账、风控遍历）：
//   getUserCount() → uint256 用户总数
//   getUserAt(i)   → address  第 i 个用户
//   getSellInfo(a) → UserSellInfo
```

---

## 6. 部署与上线路径

### 6.1 部署流程

```
1. 合约开发 + Hardhat 单元测试 + Slither 静态扫描
2. BSC testnet 部署（≥ 3 轮集成测试：入金/出金/算力/销毁/强制卖出/额度/滑点档位/白名单/快照价）
3. 前端接 testnet，Playwright E2E
4. 链下服务开发：Keeper 机器人 + 数据索引 + 链下账本（testnet 联调）
5. 安全审计（推荐：CertiK / SlowMist，至少 1 家头部）
6. 修复审计问题，回归测试
7. BSC mainnet 部署：
   a. 部署 GSTToken（3.33 亿），其余锁定
   b. 部署 ZYT 8 合约（不可升级，不采用 UUPS；参数调整走 ZYTConfig 多签）
   b2. deploy.js 接线（第二轮修复落点，缺一不可）：
       - zyt.setConfig(configAddr) —— 激活 V6 转账 10% 滑点税 + V7 totalSupplyCap 保险丝（生产静默失效曾为 P0-1）
       - keeperAddress（KEEPER_ADDRESS 环境变量）—— owner 转多签后 dailySnapshot 触发兜底（P2-3）
       - poolStage1USDT=0 —— 初始 stage2（LP 额度 1:1）启动，跳过"<1000 万只卖不买"死锁（P0-2）
       - WHITELIST="0xaddr1,0xaddr2" —— 运营首批买入白名单批量放行（P2-4，空则后续多签添加）
   c. bscscan verify 全部合约
8. 创建 PancakeSwap 流动性：
   a. GST/USDT 池（2.1 万 U 等值）
   b. 底池注入：2.1 万枚 GST + 21 亿 ZYT
9. LP 100% 直接打入黑洞地址（公示交易哈希，不走第三方锁仓）
10. 生产部署链下服务：Keeper 定时启动（含 08:00 滑点/价格基准更新）、索引同步、监控告警上线
11. 前端切 mainnet，参数配置写入 ZYTConfig（含多签确认：白名单名单、阶段参数）
12. 公告与社区同步
```

### 6.2 上线前自检清单

- [ ] 所有合约已 verify（含 GSTToken）
- [ ] LP 打入黑洞交易哈希已公开
- [ ] Config 参数已多签确认（Gnosis Safe）
- [ ] MARKET/TECHNICAL 地址为 Gnosis Safe 多签
- [ ] emergency pause 已测试（owner 可暂停入金）
- [ ] 动态额度机制测试通过（5000U 额度耗尽停发、复投恢复）
- [ ] **买入白名单测试通过（非白名单地址 deposit 被拒绝；多签可增删白名单）**
- [ ] **当日快照基准价测试通过（入金/卖出同价；闪电贷模拟操纵池价不影响当日计价）**
- [ ] **卖出统计测试通过（sellInfo 更新、userList 去重、getUserCount/getUserAt 遍历正常）**
- [ ] **启动接线完整性测试通过（post-deploy-check：configAddr / keeperAddress / 白名单 / poolStage1USDT=0 均已设置）**
- [ ] **出局复投测试通过（isExited 重置、withdrawTotal 保留、2 倍累计延续）**
- [ ] **分红强制卖出测试通过（payoutDividend 接收方启动 60 天窗口；MARKET/TECHNICAL 白名单豁免）**
- [ ] 动态滑点档位测试通过（模拟底池古水币 GST 减少 1-4% → 10/20/40/80%）
- [ ] 每日 08:00 快照基准更新测试通过（次日基准刷新）
- [ ] 快照时区已确认（北京时间 08:00，与 Ave 同步；Keeper cron 按 UTC 0 点）
- [ ] 简/繁/英三语言包已就位
- [ ] Keeper 双实例 + 互斥锁已部署（防重复触发快照）
- [ ] 索引服务同步延迟 < 5 分钟（告警阈值）
- [ ] 链下账本对账任务已上线（每日自动比对，含 userList 交叉校验）
- [ ] 前端 RPC 节点冗余（主：官方 BSC；备：ANKR / QuickNode）
- [ ] 风险提示页已上线（前端首页公告 + 白皮书）

### 6.3 链下服务运维要点

| 关注点 | 措施 |
|---|---|
| Keeper 单点故障 | 双实例 + Redis 互斥锁（SETNX）防重复触发；失败自动重试 3 次；提供手动补快照接口 |
| 索引延迟 | 告警阈值：事件同步延迟 > 5 分钟即通知 |
| 私钥安全 | Keeper 私钥权限最小化（仅授权每日快照等无资金风险函数）；营销/技术地址多签 2/3 |
| 监控规则 | 合约调用失败率、底池突变 > 10%、单笔大额转账 > 底池 5%、强制卖出异常、额度异常、滑点档位跳变、白名单异常调用 |
| 数据备份 | PostgreSQL 每日自动备份 + 恢复演练 |
| 账本对账 | 每日链下账本 vs 链上合约状态对账（含 userList 逐用户交叉校验），差异 > 0.1% 自动告警并暂停前端展示 |

---

## 7. 风险与决策记录

### 7.1 技术风险与对策

| 风险 | 对策 |
|---|---|
| **闪电贷价格操纵（v7 重点）** | **双防线**：① 买入白名单（非白名单无法入金，脚本攻击者无通道）② 当日快照基准价（08:00 锁定价，单笔交易操纵无效） |
| 算力加权分红 gas 高 | 用 Merkle Tree 离线计算 + 用户主动 claim |
| 4 窗口状态写入 | bitmap（uint256 4 位）压缩 |
| snapshotPoolGST 被操纵 | 快照由 Keeper 每日 08:00 更新（多签可校正）；快照值不可被用户直接写入 |
| **卖出统计 userList 无限增长** | 仅在新增用户时 push 一次（~20k gas）；统计更新随 hook 顺带完成；遍历接口供外部按需分页 |
| 重入攻击 | OpenZeppelin ReentrancyGuard |
| 前端 RPC 单点 | 多节点 + 降级到公共节点 |
| 推荐关系链深度限制 | 最多 20 代，超过不发放 |
| Keeper 定时任务失败 | 双实例互斥 + 自动重试 + 手动补快照接口 |
| 链下账本与链上不一致 | 每日对账任务（含 userList 交叉校验），差异 > 0.1% 告警暂停展示；链上为最终依据 |
| Keeper/多签私钥泄露 | 多签 2/3；Keeper 私钥仅授权无资金风险函数，存密钥管理服务 |
| 索引服务宕机 | 前端降级到合约直接 view 调用（慢但可用） |
| GST 价格波动传导 | GST 仅作底池计价层；前端始终按 USDT 展示，波动由快照锁定价 + 滑点档位吸收 |

### 7.2 经济风险（必告知项目方/用户）

> ⚠️ 该模式属于典型高资金盘结构，依赖新入金维持。

- 静态 2 倍 / 动态 5 倍额度是营销话术，实际能否兑现取决于底池深度与新资金流入速度
- **动态额度用完必须复投**的设计本质是强制循环投入，若无新用户进入，老用户复投即耗尽
- 强制卖出机制与「持币生息」叙事相悖，可能导致早期用户大量抛售、砸盘
- 底池 < 1000 万 U 阶段只卖不买，流动性枯竭风险极高
- 动态滑点最高 80%：底池古水币减少越深卖出越难，实际到手极少（这是**设计意图**——用滑点代替回购控盘，但也意味着深度下跌时用户近乎无法退出）
- **买入白名单**（v7）会进一步收紧入场：非白名单用户无法买入，依赖运营审核效率与公信力
- 项目方营销地址收 30% 滑点 + 10% 推荐分成 + 40% 入金分成，存在显著的「项目方抽水」风险
- **平台风险提示**（v7）：强制销毁 + 转账税 + 白名单买入会触发 GoPlus/Ave/TP 安全检测器的高风险特征，花钱购买审计与上币服务可降低但**无法保证完全消除**风险标签
- 建议在白皮书与前端显著位置做风险提示，并接受第三方安全审计

### 7.3 已确认决策记录（2026-08-20 首版 / 2026-08-27 扩至 16 项 / 2026-09-01 扩至 19 项）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 是否支持 BNB 入金 | **不支持，仅 USDT 入金**（前端 BNB 选项禁用展示） |
| 2 | GST 供应与初始价格 | **自建 GST，总量 3.33 亿枚，初始价 1 USDT**；底池注入 2.1 万枚，其余锁定 |
| 3 | 营销/技术地址多签 | **Gnosis Safe 多签**（2/3 或 3/5） |
| 4 | 快照时间 | **固定北京时间 08:00，与 Ave 平台同步** |
| 5 | 加速释放 / 动态机制 | **动态收益额度 = 入金 × 5**（入单 1000U → 5000U 额度）；额度耗尽停发收益，**复投恢复** |
| 6 | 多语言 | **简体 + 繁体 + 英文**（zh-CN / zh-TW / en） |
| 7 | 紧急回购 | **取消**。下跌控盘改为**动态滑点**：每日 08:00 快照底池古水币（GST）数量为基准，减少 1/2/3/4% → 滑点 10/20/40/80% |
| 8 | LP 锁定服务 | **直接打入黑洞地址**（不使用 Unicrypt / Team.Finance） |
| 9 | 阶段 2 买币额度 | **额度 = 入金额度（1:1）**（需求原文「入单 1000U 可买 1000U 额度的币」） |
| 10 | 滑点资金分配 | **30% 营销（多签）+ 30% 算力加权分红 + 40% 黑洞销毁**（所有档位统一） |
| 11 | 滑点判定基准 | **底池古水币（GST）数量减少**（每日 08:00 快照为基准，非 USDT 数量） |
| 12 | GST 其余供应释放方式 | **永久锁定**（多签地址持有，底池外零流通，不可释放） |
| 13 | 合约是否可升级（UUPS） | **不采用 UUPS**（不可升级）：部署简单、审计面小；参数调整全部走 ZYTConfig 多签（已满足「参数可调」需求） |
| 14 | 通缩执行时刻（v7） | **每日 08:00–08:10（北京时间）执行**：8 点后通缩 → Ave 显示供应减少/价格上涨；自然日键、迟到可补 |
| 15 | 买入白名单（v7） | **全程启用**（防闪电贷）：阶段 2/3 仅白名单地址可买（额度 1:1 / 白名单内自由），多签增删；阶段 1 只卖不买 |
| 16 | 当日快照基准价（v7） | **买入/卖出统一用 08:00 快照锁定价**（当日恒定），防闪电贷单笔交易操纵价格 |
| 17 | 启动阶段方案（第二轮） | **初始即 stage2（LP 额度 1:1）启动**：`poolStage1USDT=0` 跳过「<1000 万只卖不买」（该阶段无 mint 通道必然死锁），`poolStage2USDT=2000 万` 达标自动进 stage3 |
| 18 | 静态出局后复投（第二轮） | **复投自动重置 isExited**（出局状态解除，重新累计算力）；`withdrawTotal` 保留不清零，2 倍判定按累计延续，杜绝每轮独立提取 2 倍的崩盘路径 |
| 19 | 分红是否启动强制卖出（第二轮） | **分红同产出渠道启动 60 天强制卖出**（`payoutDividend` 接收方补 onMint 初始化 + 入 userList）；`MARKET/TECHNICAL` 地址加白名单豁免（营销/技术币不受约束） |

### 7.4 已确认假设（2026-08-20，随方案一并冻结）

| # | 假设 | 结论 |
|---|---|---|
| 1 | GST 总量中「其余锁定」的释放方式 | **永久锁定**（最稳妥，底池外零流通） |
| 2 | 合约是否采用可升级代理（UUPS） | **不采用 UUPS**：部署简单、审计面小；参数调整全部走 ZYTConfig 多签（已满足「参数可调」需求） |

---

## 8. 当前进度与下一步（2026-09-01 更新）

**已完成**：
1. **合约线**：9 合约开发完成；两轮审计 17 + 9 项全部闭环；44/44 单测全绿（含白名单/快照价/卖出统计/复投重置/分红强制卖出回归用例）
2. **前端线**：Vue3 + Vant 全页面（首页/兑换/记录/社区 + 底部导航）；TP 钱包内置 DApp 访问（EIP-6963 + 静默恢复会话）；keeper API 优先 + 合约直连降级
3. **链下服务线**：keeper 8 项生产缺口全闭合（签名钱包 / 双实例互斥锁 / 真对账 / 监控规则引擎 / MySQL 持久化 / API 加固 / 强制卖出追踪 / 前端接 API）
4. **BSC testnet 部署 + 冒烟 v2 全绿**（2026-09-01，第五套干净链 45/45 断言 PASS）：
   - P0-P6 真实链上全链路：入金（addLiquidity+deposit）→ 每日快照触发（通缩 2%、释放 10万/日、分红 2100万）→ 产出领取 → 分红领取 → 卖出（5% 滑点 30/30/40）→ 转账视同卖出（10% 税）
   - 关键机制实测通过：快照基准价锁定（1e13→1.0142857e13）、动态额度 USDT 折算（v8 修复）、非白名单卖出统计/强制卖出 hook、白名单豁免边界（黑洞收款方不入用户列表）
   - 第五套部署地址见 `zyt-contracts/scripts/smoke-testnet.js` 头注释；完整结论与踩坑经验记录于项目 memory（2026-09-01.md）
5. **keeper 对接 testnet 完成**（2026-09-01）：
   - 链上：keeperAddress → 签名钱包 `0xdFA5…480`（独立私钥仅作定时触发器）；tBNB 0.01 到账
   - `.env` 切第五套（chainId 97 / publicnode RPC / 6 合约地址 / START_BLOCK=128482000 / MySQL zyt_keeper 库）
   - 服务 5 模块全启动：indexer（幂等重放 13 事件）/ ledger（rebuild users=1）/ keeper（cron `0 0 * * *` = 北京 08:00）/ monitor（R1-R5）/ forcesell / API :8080
   - 真对账通过：链上 userList 1 用户与链下账本一致；API /health /stats /user /power 数据与冒烟结果精确吻合（withdraw_total=9.6357U = P5 卖出值）
   - **修复数据污染 bug（v9）**：ledger.rebuild 的 SELECT 未按 chain_id 过滤，本地 hardhat（31337）残留事件混入 users 账本（users=4 含 3 幽灵用户）→ totalPower 失真；已加 `WHERE chain_id=?` 并清库重放，users=1 干净
   - 快照写交易链路验证：签名钱包 dailySnapshot 进入 estimateGas 后 revert `"Deflation: once per day"`（今天快照已被冒烟消耗）——revert 消息发生在 keeper 门控之后，证明 keeperAddress 权限生效；真实触发待次日 08:00 cron

**下一步**（按顺序）：
1. **bscscan 源码验证**：testnet 9 合约 + ZYTCompute 库逐一对 Etherscan 提交源码验证（需用户在 `zyt-contracts/.env` 填入 BSCSCAN_API_KEY 后运行 `npx hardhat run scripts/verify-all-testnet.js --network bscTestnet`），锁定部署产物可审计性
2. **keeper 稳定性试运行**（2-4 周）：重点观察明日 08:00 起 cron 每日真实触发快照、对账/监控/告警长跑、MySQL 持久化（events/users/pool_state/snapshots 随运行增长）
3. **上线准备**：Gnosis Safe 多签（营销 + 技术地址）、第三方审计（CertiK / SlowMist / Beosin）、参数核对表、GoPlus 自检
4. **P3 收尾**：8 项低危按需处理（转账余额边界 / LP 永锁披露 / pause 语义 / snapshotTime 未用 / setUint 关系校验 / downlineCount 死代码 / dailyBurn 记账截断 / keeper 漏快照失真）
5. **前端生产构建 + 部署**：非沙箱 `npx vite build` 刷新 dist，上传并更新 `?v=` 缓存参数

**上线前**（必做）：
1. 第三方安全审计
2. 法律合规审查
3. testnet 试运行 2-4 周（冒烟已验业务链路；试运行阶段重点验证 Keeper 稳定性与额度/滑点/白名单/快照价机制长期运行）
4. 链下账本与链上对账演练（含 userList 交叉校验）

---

## 9. 明确不需要的技术（避免过度工程）

| 技术 | 原因 |
|---|---|
| 跨链桥 / 多链部署 | BSC 单链即可，跨链引入额外审计面与运营成本 |
| DAO 治理投票 | 非治理型项目，参数由多签控制即可 |
| Chainlink VRF 随机数 | 无抽奖/随机场景 |
| Chainlink 实时价格预言机 | 已用当日快照基准价（TWAP 简化版），无需外部喂价 |
| ZK / 隐私技术 | 无需求 |
| NFT 生态 | 无叙事关联，暂不引入 |
| 原生 iOS/Android App | 移动端 H5 + PWA 足够，原生成本高、审核风险大 |
| 第三方 LP 锁仓服务 | 已确认 LP 直接打入黑洞，无需 Unicrypt/Team.Finance |
| 紧急回购合约 | 已确认取消，下跌控盘由动态滑点承担 |

---

> 📌 **说明**：本方案是基于 NBDAO 三张界面截图与需求文档整理的技术蓝图，未涉及任何投资建议。19 项决策已全部确认（见 7.3），方案冻结（v7，2026-09-01 补记第二轮审计结论与决策 17-19），可作为合约 / 前端 / 链下服务开发的唯一基准。
