# 众赢币（ZYT）上线操作手册

> **配套文档**：《众赢币(ZYT)_上线流程清单.md》（勾选用）；本手册回答"每一步**做什么、怎么做、做到什么程度算通过**"。
> **约定**：`$` 开头为 shell 命令（Git Bash）；`【确认】`为通过标准；`<占位符>`按实际替换。
> **边界**：ZYT 独立运营，不使用 GYT 服务器；keeper 本地模式运行。

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
# 主网（上线前把脚本复制为 verify-all-mainnet.js，替换地址与 network）
$ npx hardhat run scripts/verify-all-mainnet.js --network bsc
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

#### 1.2.2 冒烟测试（testnet 全链路）
```bash
$ USDT_MOCK=1 npx hardhat run scripts/smoke-testnet.js --network bscTestnet
```
**【确认】** P0-P6 共 45/45 断言 PASS；如报 `no dividend`（当日分红已被领取）属正常，次日重跑

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
  - `config.keeperAddress()` == 签名钱包地址
  - `config.deflationFloor()` == 500 万枚
  - `pool.poolStage1USDT()/poolStage2USDT()` == 部署决策值（0 / 2000 万）
  - 滑点档位 tier1-4 == 1000/2000/3000/4000
  - `pool.buyWhitelist(<各白名单地址>)` == true
- **【确认】** 每项打印值与部署记录一致，形成核对表存档

#### 1.3.4【ZYT】Gnosis Safe 多签
- **怎么做**：创建 Safe → 导入多个 owner（营销/技术方各持钥）→ 策略 2/3 或 3/5 → **在 testnet 或用模拟交易完整走一遍** setUint 提案-签名-执行流程
- **【确认】** 多签地址已 replaceOwner 接管合约 owner（`owner()` 返回 Safe 地址）；演练记录截图

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
$ scp -r dist/* <user>@<你的部署目标>:<目录>/     # ZYT 自有部署目标
```
- **【确认】** 无痕浏览器访问 → view-source 中 `?v=` 为新值 → 页面功能加载无 404、控制台无报错
- 【注意】**每次只改 index.html 不改静态资源也要更新 `?v=`**——这是本项目历史踩坑点

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
# 查 BSC 最新块高（START_BLOCK 对齐用）
$ curl -s -X POST https://bsc-testnet-rpc.publicnode.com -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'   # 返回 16 进制，*1 转十进制

# 手动触发快照（补快照；会占用当日快照额度）
$ cd F:/zyt/zyt-keeper && timeout 120 node scripts/snapshot-now.js

# 手动对账
$ curl -s -X POST http://127.0.0.1:8080/reconcile -H "Authorization: Bearer <API_ADMIN_TOKEN>"

# 备份 / 恢复
$ mysqldump -u zyt_keeper -p --single-transaction zyt_keeper > backup_$(date +%Y%m%d).sql
$ mysql -u zyt_keeper -p <库名> < backup_YYYYMMDD.sql

# keeper 启停
$ cd F:/zyt/zyt-keeper && node src/index.js
$ pm2 start src/index.js --name zyt-keeper && pm2 save

# 主网 verify（上线前准备）
$ npx hardhat run scripts/verify-all-mainnet.js --network bsc
```

> 文档版本：v1.0（2026-09-02）｜ 配套：《众赢币(ZYT)_上线流程清单.md》《众赢币(ZYT)_技术方案.md》§8

---

## 附录 C：邀请码分发 SOP（运营）

> 版本 v1.0（2026-09-09）｜ 前置：前端已上线邀请制入口 gate（v14，无邀请码无法进入主页面）

### C.1 机制速览

- **邀请码 = 推荐人的钱包地址**（0x 开头 42 位），或等价的推荐链接（`https://<域名>/#/?ref=<地址>`）
- 新用户必须持邀请码才能进入主页面：粘贴推荐链接或直接输 0x 地址均可（链接自动解析）
- **推荐绑定发生在首次入金**（`deposit(ref)`），gate 存的邀请码自动作为 ref 传入，绑定后不可改
- 推荐奖励按决策 21 执行：上级可拿代数 = 其直推人数（直推 1 人拿第 1 代 7%，2 人解锁第 2 代，至 20 代封顶 0.5% 档）
- 存储按合约代次隔离：**合约重新部署后所有邀请码记录失效**，需重新分发/输入

### C.2 官方初始码（冷启动）

| 项 | 决策 |
| -- | -- |
| 用途 | 第一批用户没有上游，官方码是唯一入口；建议对外**只发这一个码**，便于归因与控制 |
| 推荐取值 | **营销收款地址**（W3 / 市场 Safe）：推荐 7% 回营销多签 = 市场费用闭环，不外流 |
| 公示 | 官方码在公告/群公告置顶公示**全称地址**，防第三方冒充"官方邀请码"诈骗 |

**当前官方码**：
- testnet（第六套）：`0xB7233A003C37Beb100C4eFCF82793D24B90179F9`（= deployer，testnet 未单独部署营销多签；推荐链接 `http://121.40.45.58/#/?ref=0xB7233A003C37Beb100C4eFCF82793D24B90179F9`）
- 主网：待 W3 营销 Safe 搭建后替换（上线钱包准备清单_方案A W3），**官方码必须与 ZYTConfig.marketAddress 一致**，部署时用 `MARKET_ADDRESS` 环境变量传入 deploy.js
| 资金核对 | 每日对账含推荐分账（keeper reconcile），营销地址 7% 流入可在 BscScan 核对 |

### C.3 分发操作（运营 / 客服）

1. 生成官方推荐链接：登录 DApp（用营销地址钱包）→ 社区页 →「我的推荐链接」→ 复制
2. 二维码（海报/朋友圈用）：任意二维码生成器粘贴链接；落地页域名变更后需重新生成
3. 分发渠道：社群公告置顶 / 客服一对一 / 线下物料印刷二维码
4. 话术要点（合规）：
   - 「输入邀请码进入平台」；**禁止承诺收益、禁止「稳赚/保本」类表述**
   - 引导用户保存好邀请链接；入金时推荐关系自动绑定，无需手动操作
5. 成员二级传播：用户进入后 → 社区页复制**自己的**链接 → 转发即成为下级邀请码发行方（裂变自动进行，运营无需介入）

### C.4 测试期专用（testnet）

- 测试团队逃生入口：URL 追加 `skipInvite=1`（如 `https://<域名>/#/?skipInvite=1`），**仅限内部，不对外**；正式宣传物料绝不携带该参数
- testnet 白名单当前关闭（`buyWhitelistEnabled=false`），人人可入金；**主网上线前必须恢复 on**（防闪电贷防线，见上线核对清单）
- 换合约重部署后：官方码链接需用新地址重新生成并重新分发

### C.5 FAQ（客服口径）

| 问题 | 口径 |
| -- | -- |
| 输错邀请码 / 提示无效 | 邀请码必须为 0x 开头的完整地址或推荐链接；请重新向邀请人索要完整链接后复制粘贴 |
| 想更换邀请码 | 入金前清空浏览器站点数据后重新通过新邀请链接进入即可；**入金后推荐关系已绑定，不可更改** |
| 没有邀请码 | 联系邀请你加入社区的成员获取推荐链接；新用户请通过官方公告中的官方码进入 |
| 邀请码会过期吗 | 不会；但平台升级合约后历史邀请码失效，需通过最新推荐链接重新进入 |
| 邀请有奖励吗 | 推荐奖励随入金按链上规则结算（决策 21 代数规则），以页面展示为准，平台不作任何收益承诺 |

### C.6 风控要点

- 官方码地址全程公示，任何「非公示地址冒充官方」的行为需公告预警
- gate 仅拦入口（前端 UI 层），合约层防刷靠买入白名单（主网必开）+ 快照锁价双防线
- 禁止在邀请物料中出现固定收益/回本周期字样；分账与代数规则以链上为准
