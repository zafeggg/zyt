// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ZYTConfig.sol";
import "./ZYTPoolManager.sol";
import "./ZYTReferral.sol";
import "./ZYTCompute.sol";
import "./interfaces/IZYTTokenLike.sol";

/**
 * @title ZYTMining
 * @notice v9 入金/买入/卖出主入口。
 *         - 入金（仅 USDT，100-500U 可调）：40% 生态 USDT 直发（30% 代数 + 10% 技术），
 *           60% 由 PoolManager 真实组 LP 凭证销毁；入金者获算力（日复利 1%）与买额（1:1）
 *         - 买入：真实 AMM swap（阶段 1 禁买；阶段 2 消耗买额；阶段 3 自由）
 *         - 卖出：真实 AMM swap + 滑点档位 30/30/40；卖出实收 USDT 计入累计提取
 *         - 加速释放（v9 拍板）：静态出局 = 累计提取 ≥ 2×本金（含转出按价计值）；
 *           动态出局 = 动态额度 5×本金被推荐奖励耗尽，复投注入新额度恢复
 *         - 分红：每日通缩 1% + 滑点 30% + 转账税 30%，按日隔离、按算力加权结算（沿用 v8）
 */
contract ZYTMining is ReentrancyGuard {
    ZYTConfig public config;
    ZYTPoolManager public pool;
    ZYTReferral public referral;
    address public zytToken;
    address public usdt;
    address public deflation;

    struct UserState {
        uint256 depositTotal;       // 累计入金 USDT
        uint256 withdrawTotal;      // 累计提取 USDT（静态 2 倍判断）
        uint256 powerBase;          // 算力基数
        uint256 powerDay;           // 入金日（复利起始）
        uint256 pendingDividend;    // 待提取分红（ZYT）
        bool isExited;              // 静态出局标记（复投时重置）
        uint256 receivedValue;      // 累计受赠 USDT 等值（转账接收折算）
        uint256 exitDay;            // 静态出局日（算力停发起点，保留 base 供分红回算）
        // ---- v9 新增 ----
        uint256 buyQuota;           // 买额累计（= 入金 1:1）
        uint256 buyUsed;            // 已用买额
        uint256 dynamicQuota;       // 动态额度总量（= 入金 × 5）
        uint256 dynamicWithdrawn;   // 已消耗（推荐奖励 USDT 逐笔扣减）
        bool dynamicExited;         // 动态出局标记（额度耗尽；复投解除）
    }

    struct DailyInfo {
        uint256 totalPower;         // 当日全网算力和（Keeper 传入）
        uint256 dividendAmount;     // 当日分红总额（ZYT）
    }

    mapping(address => UserState) public users;
    mapping(uint256 => DailyInfo) public dailyInfo;
    mapping(address => uint256) public dividendClaimedDay; // 按日结算游标
    uint256 public constant MAX_SETTLE_DAYS = 365;

    event Deposited(address indexed user, uint256 usdt, uint256 power, uint256 quota, address ref);
    event Bought(address indexed user, uint256 usdtIn, uint256 zytOut);
    event Sold(address indexed user, uint256 zytIn, uint256 usdtOut, uint256 rate);
    event StaticExited(address indexed user);
    event DynamicExited(address indexed user);
    event DailyReleased(uint256 day, uint256 totalPower);
    event DividendSettled(address indexed user, uint256 amount, uint256 fromDay, uint256 toDay);
    event Claimed(address indexed user, uint256 amount);
    event TransferLedger(address indexed user, uint256 zytAmount, uint256 usdtValue, bool isOut);
    event RefPaid(address indexed receiver, uint256 usdtAmount, uint256 level);

    modifier whenNotPaused() {
        require(!config.paused(), "Mining: paused");
        _;
    }

    modifier onlyDeflation() {
        require(msg.sender == deflation, "Mining: only deflation");
        _;
    }

    constructor(
        address config_,
        address pool_,
        address referral_,
        address zytToken_,
        address usdt_
    ) {
        config = ZYTConfig(config_);
        pool = ZYTPoolManager(pool_);
        referral = ZYTReferral(referral_);
        zytToken = zytToken_;
        usdt = usdt_;
    }

    function setDeflation(address _deflation) external {
        require(msg.sender == config.owner(), "Mining: not owner");
        deflation = _deflation;
    }

    /**
     * @notice 入金（仅 USDT，最小 100U / 单笔上限 500U，可调）
     * @dev v9 资金流：40% USDT 直发（30% 代数 + 10% 技术，含动态额度消耗）
     *      60% 转 PoolManager 真实组 LP 凭证销毁；入金者获算力 + 买额（1:1）+ 动态额度（×5）
     */
    function deposit(uint256 usdtAmount, address ref) external nonReentrant whenNotPaused {
        require(usdtAmount >= config.minDeposit() && usdtAmount <= config.maxDeposit(), "Mining: amount range");
        IERC20(usdt).transferFrom(msg.sender, address(this), usdtAmount);

        // 1. 推荐关系绑定（先绑定再分账）
        referral.bind(msg.sender, ref);

        // 2. 40% 生态奖励：30% 代数（逐笔消耗推荐人动态额度）+ 10% 技术运维
        _distributeRef(msg.sender, usdtAmount);

        // 3. 60% 注入流动性池并销毁（真池 halfBuy + addLiquidity + LP 凭证黑洞）
        uint256 poolIn = usdtAmount * config.poolRate() / 10000;
        IERC20(usdt).transfer(address(pool), poolIn);
        pool.injectLiquidity(poolIn);

        // 4. 用户记账：算力（复利固化后重置，P1-12）+ 买额 + 动态额度
        UserState storage u = users[msg.sender];
        uint256 today = block.timestamp / 86400;
        _settleDividend(msg.sender, today, true);
        u.isExited = false;
        u.dynamicExited = false;
        u.depositTotal += usdtAmount;
        uint256 power = usdtAmount * config.powerRate() / 10000;
        if (u.powerBase > 0) {
            uint256 refDay = (u.exitDay > 0 && u.exitDay < today) ? u.exitDay : today;
            u.powerBase = ZYTCompute.powerWithCompound(
                u.powerBase,
                config.dailyCompoundRate(),
                refDay > u.powerDay ? refDay - u.powerDay : 0
            );
        }
        u.exitDay = 0;
        u.powerBase += power;
        u.powerDay = today;
        u.buyQuota += usdtAmount * config.buyQuotaRate() / 10000;
        u.dynamicQuota += usdtAmount * config.dynamicQuotaMul();

        emit Deposited(msg.sender, usdtAmount, power, u.buyQuota, ref);
    }

    /**
     * @notice 买入 ZYT（真实 AMM swap）
     * @dev 阶段 1 禁买；阶段 2 消耗买额（入金 1:1）；阶段 3 自由。
     *      USDT 直达 PoolManager，ZYT 从 pair 直达用户（gate 放行）。
     */
    function buy(uint256 usdtIn) external nonReentrant whenNotPaused returns (uint256 zytOut) {
        require(usdtIn > 0, "Mining: zero");
        uint256 stage = pool.getStage();
        require(stage != 1, "Mining: buy disabled in stage1");
        UserState storage u = users[msg.sender];
        if (stage == 2) {
            require(u.buyQuota - u.buyUsed >= usdtIn, "Mining: over buy quota");
            u.buyUsed += usdtIn;
        }
        IERC20(usdt).transferFrom(msg.sender, address(pool), usdtIn);
        zytOut = pool.buyFor(msg.sender, usdtIn);
        emit Bought(msg.sender, usdtIn, zytOut);
    }

    /**
     * @notice 卖出 ZYT 换 USDT（真实 AMM swap + 滑点档位 30/30/40）
     * @dev 卖出实收 USDT 计入累计提取；累计提取 ≥ 2×本金 + 受赠 → 静态出局
     */
    function sellZyt(uint256 zytGross) external nonReentrant whenNotPaused {
        uint256 rate = pool.getCurrentSlippage();
        uint256 usdtOut = pool.sellFor(msg.sender, zytGross);
        IZYTTokenLike(zytToken).recordSellUsdt(msg.sender, usdtOut);
        UserState storage u = users[msg.sender];
        u.withdrawTotal += usdtOut;
        if (!u.isExited && ZYTCompute.isStaticExited(u.withdrawTotal, u.depositTotal, config.staticExitMul(), u.receivedValue)) {
            _markExited(msg.sender, u);
        }
        emit Sold(msg.sender, zytGross, usdtOut, rate);
    }

    // ---------- P1-7 转账折算记账（仅 ZYTToken 调用） ----------

    /// @notice 转出折算：按快照价计入累计提取（转账视同卖出，堵静态 2 倍绕过）
    function recordTransferOut(address user, uint256 zytAmount) external {
        require(msg.sender == zytToken, "Mining: not token");
        if (zytAmount == 0) return;
        uint256 price = pool.getTradePrice();
        if (price == 0) return;
        uint256 usdtValue = zytAmount * price / 1e18;
        if (usdtValue == 0) return;

        UserState storage u = users[user];
        u.withdrawTotal += usdtValue;
        if (!u.isExited && ZYTCompute.isStaticExited(u.withdrawTotal, u.depositTotal, config.staticExitMul(), u.receivedValue)) {
            _markExited(user, u);
        }
        emit TransferLedger(user, zytAmount, usdtValue, true);
    }

    /// @notice 转入折算：计入受赠额（等额提高接收方提取上限，额度守恒）
    function recordTransferIn(address user, uint256 zytAmount) external {
        require(msg.sender == zytToken, "Mining: not token");
        if (zytAmount == 0) return;
        uint256 price = pool.getTradePrice();
        if (price == 0) return;
        uint256 usdtValue = zytAmount * price / 1e18;
        if (usdtValue == 0) return;
        users[user].receivedValue += usdtValue;
        emit TransferLedger(user, zytAmount, usdtValue, false);
    }

    // ---------- 分红（按日隔离，沿用 v8） ----------

    /// @notice 每日记录全网算力（ZYTDeflation 调用，分红分配分母）
    function dailyRelease(uint256 day, uint256 totalPower) external onlyDeflation {
        dailyInfo[day].totalPower = totalPower;
        emit DailyReleased(day, totalPower);
    }

    /// @notice 登记当日分红总额（ZYTDeflation 调用，通缩 1% 部分）
    function recordDailyDividend(uint256 day, uint256 amount) external onlyDeflation {
        dailyInfo[day].dividendAmount = amount;
    }

    /// @notice 提取分红（三阶段均可；ZYT 从 Pool 分红池转出）
    function claimDividend() external nonReentrant returns (uint256 amount) {
        uint256 today = block.timestamp / 86400;
        _settleDividend(msg.sender, today, false);
        UserState storage u = users[msg.sender];
        amount = u.pendingDividend;
        require(amount > 0, "Mining: nothing to claim");
        u.pendingDividend = 0;
        pool.payoutDividend(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function dividendOf(address user) external view returns (uint256 pending, uint256 settledDay) {
        return (users[user].pendingDividend, dividendClaimedDay[user]);
    }

    function _settleDividend(address user, uint256 toDay, bool strict) internal returns (uint256 total) {
        UserState storage u = users[user];
        uint256 from = dividendClaimedDay[user];
        if (from < u.powerDay) from = u.powerDay;
        if (from == 0) {
            dividendClaimedDay[user] = toDay;
            return 0;
        }
        if (from >= toDay) return 0;

        if (strict && toDay - from > MAX_SETTLE_DAYS) {
            revert("Mining: settle dividend first");
        }
        uint256 end = from + MAX_SETTLE_DAYS;
        if (end > toDay) end = toDay;

        for (uint256 d = from; d < end; d++) {
            uint256 divAmt = dailyInfo[d].dividendAmount;
            if (divAmt == 0) continue;
            uint256 dayPower = dailyInfo[d].totalPower;
            if (dayPower == 0) continue;
            uint256 up = _powerOf(user, d);
            if (up == 0) continue;
            total += divAmt * up / dayPower;
        }
        dividendClaimedDay[user] = end;
        if (total > 0) {
            u.pendingDividend += total;
            emit DividendSettled(user, total, from, end);
        }
    }

    // ---------- 出局 ----------

    /// @notice 静态出局：记 exitDay（不清 powerBase，历史分红可回算；day >= exitDay 算力为 0）
    function _markExited(address user, UserState storage u) internal {
        u.isExited = true;
        u.exitDay = block.timestamp / 86400;
        emit StaticExited(user);
    }

    // ---------- 视图 ----------

    function powerOf(address user) public view returns (uint256) {
        return _powerOf(user, block.timestamp / 86400);
    }

    function _powerOf(address user, uint256 day) internal view returns (uint256) {
        UserState storage u = users[user];
        if (u.powerBase == 0) return 0;
        if (u.exitDay > 0 && day >= u.exitDay) return 0;
        uint256 daysElapsed = day > u.powerDay ? day - u.powerDay : 0;
        return ZYTCompute.powerWithCompound(u.powerBase, config.dailyCompoundRate(), daysElapsed);
    }

    function userInfo(address user)
        external
        view
        returns (
            uint256 depositTotal,
            uint256 withdrawTotal,
            uint256 power,
            uint256 dynamicQuota,
            uint256 dynamicWithdrawn,
            uint256 buyQuotaLeft,
            bool staticExited,
            bool dynamicExited
        )
    {
        UserState storage u = users[user];
        return (
            u.depositTotal,
            u.withdrawTotal,
            _powerOf(user, block.timestamp / 86400),
            u.dynamicQuota,
            u.dynamicWithdrawn,
            u.buyQuota - u.buyUsed,
            u.isExited,
            u.dynamicExited
        );
    }

    /// @notice P1-7 查询：受赠值与提取上限（= 入金 × 2 + 受赠）
    function transferValueOf(address user) external view returns (uint256 receivedValue, uint256 withdrawCap) {
        UserState storage u = users[user];
        receivedValue = u.receivedValue;
        withdrawCap = u.depositTotal * config.staticExitMul() + receivedValue;
    }

    // ---------- 40% 生态奖励（USDT 直发 + 动态额度消耗） ----------

    /**
     * @notice 40% 生态奖励分发：30% 按代数给推荐链（逐笔消耗推荐人动态额度）、10% 技术
     * @dev 直推数 = 可拿代数（决策 21）；推荐人动态额度耗尽部分转营销账户（加速释放口径）；
     *      代际拿不满的余额转营销账户。
     */
    function _distributeRef(address user, uint256 usdtAmount) internal {
        address[] memory ancestors = referral.getAncestors(user, config.refDepth());

        // 技术运维与社区建设 10%
        uint256 techUsdt = usdtAmount * config.refTechnicalRate() / 10000;
        if (techUsdt > 0 && config.technicalAddress() != address(0)) {
            IERC20(usdt).transfer(config.technicalAddress(), techUsdt);
        }

        // 代数奖励预算 = 40% − 10% = 30%
        uint256 refBudget = usdtAmount * (config.marketingRate() - config.refTechnicalRate()) / 10000;
        uint256 paid = 0;

        for (uint256 i = 0; i < ancestors.length; i++) {
            address a = ancestors[i];
            if (a == address(0)) break;
            // 直推数 = 可拿代数：上级直推人数不足层级则跳过
            if (referral.downlineCount(a) < i + 1) continue;
            uint256 rate = config.refRateForLevel(i + 1);
            if (rate == 0) continue;
            uint256 rewardUsdt = usdtAmount * rate / 10000;
            if (paid + rewardUsdt > refBudget) {
                rewardUsdt = refBudget - paid;
            }
            if (rewardUsdt == 0) break;
            // v9 加速释放：推荐奖励逐笔消耗推荐人动态额度，耗尽即动态出局
            uint256 paidOut = _consumeQuota(a, rewardUsdt);
            if (paidOut == 0) continue;
            IERC20(usdt).transfer(a, paidOut);
            paid += paidOut;
            emit RefPaid(a, paidOut, i + 1);
        }

        // 拿不满的余额转营销账户
        if (paid < refBudget && config.marketAddress() != address(0)) {
            IERC20(usdt).transfer(config.marketAddress(), refBudget - paid);
        }
    }

    /// @notice 消耗推荐人动态额度（加速释放），返回实发量；耗尽触发动态出局
    function _consumeQuota(address referrer, uint256 want) internal returns (uint256 paid) {
        UserState storage u = users[referrer];
        if (u.dynamicQuota == 0 || u.dynamicWithdrawn >= u.dynamicQuota) return 0;
        uint256 left = u.dynamicQuota - u.dynamicWithdrawn;
        paid = want < left ? want : left;
        u.dynamicWithdrawn += paid;
        if (!u.dynamicExited && u.dynamicWithdrawn >= u.dynamicQuota) {
            u.dynamicExited = true;
            emit DynamicExited(referrer);
        }
    }
}
