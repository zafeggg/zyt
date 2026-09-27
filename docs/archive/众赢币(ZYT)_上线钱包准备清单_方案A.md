# 众赢币（ZYT）上线钱包准备清单（方案 A：多签全分离）

> 版本：v1.0（2026-09-02）｜ 状态：待执行  
> 方案 A = 治理多签 / 营销收款多签 / 技术收款多签 各自独立（分账透明、制衡清晰）  
> 关联：众赢币(ZYT)\_技术方案.md §7.3 决策 3 / §8 上线清单 / 上线操作手册 1.3-1.4 / 上线流程清单 / docs/DEPLOYMENT_ONLINE.md  
> 链：BSC mainnet（chainId 56，RPC <https://bsc-dataseed.binance.org）>

---

## 1. 钱包结构总览

| 编号 | 角色          | 类型          | 是否多签       | 关键用途                              |
| -- | ----------- | ----------- | ---------- | --------------------------------- |
| W1 | 部署钱包        | EOA         | 否          | 部署 9 合约、注池，owner 移交后退役冷备          |
| W2 | 治理多签        | Gnosis Safe | 是（营销+技术共管） | 合约 owner，参数/暂停/白名单唯一管理方           |
| W3 | 营销收款多签      | Gnosis Safe | 是          | `marketAddress`，收 40% 入金 + 30% 滑点 |
| W4 | 技术收款多签      | Gnosis Safe | 是          | `technicalAddress`，收推荐 10%        |
| W5 | keeper 签名钱包 | EOA         | 否          | `keeperAddress`，仅触发每日快照（无资金权限）    |
| W6 | UAT/冒烟钱包    | EOA         | 否          | T-0 真实链路验证（授权/入金/领取/卖出/转账）        |
| W7 | 签名者 EOA 组   | EOA ×N      | 否          | W2/W3/W4 的 Safe owner 成员，个人保管     |

**分配关系**（建议，可调，见 §4）：

- W2 治理 Safe owner 集合 = 营销 2 人 + 技术 1 人（阈值 2/3）
- W3 营销收款 Safe owner 集合 = 营销 2 人 + 技术 1 人（阈值 2/3，技术监督防单人挪用）
- W4 技术收款 Safe owner 集合 = 技术 2 人（阈值 2/2，可加营销 1 人做监督）

---

## 2. 逐钱包准备卡

### W1 部署钱包（Deployer）

- [ ] 生成方式：硬件钱包（Ledger/Trezor/OneKey）或隔离设备新建助记词；**单独生成，不与任何其他钱包共助记词**
- [ ] 资金来源与额度（主网真实资金）：
  - 2.1 万 USDT（BSC 官方 0x55d398326f99059fF775485246999027B3197955，用于底池注入，非 mock）
  - BNB 约 0.3-0.5（覆盖 9 合约部署 gas）
- [ ] 部署前自检：钱包已切 BSC 主网；`USDT.balanceOf(deployer) >= 21000`；已有部分 BNB 作首笔 gas
- [ ] 使用点：`.env` 填 `PRIVATE_KEY`（zyt-contracts/.env，禁止入库，已 .gitignore）
- [ ] 保管人（2 人分开保管私钥副本，双 U 盘离线冷备）：
  - 保管人 1：\__________ ｜ 位置：\__________
  - 保管人 2：\__________ ｜ 位置：\__________
- [ ] 退役条件：owner 移交 W2 成功后，私钥转冷备不再联网使用；账上如有尾款转出至 W2

### W2 治理多签（合约 owner）

- [ ] 创建：app.safe.global（BSC 网络）新建 Safe，owner 集合与阈值按 §4 建议
- [ ] 主网部署后验证 owner() == W2 地址（见 §8 命令）
- [ ] 资金：预留 BNB 约 0.05（提案执行 gas）
- [ ] 移交前置：**testnet 全流程演练一次** transferOwnership 提案-签名-执行（操作手册 1.3.4）
- [ ] 移交执行：deployer 调 `ZYTConfig.transferOwnership(W2)`（多签转移前由 deployer 单签执行，属计划内动作）
- [ ] 移交后验证：`config.owner() == W2`；deployer 已无管理权限
- [ ] 保管：Safe 签名私钥全部由 W7 成员持有，团队无统一备份出口（多签意义所在）
- [ ] 负责人：\__________

### W3 营销收款多签（marketAddress）

- [ ] 创建：app.safe.global（BSC）新建 Safe，owner 集合与阈值按 §4 建议
- [ ] 使用点：`.env` 填 `MARKET_ADDRESS=W3地址`（zyt-contracts/.env，主网部署用）
- [ ] 上线前验证：部署后 `config.marketAddress() == W3`（见 §8 命令）
- [ ] 资金：预留 BNB 约 0.02（后续提款 gas）
- [ ] 入账核对：上线后首笔入金 40% 分成到账后，bscscan 核对 W3 USDT 余额与模型一致
- [ ] 负责人：\__________

### W4 技术收款多签（technicalAddress）

- [ ] 创建：app.safe.global（BSC）新建 Safe，owner 集合与阈值按 §4 建议
- [ ] 使用点：`.env` 填 `TECHNICAL_ADDRESS=W4地址`（zyt-contracts/.env，主网部署用）
- [ ] 上线前验证：部署后 `config.technicalAddress() == W4`（见 §8 命令）
- [ ] 资金：预留 BNB 约 0.02（后续提款 gas）
- [ ] 入账核对：推荐 10% 分成到账后核对
- [ ] 负责人：\__________

### W5 keeper 签名钱包（keeperAddress）

- [ ] 生成方式：独立新建 EOA；**明令禁止沿用 testnet/本地私钥**（DEPLOYMENT_ONLINE 强调）
- [ ] 使用点：keeper `.env` 填 `KEEPER_PRIVATE_KEY`，权限 `chmod 600`；仅存运行环境
- [ ] 资金：BNB 约 0.02（每日一次快照 gas，极小额）
- [ ] 链上注册：部署脚本以 `KEEPER_ADDRESS=W5` 写入 `config.keeperAddress`（deploy.js 已支持）
- [ ] 验证：`config.keeperAddress() == W5` 且与 W1-W4、W6 均不同地址（§8 命令）
- [ ] 安全边界：该地址不持有项目资金、合约无任何资金操作授权；泄露仅损失 gas
- [ ] 保管人：\_________\_（私钥仅运行服务器 1 份 + 冷备 1 份）

### W6 UAT/冒烟钱包

- [ ] 生成方式：普通 EOA（可软件钱包），非白名单也可（只卖阶段/卖出链路测试）
- [ ] 资金：小额 USDT 约 100-500 + BNB 约 0.01-0.05，走真实入金链路后回收
- [ ] 使用点：T-0 阶段 3.1 冒烟（操作手册）；首笔真实业务数据来源
- [ ] 保管人：\_________\_（测试期由执行人保管）

### W7 签名者 EOA 组（W2/W3/W4 的 Safe owner 成员）

| 成员 | 身份  | 加入 Safe          | 建议设备 | 保管状态 |
| -- | --- | ---------------- | ---- | ---- |
| M1 | 营销方 | W2、W3            | 硬件钱包 | [ ]  |
| M2 | 营销方 | W2、W3            | 硬件钱包 | [ ]  |
| T1 | 技术方 | W2、W3、W4         | 硬件钱包 | [ ]  |
| T2 | 技术方 | W4（可选 W2/W3 监督席） | 硬件钱包 | [ ]  |

- [ ] 每个签名者独立助记词，互不派生、互不备份给对方
- [ ] Safe owner 地址与签名操作设备分离（owner 地址冷存储，签名走硬件钱包）
- [ ] 阈值设计说明：2/3 保证任一单方无法独自动用资金或改参数；W3 混入技术 1 席为审计监督，如营销不接受可改 2/2 营销双签（需在 §4 备注签字）

---

## 3. 资金准备汇总

| 钱包        | 资产         | 用途         | 参考额度           | 状态  |
| --------- | ---------- | ---------- | -------------- | --- |
| W1 部署     | USDT       | 底池注入       | 21,000（必）      | [ ] |
| W1 部署     | BNB        | 9 合约部署 gas | 0.3-0.5        | [ ] |
| W2 治理     | BNB        | 多签提案执行     | ~0.05          | [ ] |
| W3 营销     | BNB        | 提款 gas     | ~0.02          | [ ] |
| W4 技术     | BNB        | 提款 gas     | ~0.02          | [ ] |
| W5 keeper | BNB        | 每日快照       | ~0.02          | [ ] |
| W6 UAT    | USDT + BNB | 冒烟测试       | 100-500 + 0.05 | [ ] |

> 注：GST 2.1 万枚与 21 亿 ZYT 由合约铸造，无需外部资金；GST 其余供应（3.33 亿 - 2.1 万）部署时锁黑洞 0xdEaD，非钱包、无需准备。

---

## 4. 多签 owner 与阈值（建议默认，可调）

| Safe    | 默认 owner 集合 | 默认阈值 | 制衡逻辑                       |
| ------- | ----------- | ---- | -------------------------- |
| W2 治理   | M1、M2、T1    | 2/3  | 营销 2 人 + 技术 1 人，双方都无法独自改参数 |
| W3 营销收款 | M1、M2、T1    | 2/3  | 技术 1 席监督，防营销单人挪用分成         |
| W4 技术收款 | T1、T2       | 2/2  | 技术内部双签（如需营销监督可加席）          |

调整记录（改动需双人确认并在此留痕）：\________________________________________

---

## 5. 执行时序（与流程清单对应）

| 阶段      | 动作                                                                                                       | 涉及       | 对应流程清单                       |
| ------- | -------------------------------------------------------------------------------------------------------- | -------- | ---------------------------- |
| 准备期 T-7 | 生成 W1/W5/W6/W7 全部私钥，W2/W3/W4 创建并演练签名                                                                     | 全部       | 阶段 0 角色表                     |
| 演练 T-5  | testnet 完整走 transferOwnership + setUint 提案-签名-执行                                                         | W2 成员    | 1.3.4                        |
| 部署 T-2  | zyt-contracts/.env 填 `PRIVATE_KEY / MARKET_ADDRESS=W3 / TECHNICAL_ADDRESS=W4 / KEEPER_ADDRESS=W5`，执行主网部署 | W1       | 阶段 2 纪律（合约部署不可回滚，安排 T-1 前完成） |
| 移交 T-1  | deployer 单签 transferOwnership(W2)；字节码/参数核对表签字                                                            | W1、W2    | 1.3.3 + 安全清单                 |
| 验证 T-0  | §8 命令逐项核对 4 个地址参数                                                                                        | 复核人      | 阶段 3                         |
| 上线后     | 首笔业务分成入账核对 + 每日快照触发                                                                                      | W3/W4/W5 | 阶段 4 巡检                      |

---

## 6. 安全硬规则

- 6 个私钥主体独立生成，禁止同一助记词派生多个角色
- 明文私钥禁止进入代码库、聊天、截图；`.env` 已 .gitignore，服务器上 `chmod 600`
- W1/W2/W3/W4 私钥或助记词只落硬件钱包与离线介质，联网设备不留存
- owner 移交后，W1 若再次持有管理权限即视为事故（链上 owner() 以 W2 为准复检）
- 任何提款/参数变更走 Safe 提案留痕，禁止成员私钥直接操作合约

---

## 7. 风险提示

| 风险                  | 等级 | 应对                               |
| ------------------- | -- | -------------------------------- |
| Safe 签名者流失（离职/丢设备）  | 高  | 预留可替换席次（如 3/5 扩容）；私钥冷备位置两人知晓     |
| W2 与 W3 混管幻觉        | 中  | 保持 owner=W2 与收款=W3/W4 分离，定期读链上核对 |
| 多签执行不及时（pause/改参延误） | 中  | 预案：keeper 监控告警 15 分钟响应，多签成员值班表   |
| 单点私钥泄露              | 低  | 多签 2/3 兜底；W5 泄露仅损 gas            |

---

## 8. 验证命令速查（主网部署后执行）

```bash
# 进入合约工程
cd F:/zyt/zyt-contracts

# 读取链上地址参数（hardhat console，先确保 .env RPC 指向主网）
npx hardhat console --network bsc
# 在 console 内：
#   const cfg = await ethers.getContractAt("ZYTConfig", "<ZYTConfig地址>")
#   await cfg.owner()            # 期望 == W2 治理 Safe
#   await cfg.marketAddress()    # 期望 == W3
#   await cfg.technicalAddress() # 期望 == W4
#   await cfg.keeperAddress()    # 期望 == W5
#   await cfg.poolStage1USDT()   # 期望 0（决策 A 初始即 stage2）
#   await cfg.poolStage2USDT()   # 期望 20000000
#   await cfg.buyWhitelistEnabled() # 期望 true
# 退出：.exit

# owner 移交（多签转移前由 deployer 执行，单签）
#   const cfg = await ethers.getContractAt("ZYTConfig", "<ZYTConfig地址>")
#   await (await cfg.transferOwnership("<W2地址>")).wait()
#   await cfg.owner()            # 复核 == W2

# 5 个钱包互异性检查
# W1/W5/W6 与 W2/W3/W4 Safe 地址全部不同；W5 与任何资金地址不同
```

---

> 验收口径：W1-W7 全部勾选完成，§3 资金到位，§8 四参数核对一致且 owner=W2、keeper=W5、市场收款=W3、技术收款=W4，方可进入《上线流程清单》阶段 2。  
> 文档版本：v1.0（2026-09-02）｜ 后续调整（席位/阈值/保管人变更）在此文件追加修订记录，禁止直接改写已签字历史。
