# 众赢币（ZYT）合约接口参考（v9）

> 版本：v2.0（2026-09-24）｜ 依据：contracts/*.sol 源码（v9 落地代码），非设计稿
> v9 范式：弃 GST，USDT↔ZYT 单币直换。真实 PancakeSwap V2 pair 为唯一底池，
> ZYTPoolManager 是唯一交易通道（gate 模式），LP 双轨处置（初始锁仓抽通缩 + 增量凭证黑洞）。
> v7/v8 历史接口见《技术方案》冻结正文与 git 历史。

## 0. 全局约定与部署接线

| 项 | 约定 |
|---|---|
| 精度 | 全部金额/数量 1e18；滑点与费率用基点（bps，1%=100，满额 10000） |
| 时间 | 全部 Unix 秒；`day = block.timestamp / 86400`（UTC）；快照 08:01 北京（cron `1 0 * * *` UTC） |
| 权限角色 | owner（可迁移多签）/ mining / pool / deflation / forceSell / keeperAddress / minter(=Creator) / ledger(=Mining) |
| 事件签名变更 | 必须三处同步：合约 emit、dapp/src/abis/*.ts、keeper/src/abis.js + ledger.js |
| 主入口 | 用户写操作全走 ZYTMining（deposit/buy/sellZyt/claimDividend） |

**部署脚本 `scripts/deploy.js` 自动完成全部部署与接线**：

| # | 合约 | 构造参数 |
|---|---|---|
| 1 | ZYTConfig | — |
| 2 | ZYTToken | blackHole |
| 3 | ZYTLiquidityCreator | zyt, usdt, factory, blackHole |
| 4 | ZYTPoolManager | config, zyt, usdt |
| 5 | ZYTReferral | — |
| 6 | ZYTForceSell | zyt |
| 7 | ZYTCompute(lib) + ZYTMining | config, pool, referral, zyt, usdt |
| 8 | ZYTDeflation | config, pool, mining |

**接线全集**（漏任一项即功能断裂）：

```
config.setAddress: usdt / blackHole / factory / zyt / pool / mining / deflation
                   / forceSell / referral / creator / keeperAddress / marketAddress / technicalAddress / pair(建池后)
zyt:   setMinter(creator) / setLedger(mining) / setPool(pool) / setForceSell
       / setCreator(creator) / setConfig(config)
zyt.setWhiteList: creator / pool / mining / deflation / market / technical / pair（系统豁免）
pool:  setLocker(creator) / setMining(mining) / setDeflation(deflation) / setPair(pair)
referral.setMining(mining)
creator.setPoolManager(pool)
mining.setDeflation(deflation)
forceSell.setKeeper(keeperAddress)
creator.createInitialPool(21亿 ZYT, 2.1万 USDT)   # 建池 + LP 锁仓，一次性
```

**Factory 地址**：mainnet `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73`；
testnet `0xB7926C0430AFb07aa7deFde6Da862AE0bDe3678b`；本地 hardhat 自动部署 MiniFactory。
v9 全程不经 Router，Router 地址不再需要。

---

## 1. ZYTToken

### 权限地址
| 字段 | 语义 |
|---|---|
| minter | ZYTLiquidityCreator（唯一 mint 方：建池铸 21 亿一次，受 totalSupplyCap=21亿 保险丝） |
| ledger | ZYTMining（P1-7 双向记账回调对象；recordSellUsdt 也归它） |
| pool | ZYTPoolManager（分红载体 / burn 权限） |
| forceSell | ZYTForceSell（burn 权限 + hook） |
| creator | 锁仓合约（= Creator，卖闸放行方之一） |
| pairAddress | gate 判定用交易对 |
| isWhiteList | 系统豁免：跳过转账税/记账/强卖 hook |

### 真池双闸（防绕过核心）
- **卖闸**：ZYT 流入 pair（to == pair）时 `require msg.sender == pool || creator`。
  用户直接转币给 pair 卖出、Router 拉币卖出（msg.sender=Router）一律 revert。
- **买闸**：ZYT 流出 pair（from == pair）时 `require IPoolGate(pool).swapGate()`。
  gate 由 PoolManager 在 swap 前置位/后清位；用户直接在 Pancake 前端买入被拦。

### 转账税（双方均非白名单的普通转账）
转账视同卖出：总额 = amount，另扣 10% 税（从发送方扣）：
- 40% 直接销毁（`_burn(from)`）
- 30% 转营销地址（config.marketAddress）
- 30% 转 pool 并调 `accrueDividendZyt()` 入分红池

记账口径：
- 转出：`IZYTMiningLedger.recordTransferOut(from, amount + tax)`（按快照价折算 USDT 计入提取额，P1-7 防静态 2 倍绕过）
- 转入：`recordTransferIn(to, amount)`（计入受赠额，等额抬高提取上限）
- 强卖 hook：`checkAndBurn(from, to, amount)`（P1-9：基数 = 转账前余额）
- 接收方：`_onReceive(to)`（首收币时间 + 强卖窗口启动 + userList 入列）

### 视图与写函数
```solidity
function mintTo(address to, uint256 amount) external    // onlyMinter（仅 Creator）
function burnFrom(address from, uint256 amount) external // pool 或 forceSell
function recordSellUsdt(address seller, uint256 usdtOut) external // only ledger（Mining）
function getUserCount() view returns (uint256)          // userList 遍历（对账/审核）
function getUserAt(uint256 i) view returns (address)
function getSellInfo(address) view returns
  (uint256 sellCount, uint256 totalSellZyt, uint256 totalSellUsdt,
   uint256 firstReceiveAt, uint256 lastSellAt, uint256 windowFlags)
```

### 事件
`MinterChanged / LedgerChanged / PoolChanged / ForceSellChanged / CreatorChanged / PairChanged / WhiteListSet / SellStatUpdated`

---

## 2. ZYTPoolManager（唯一 swap 通道）

### 视图
```solidity
function poolZYT() view returns (uint256)          // pair ZYT 储备
function poolUSDT() view returns (uint256)         // pair USDT 储备（阶段度量口径）
function getReservesPublic() view returns (uint256 zytReserve, uint256 usdtReserve)
function getPrice() view returns (uint256)          // 实时价 U per ZYT（1e18）
function getTradePrice() view returns (uint256)     // 08:01 快照锁定价（记账：转账计值/强卖/额度）
function getStage() view returns (uint256)          // 1 只卖 / 2 买额 1:1 / 3 自由
function getCurrentSlippage() view returns (uint256) // 基点：池U较峰值回落 1/2/3/4% → 1000/2000/4000/8000，默认 500
function peakPoolUSDT() view returns (uint256)      // 滑点基准 = max(初始2.1万U, 历史峰值)
function snapshotPrice() view returns (uint256)
function snapshotPoolUSDT() view returns (uint256)
function dividendPoolZyt() view returns (uint256)   // 分红池（通缩1% + 滑点30% + 转账税30%）
function totalLpBurned() view returns (uint256)     // 累计销毁 LP（入金 60% 凭证）
function swapGate() view returns (bool)             // 交易闸门（ZYTToken 买闸读）
```

### 写函数（均 onlyMining 或 onlyDeflation）
```solidity
// 入金 60% 处置：一半 USDT 真实换 ZYT + 另一半按最优比例组 LP → LP 转黑洞销毁
function injectLiquidity(uint256 usdtIn) external onlyMining returns (uint256 lpBurned)

// 买入：USDT→pair swap→ZYT 直达用户；stage1 禁买；USDT 须已由 Mining 转入
function buyFor(address user, uint256 usdtIn) external onlyMining returns (uint256 zytOut)

// 卖出：滑点档位 30/30/40 分配 → 净额真实 swap → USDT 给用户；ZYT 由本合约 transferFrom 用户
function sellFor(address user, uint256 zytGross) external onlyMining returns (uint256 usdtOut)

// 转账税 30% 分红入池（only ZYTToken）
function accrueDividendZyt(uint256 amount) external

// 每日 08:01（onlyDeflation）：快照锁定价 + 峰值刷新
function updateSnapshot() external

// 每日通缩（onlyDeflation）：锁仓 LP 报销 2% → ZYT_a 1%烧+1%分红；U_b 回池 sync
function deflate() external returns (uint256 burned, uint256 dividend)

// 分红发放（onlyMining，claimDividend 调用）
function payoutDividend(address user, uint256 amount) external
```

### 事件
`LiquidityInjected(user, usdtIn, lpBurned)` · `Bought(user, usdtIn, zytOut)` ·
`Sold(seller, zytGross, slip, usdtOut)` · `SnapshotUpdated(price, poolUSDT, time)` ·
`Deflated(burned, dividend, usdtResynced)` · `SlippageCollected(rate, toMarket, toDividend, toBurn)` · `DividendAccrued(amount)`

---

## 3. ZYTMining（入金/买入/卖出主入口）

### 写函数
```solidity
// 入金（100-500U 可调）：40% USDT 直发（30% 代数逐笔消耗推荐人动态额度 + 10% 技术）
//   60% → pool.injectLiquidity；入金者获算力（日复利1%）+ 买额（1:1）+ 动态额度（×5）
function deposit(uint256 usdtAmount, address ref) external

// 买入（真池）：stage1 禁买；stage2 消耗买额；stage3 自由
function buy(uint256 usdtIn) external returns (uint256 zytOut)

// 卖出（真池）：卖出实收 USDT 计入累计提取 → 静态出局判定
function sellZyt(uint256 zytGross) external

// 分红提取（三阶段均可；ZYT 从 Pool 分红池转出）
function claimDividend() external returns (uint256 amount)

// P1-7 记账回调（only zytToken）
function recordTransferOut(address user, uint256 zytAmount) external
function recordTransferIn(address user, uint256 zytAmount) external

// Deflation 调用
function dailyRelease(uint256 day, uint256 totalPower) external
function recordDailyDividend(uint256 day, uint256 amount) external
```

### 视图（8 元组）
```solidity
function userInfo(address user) view returns
  (uint256 depositTotal, uint256 withdrawTotal, uint256 power,
   uint256 dynamicQuota, uint256 dynamicWithdrawn, uint256 buyQuotaLeft,
   bool staticExited, bool dynamicExited)
function transferValueOf(address) view returns (uint256 receivedValue, uint256 withdrawCap)
  // withdrawCap = 入金 × 2 + 受赠值
function dividendOf(address) view returns (uint256 pending, uint256 settledDay)
function powerOf(address) view returns (uint256)
```

### 出局（加速释放，v9 拍板口径）
- **静态 2 倍**：累计提取（卖出实收 + 转出按快照价计值）≥ 入金×2 + 受赠 → `StaticExited`。
  exitDay 起算力归零（历史算力保留供分红回算）；复投解除。
- **动态 5 倍**：动态额度（入金×5）被推荐奖励逐笔耗尽 → `DynamicExited`，停发推荐奖励
  （份额转营销账户）；复投注入新额度解除。

### 事件
`Deposited(user, usdt, power, quota, ref)` · `Bought(user, usdtIn, zytOut)` ·
`Sold(user, zytIn, usdtOut, rate)` · `StaticExited(user)` · `DynamicExited(user)` ·
`DailyReleased(day, totalPower)` · `DividendSettled(user, amount, fromDay, toDay)` ·
`Claimed(user, amount)` · `TransferLedger(user, zytAmount, usdtValue, isOut)` · `RefPaid(receiver, usdtAmount, level)`

---

## 4. ZYTDeflation

```solidity
// 每日 08:01 北京（keeper cron "1 0 * * *" UTC）；仅 keeperAddress 或 owner
function dailySnapshot(uint256 totalPower) external
//   1. pool.updateSnapshot()（快照锁定价 + 峰值刷新）
//   2. pool.deflate()（池 ZYT > 500万 时：LP 报销 2% → 1%烧 + 1%分红；U 回池 sync）
//   3. mining.dailyRelease + recordDailyDividend

function lastSnapshotDay() view returns (uint256)
function snapshotCount() view returns (uint256)
```
事件：`DailySnapshot(day, burned, dividend, snapshotPrice, snapshotPoolUSDT)` · `DeflationFloorHit(day)`

---

## 5. ZYTLiquidityCreator（初始建池 + LP 锁仓）

```solidity
// 部署后手动调用一次：铸 21 亿 ZYT + 收 2.1 万 USDT → 建/取 pair → 两侧注入 → LP 锁仓
function createInitialPool(uint256 zytAmount, uint256 usdtAmount) external onlyOwner returns (address pair)
//   deployer 需先 usdt.approve(creator, 2.1万e18)；此后总供应恒减（无任何 mint 路径）

// 每日通缩报销（only poolManager；Pool 在 swapGate 期间调用）
//   报销 rateBps(=200) 基点锁仓 LP → removeLiquidity → ZYT/USDT 转交 Pool
function skimDeflation(uint256 rateBps) external returns (uint256 zytAmt, uint256 usdtAmt)

function lockedLiquidity() view returns (uint256)      // 当前锁仓 LP（前端/Ave 展示）
function totalZytSeeded() view returns (uint256)       // 21 亿
function totalUsdtSeeded() view returns (uint256)      // 2.1 万
function totalDeflationZytOut() view returns (uint256) // 通缩累计抽出的 ZYT
function totalDeflationUsdtOut() view returns (uint256)
function pair() view returns (address)
```
安全设计：LP 唯一出口 = skimDeflation（仅 Pool 可调，2%/日递减，约 299 天自然耗尽对应池剩 500 万枚）；
无全额撤出函数、无 LP 转移函数，锁仓不可逆。

事件：`InitialPoolCreated(pair, zytIn, usdtIn, liquidity)` · `DeflationSkimmed(lpBurned, zytAmt, usdtAmt)`

---

## 6. ZYTReferral（零改动沿用）

```solidity
function bind(address user, address ref) external onlyMining   // 防循环绑定
function referrerOf(address) view returns (address)
function downlineCount(address) view returns (uint256)         // 直推人数 = 可拿代数
function getAncestors(address user, uint256 depth) view returns (address[] memory)
```

## 7. ZYTForceSell（零改动沿用）

```solidity
// 4×15 天窗口，累计应卖 20%/30%/40%/50%（基点 2000/3000/4000/5000），未卖 keeper 销毁差额
function checkAndBurn(address from, address to, uint256 amount) external returns (uint256 burned)
function onMint(address to, uint256 amount) external
function settleExpired(address user) external returns (uint256 burned)  // keeper/owner；窗口位图去重
function firstReceiveTime(address) view returns (uint256)
function soldAmount(address) view returns (uint256)
```
豁免白名单（ZYTToken.isWhiteList）：pair、pool、creator、mining、deflation、黑洞、营销/技术 Safe。

## 8. ZYTConfig（参数中心）

数值参数（`setUint(key, value)`，多签）：`zytMaxSupply=21亿` · `minDeposit=100U` · `maxDeposit=500U` ·
`marketingRate=4000` · `poolRate=6000` · `powerRate=10000` · `dailyCompoundRate=100` ·
`dynamicQuotaMul=5` · `staticExitMul=2` · `deflationRate=200` · `deflationFloor=500万枚` ·
`baseSlippage=500` · `slippageTier1..4=1000/2000/4000/8000` · `transferSlippage=1000` ·
`poolStage1USDT=1000万` · `poolStage2USDT=2000万` · `snapshotTime=28860`（08:01） ·
`refLevel1Rate=700` · `refLevel2Rate=200` · `refLevel3Rate=50` · `refTechnicalRate=1000` ·
`refDepth=20` · `swapFeeBps=25` · `deflationLpRate=200` · `buyQuotaRate=10000` · `totalSupplyCap=21亿`

地址参数（`setAddress(key, addr)`）：见 §0 接线全集。

---

## 9. keeper 集成（zyt-keeper v9）

- `abis.js`：事件集 MINING(10)/POOL(7)/DEFLATION(2)/CREATOR(3)；POOL_VIEW_ABI 真池口径；
  MINING_USERINFO_ABI 8 元组三处共用。
- `keeper.js`：cron `1 0 * * *` UTC（北京 08:01）签名调 `dailySnapshot(totalPower)`。
- `ledger.js`：Deposited 记动态额度(×5)、RefPaid 记额度消耗、Sold 计提取、TransferLedger 双向；
  reconcile 对账 4 字段（deposit/withdraw/dynamicQuota/dynamicWithdrawn）+ transferValueOf 受赠值。
- `forcesell.js`：窗口目标 20/30/40/**50**%；settleExpired 定期结算。
- `api.js`：/stats（pool_state 遗留列映射：snapshot_gst=峰值、day_sold_gst=分红池）、
  /user /power /records /force-sell /reconcile。

## 10. 前端集成（zyt-dapp v9）

- 买入：`usdt.approve(mining, amt)` → `mining.buy(amt)`（返回 zytOut）
- 卖出：`zyt.approve(pool, amt)` → `mining.sellZyt(amt)`（返回 usdtOut）
- 入金：`usdt.approve(mining, amt)` → `mining.deposit(amt, ref)`
- 分红：`mining.dividendOf(addr)` → `mining.claimDividend()`
- 仪表盘：`pool.poolUSDT/poolZYT/peakPoolUSDT/getCurrentSlippage/getStage/dividendPoolZyt/totalLpBurned`
  + `creator.lockedLiquidity`（LP 锁仓展示）
