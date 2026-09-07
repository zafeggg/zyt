# 众赢币（ZYT）合约接口参考

> 版本：v1.0（2026-09-03）｜ 依据：contracts/*.sol 源码（冻结版 v7 落地代码），非设计稿
> 关联：众赢币(ZYT)_技术方案.md §1.2/§5（已同步校正函数名）、合约安全审计报告.md
> 用途：对接 dapp / keeper / 审计 / 第三方读链的统一接口口径

## 0. 全局约定

| 项 | 约定 |
|---|---|
| 精度 | 全部金额/数量 1e18；滑点与费率用基点（bps，1%=100，满额 10000） |
| 时间 | 全部 Unix 秒；`day = block.timestamp / 86400`（UTC） |
| 权限角色 | owner（可迁移给多签）/ mining / pool / deflation / forceSell / keeperAddress / minter |
| 事件签名变更 | 必须三处同步：合约 emit、dapp/src/abis/*.ts、keeper/src/abis.js + ledger.js |
| 主入口 | 用户写操作全走 ZYTMining（deposit/sellZyt/claim*），其它合约由白名单合约互调 |

**权限矩阵（谁有资格调写函数）**

| 角色 | 来源 | 覆盖合约 |
|---|---|---|
| owner | 各合约 Ownable（ZYTConfig 内还校验 mining/deflation） | 部署者，上线移交 Gnosis Safe |
| config.owner() | ZYTMining 内 require(msg.sender == config.owner()) | ZYTMining.setDeflation/setDailyReleaseAmount |
| mining | ZYTPoolManager.setMining 注册 | Pool.recordBuy/settleSell/payoutDividend、ZYTReferral.bind |
| deflation | ZYTMining.setDeflation 注册 | Pool.updateSnapshot/dailyBurn、Mining.dailyRelease |
| pool | ZYTToken.setPool 注册 | ZYTToken.mintTo（onlyMinter 分支） |
| forceSell | ZYTToken.setForceSell 注册 | ZYTToken.burnFrom |
| keeperAddress | ZYTConfig.setAddress("keeperAddress") | ZYTDeflation.dailySnapshot |
| token | ZYTForceSell 构造 | ForceSell.onMint/checkAndBurn |
| minter | ZYTToken.setMinter 注册 | ZYTToken.mintTo/recordSellUsdt/burnFrom |

---

## 1. ZYTConfig

全局参数与接线中心。owner 部署后应移交多签；所有数值/地址参数可调，无 UUPS。

### 1.1 公开状态变量（自动 getter）

| 字段 | 默认 | 语义 |
|---|---|---|
| gstMaxSupply | 333_000_000e18 | GST 总供应（锁池核对用） |
| zytMaxSupply | 2_100_000_000e18 | 初始底池 ZYT 21 亿 |
| totalSupplyCap | 100_000_000_000e18 | ZYT mint 保险丝硬顶（防无限增发）；口径=初始 21 亿进池、铸造硬顶 1000 亿，宣传勿写死"总量 21 亿" |
| minDeposit / maxDeposit | 100e18 / 500e18 | 单笔入金区间（U） |
| marketingRate / poolRate | 4000 / 6000 | 入金 40% 营销 / 60% 注池 |
| powerRate | 10000 | 算力倍率 1.0 |
| dailyCompoundRate | 100 | 算力日复利 1% |
| dynamicQuotaMul | 5 | 动态收益额度（领取上限，非保证收益）= 累计入金 × 5 |
| staticExitMul | 2 | 静态 2 倍出局 |
| deflationRate / deflationFloor | 200 / 5_000_000e18 | 日通缩 2% / 通缩至 500 万枚停 |
| baseSlippage / slippageTier1-4 | 500 / 1000 / 2000 / 4000 / 8000 | 滑点档位 5% / 10% / 20% / 40% / 80% |
| transferSlippage | 1000 | 转账滑点 10% |
| poolStage1USDT / poolStage2USDT | 10M / 20M | 阶段阈值（决策 A 主网部署将 stage1 设 0，初始即 stage2） |
| snapshotTime | 28800 | 快照时刻（北京 08:00 的秒值） |
| refLevel1Rate / refLevel2Rate / refLevel3Rate / refTechnicalRate | 700 / 200 / 50 / 1000 | 推荐 1 代 7% / 2-10 代 2% / 11-20 代 0.5% / 技术 10% |
| refDepth | 20 | 推荐最大深度 |
| buyWhitelistEnabled | true | 买入白名单总开关（防闪电贷） |
| marketAddress / technicalAddress | 0 | 营销多签 / 技术多签（deploy.js 环境变量注入） |
| blackHole / router / usdt / gst / zyt / pool / mining / deflation / forceSell / referral | 0 | 接线地址 |
| keeperAddress | 0 | keeper 签名钱包（仅触发快照） |
| paused | false | 全局暂停（mining 层读取） |

### 1.2 写函数

| 函数 | 权限 | 语义 |
|---|---|---|
| pause() / unpause() | owner | 紧急暂停/恢复（Mining 所有写操作 whenNotPaused） |
| setUint(string key, uint256 value) | owner | 数值参数批量改；费率类强制 ≤10000；未知 key revert |
| setAddress(string key, address value) | owner | 地址参数批量改（含 keeperAddress/接线） |
| setBuyWhitelistEnabled(bool) | owner | 买入白名单总开关 |

事件：`ParamSet(key,value)`、`AddressSet(key,value)`、`ParamBoolSet(key,value)`、`Paused(account)`、`Unpaused(account)`。

---

## 2. GSTToken（古水币，计价/滑点承受层）

总量 3.33 亿铸造给部署者，2.1 万枚进池，其余 lockRemaining 永久锁黑洞。对用户不可见。

| 函数 | 权限 | 语义 |
|---|---|---|
| setTransferAllowed(addr, bool) | owner | 锁定后豁免地址（前瞻 DEX 接入；默认空） |
| lockRemaining() | owner | 把 owner 持有 GST 全量转黑洞，置 supplyLocked=true，一次性不可逆 |
| transfer / transferFrom | 任意（覆盖） | supplyLocked 后仅允许 to=黑洞/0/豁免地址，防锁定供应泄漏 |

状态：`blackHole`、`supplyLocked(bool)`、`transferAllowed(address=>bool)`。
事件：`SupplyLocked(blackHole, amount)`、`TransferAllowedSet(addr, allowed)`。

---

## 3. ZYTToken（众赢币主代币）

21 亿进池起，mint 仅限 mining/pool 且受 totalSupplyCap；转账触发强制卖出 + 10% 转账税 + 卖出统计（V6/V7）。

### 3.1 写函数

| 函数 | 权限 | 语义 |
|---|---|---|
| setMinter / setPool / setForceSell / setConfig / setWhiteList | owner | 接线 + 白名单（池/合约跳 hook） |
| mintTo(to, amount) | minter 或 pool | 铸造；totalSupply+amount ≤ totalSupplyCap 否则 revert "supply cap" |
| burnFrom(from, amount) | minter / pool / forceSell | 销毁（滑点 40%、强制卖出、通缩） |
| recordSellUsdt(seller, usdtOut) | 仅 minter | 卖出 USDT 折合入统计（ZYT 量由 _update 计） |

### 3.2 读函数

`getUserCount()` 用户数；`getUserAt(i)` 第 i 用户；`getSellInfo(user)` 返回 `(sellCount, totalSellZyt, totalSellUsdt, firstReceiveAt, lastSellAt, windowFlags)`。

### 3.3 内部 hook `_update(from,to,amount)`（转账行为入口，理解卖税的关键）

| 分支 | 行为 |
|---|---|
| 铸币 to 非白名单 | ForceSell.onMint 启窗 + 记 firstReceiveAt + 入 userList |
| from 非白名单（卖出/转账） | ForceSell.checkAndBurn 检查销毁；10% 转账税（双方非白名单）；卖出统计 +1 次 |
| from 白名单 to 非白名单 | 接收方 onMint 启窗入列（分红渠道与 mint 一致，决策 19） |

状态：`sellInfo(user)`（UserSellInfo 六字段）、`userList[]`、`userIndex`、`isWhiteList`。
事件：`MinterChanged/PoolChanged/ForceSellChanged/WhiteListSet/SellStatUpdated(user,zytAmount,usdtOut)`。

---

## 4. ZYTPoolManager（底池 + 快照 + 滑点 + 分红池）

记账模型底池（不依赖 DEX），价格 U per ZYT。滑点基准 = GST 池相对当日快照减少比例。

### 4.1 写函数

| 函数 | 权限 | 语义 |
|---|---|---|
| initialize(gstAmount, zytAmount) | owner，一次 | 从 owner 转 gstAmount GST + 等额 USDT（V5 真转入），mint zytAmount ZYT 到池；设 snapshotPrice = USDT*1e18/ZYT |
| setMining / setDeflation | owner | 接线 |
| setBuyWhitelist(addr,bool) / setBuyWhitelistBatch(addrs[],bool) | owner | 买入白名单增删（多签） |
| updateSnapshot() | deflation | 锁 snapshotPoolGST + snapshotPrice + lastSnapshotAt |
| recordBuy(usdtIn) | mining | 入金注池：poolUSDT/poolGST += usdtIn（GST 1U 折算） |
| settleSell(seller, zytGross) | mining | 收 ZYT → 扣档位滑点 → 分配 30%MARKET/30%dividendPool/40%销毁 → 净额按快照价转 USDT |
| dailyBurn() | deflation | poolZYT 扣 2%：1% 销毁 + 1% 入 dividendPool；返回 (burned, dividend) |
| payoutDividend(user, amount) | mining | 从 dividendPool 转 ZYT 给用户（分红领取） |

### 4.2 读函数

`getPrice()` 实时价；`getTradePrice()` 当日快照锁定价（未快照回退实时）；`getStage()` 1 只卖不买 / 2 LP 额度 / 3 自由；`getCurrentSlippage()` 档位（基点）。

状态：`poolGST/poolZYT/poolUSDT/snapshotPoolGST/snapshotPrice/lastSnapshotAt/dividendPool/initialized/buyWhitelist`。
事件：`PoolInitialized/SnapshotUpdated/SlippageCollected(rate,toMarket,toDividend,toBurn)/BuyRecorded/SellSettled/DividendAccrued/PoolBurned/BuyWhitelistSet`。

---

## 5. ZYTMining（用户主入口）

无 Ownable，owner 校验走 `config.owner()`。所有用户写操作 `whenNotPaused`。

| 函数 | 权限 | 语义 |
|---|---|---|
| deposit(usdtAmount, ref) | 任意（白名单+限额） | 收 USDT → 40% 营销 / 60% 注池并 mint ZYT（按快照价）→ 算力 base + 复利日重置 → quota = depositTotal×5 → 绑定推荐 + 分账 |
| sellZyt(zytGross) | 任意 | Pool.settleSell 卖出 → recordSellUsdt → withdrawTotal 累计 → 达 2 倍出局置 powerBase=0 |
| claimReward(day) | 任意 | 领 day 日产出（releaseAmount × 个人算力/全网）；约束 day≥powerDay、额度未耗尽、未领取、未出局；mint 成功后置标记 |
| claimDividend() | 任意 | 领分红池按最新算力加权；每天最多一次（lastDividendDay）；额度耗尽停发；事件中 day 恒为 0（与 claimReward 区分） |
| dailyRelease(day, totalPower) | deflation | 记录当日全网算力 + 释放量 |
| addLiquidity(usdtAmount) | 任意，仅 stage2 | LP 转池，获 1:1 买币额度 |
| setDeflation / setDailyReleaseAmount | config.owner() | 接线 / 日释放量（默认 10 万 ZYT/日） |

读：`powerOf(user)` 当前复利算力；`userInfo(user)` 返回 `(depositTotal, withdrawTotal, dynamicQuota, dynamicWithdrawn, power, lpQuota, isExited)`；`users(user)` 原始结构（含 powerDay/pendingDividend）。

状态：`dailyInfo(day)`、`dividendClaimed(day)`、`lastDividendDay(user)`、`dailyReleaseAmount`。
事件：`Deposited(user,usdt,zytMinted,power,quota,ref)`、`RefReward(receiver,reward,level,usdt)`、`Sold(user,zytIn,usdtOut,rate)`、`Claimed(user,reward,day,usdt)`、`DailyReleased(day,totalPower,releaseAmount)`、`DailyReleaseAmountSet`、`LiquidityAdded`、`StaticExited`。

**额度口径（修复后统一）**：claimReward 与 claimDividend 的额度消耗均按 `reward/share × getTradePrice()/1e18` 折 USDT 计；推荐奖励按 USDT 计价入账。禁止再把 ZYT 数直接累加 dynamicWithdrawn（历史 bug V2）。

---

## 6. ZYTDeflation（每日快照/通缩触发）

| 函数 | 权限 | 语义 |
|---|---|---|
| dailySnapshot(totalPower) | keeperAddress 或 owner | 依次：updateSnapshot → poolZYT>floor 则 dailyBurn（否则 DeflationFloorHit）→ mining.dailyRelease(day, totalPower)。一天仅一次（lastSnapshotDay） |

状态：`lastSnapshotDay`、`snapshotCount`。
事件：`DailySnapshot(day, burned, dividend, released, snapshotGST)`、`DeflationFloorHit(day)`。

注意：totalPower 由 keeper 链下统计传入（防链上遍历 gas 爆炸），任何人不可伪造，调用者被限制为 keeper/owner。

---

## 7. ZYTReferral（推荐关系记账）

| 函数 | 权限 | 语义 |
|---|---|---|
| setMining | owner | 接线 |
| bind(user, ref) | mining | 绑定直推；用户≠ref、未绑定、ref 祖先链 20 代内不含 user（防循环 V3）才生效 |
| getAncestors(user, depth) | view | 上级链数组（直推起，空位 0 地址） |
| getDepth(user) | view | 链深（上限 20） |

状态：`referrerOf`、`downlineCount`。事件：`Bound(user, ref)`。
奖励 mint 不在本合约，见 ZYTMining._distributeRef（内部私有）。

---

## 8. ZYTForceSell（60 天 4 窗口强制卖出）

规则：首收日起 0-15/15-30/30-45/45-60 天，累计卖出须达持币 20%/30%/40%/60%，差额销毁。转账视同卖出。

| 函数 | 权限 | 语义 |
|---|---|---|
| setKeeper | owner | V8 到期结算触发方 |
| onMint(to, amount) | 仅 token | 铸币接收方启窗（首次置 firstReceiveTime） |
| checkAndBurn(from, to, amount) | 仅 token | 转账 hook：启窗（两侧未初始化）+ soldAmount[from]+=amount + 到期差额销毁（返回 burned 由 token 执行） |
| settleExpired(user) | keeper 或 owner | 到期补结差额销毁（burnFrom，上限持币余额） |

状态：`WINDOW=15d / TOTAL_WINDOWS=4 / WINDOW1-4_TARGET=2000/1000/1000/1000`、`firstReceiveTime`、`soldAmount`（V9 销毁不扣减）、`initialized`。
事件：`FirstReceive(user,time)`、`ForceSellBurned(user,amount,window)`。

---

## 9. ZYTCompute（纯计算库，无状态，链入 ZYTMining）

| 函数 | 语义 |
|---|---|
| powerWithCompound(base, rateBps, days) | 算力复利，上限 365 天封顶 |
| isStaticExited(withdrawTotal, depositTotal, exitMul) | 静态出局：withdraw ≥ deposit×mul |
| isQuotaExhausted(dynamicWithdrawn, dynamicQuota) | 动态额度耗尽判断 |
| quotaFor(depositTotal, mul) | 动态额度 = depositTotal × mul |

常量：`MAX_COMPOUND_DAYS = 365`。

---

## 10. 接口与 Mock

- `interfaces/IZYTForceSell.sol`：`onMint / checkAndBurn`，ZYTToken 依赖最小接口
- `interfaces/IZYTTokenLike.sol`：`mintTo / burnFrom`，Pool/Deflation 视角
- `mocks/MockERC20.sol`：标准 ERC20 + `faucet(uint256)` 公开领币，仅测试网

---

## 11. 主调用链速查

| 业务 | 链路 |
|---|---|
| 入金 | 用户 → Mining.deposit → Pool.recordBuy + ZYT.mintTo(用户) + Config.marketAddress 收 40% + Referral.bind + _distributeRef mint 各代 |
| 卖 ZYT | 用户 → Mining.sellZyt → Pool.settleSell（ZYT._update hook 走 ForceSell.checkAndBurn + 10% 转账税 + 统计）→ ZYT.recordSellUsdt |
| 领日产出 | 用户 → Mining.claimReward(day) → ZYT.mintTo（额度按快照价折算） |
| 领分红 | 用户 → Mining.claimDividend → Pool.payoutDividend（额度折算，日限一次） |
| 每日快照 | keeper/owner → Deflation.dailySnapshot(totalPower) → Pool.updateSnapshot + Pool.dailyBurn + Mining.dailyRelease |
| 到期强卖 | keeper → ForceSell.settleExpired(user) → ZYT.burnFrom |

---

> 修订记录：v1.0 2026-09-03 基于源码全文编制；技术方案 §1.2/§3.3 旧接口名已同步校正。
