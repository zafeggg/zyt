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
 * @notice 入金/入单、算力发放、每日产出领取、动态额度控制（方案 v7）。
 *         - 入金：仅 USDT，40% 营销 / 60% 注入底池并 mint ZYT
 *         - v7：买入白名单校验（非白名单地址 deposit 直接拒绝，防闪电贷）
 *         - v7：mint/推荐按当日快照锁定价（getTradePrice），防价格操纵
 *         - 算力：入金即获算力（1.0 倍），日复利 +1%
 *         - 动态额度：= 入金 × 5，耗尽停发收益、复投恢复
 *         - 静态 2 倍出局：累计提取 ≥ 2×入金停发
 *         - 阶段 2 门控：入金需 LP 额度（1:1）
 */
contract ZYTMining is ReentrancyGuard {
    ZYTConfig public config;
    ZYTPoolManager public pool;
    ZYTReferral public referral;
    address public zytToken;
    address public usdt;
    address public deflation;

    /// @notice 每日产出释放量（ZYT，运营参数，可调；原需求未明确公式，默认 10 万/日）
    uint256 public dailyReleaseAmount = 100_000e18;

    struct UserState {
        uint256 depositTotal;       // 累计入金 USDT
        uint256 withdrawTotal;      // 累计提取 USDT（静态 2 倍判断）
        uint256 dynamicQuota;       // 动态收益额度 = depositTotal × 5
        uint256 dynamicWithdrawn;   // 已消耗动态额度（推荐奖励 + 产出）
        uint256 powerBase;          // 算力基数
        uint256 powerDay;           // 入金日（复利起始）
        uint256 lpQuota;            // 阶段 2 买币额度（LP 1:1）
        uint256 pendingDividend;    // 待领取分红（ZYT）
        bool isExited;              // 静态出局标记
    }

    struct DailyInfo {
        uint256 totalPower;         // 当日全网算力和（Keeper 统计传入）
        uint256 releaseAmount;      // 当日释放量
    }

    mapping(address => UserState) public users;
    mapping(uint256 => DailyInfo) public dailyInfo; // day → 快照
    mapping(uint256 => bool) public dividendClaimed; // day → 分红已结算标记
    mapping(address => uint256) public lastDividendDay; // V13：用户最近领取分红日（每天最多一次）

    event Deposited(address indexed user, uint256 usdt, uint256 zytMinted, uint256 power, uint256 quota, address ref);
    event RefReward(address indexed receiver, uint256 reward, uint256 level, uint256 usdt);
    event Sold(address indexed user, uint256 zytIn, uint256 usdtOut, uint256 rate); // V17：加滑点档位（基点）
    event Claimed(address indexed user, uint256 reward, uint256 day, uint256 usdt);
    event DailyReleased(uint256 day, uint256 totalPower, uint256 releaseAmount);
    event DailyReleaseAmountSet(uint256 amount);
    event LiquidityAdded(address indexed user, uint256 usdt);
    event StaticExited(address indexed user);

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

    function setDailyReleaseAmount(uint256 amount) external {
        require(msg.sender == config.owner(), "Mining: not owner");
        dailyReleaseAmount = amount;
        emit DailyReleaseAmountSet(amount);
    }

    /// @notice 阶段 2：打 LP 获得买币额度（USDT 转入池作为流动性，额度 1:1）
    function addLiquidity(uint256 usdtAmount) external nonReentrant whenNotPaused {
        require(pool.getStage() == 2, "Mining: not stage2");
        require(usdtAmount > 0, "Mining: zero");
        IERC20(usdt).transferFrom(msg.sender, address(pool), usdtAmount);
        users[msg.sender].lpQuota += usdtAmount;
        emit LiquidityAdded(msg.sender, usdtAmount);
    }

    /**
     * @notice 入金（仅 USDT）
     * @param usdtAmount 入金金额（100-500U 可调）
     * @param ref 推荐人地址
     */
    function deposit(uint256 usdtAmount, address ref) external nonReentrant whenNotPaused {
        require(usdtAmount >= config.minDeposit() && usdtAmount <= config.maxDeposit(), "Mining: amount range");
        uint256 stage = pool.getStage();
        require(stage >= 2, "Mining: buy disabled in stage1");
        // v7：买入白名单（防闪电贷第一道防线；阶段 2/3 均需白名单）
        if (config.buyWhitelistEnabled()) {
            require(pool.buyWhitelist(msg.sender), "Mining: not whitelisted");
        }
        if (stage == 2) {
            require(users[msg.sender].lpQuota >= usdtAmount, "Mining: no LP quota");
            users[msg.sender].lpQuota -= usdtAmount;
        }

        // 1. 收 USDT
        IERC20(usdt).transferFrom(msg.sender, address(this), usdtAmount);

        // 2. 40% 营销
        uint256 marketing = usdtAmount * config.marketingRate() / 10000;
        if (marketing > 0) IERC20(usdt).transfer(config.marketAddress(), marketing);

        // 3. 60% 注入底池 + mint ZYT（v7：按当日快照锁定价）
        uint256 poolIn = usdtAmount - marketing;
        IERC20(usdt).transfer(address(pool), poolIn); // USDT 实际转入池合约（卖出支付储备）
        pool.recordBuy(poolIn);
        uint256 price = pool.getTradePrice();
        require(price > 0, "Mining: price zero");
        uint256 zytMinted = poolIn * 1e18 / price;
        IZYTTokenLike(zytToken).mintTo(msg.sender, zytMinted);

        // 4. 用户记账
        UserState storage u = users[msg.sender];
        // P1-3 决策（推荐 A）：静态出局用户复投自动重置出局状态（重新计 2 倍）。
        // 注意：withdrawTotal 保留不清零，2 倍出局判定按「累计提取 vs 累计入金×2」延续，
        // 避免复投清零导致每轮可独立提取 2 倍（崩盘路径）。
        u.isExited = false;
        u.depositTotal += usdtAmount;
        uint256 power = usdtAmount * config.powerRate() / 10000;
        u.powerBase += power;
        u.powerDay = block.timestamp / 86400;
        u.dynamicQuota = ZYTCompute.quotaFor(u.depositTotal, config.dynamicQuotaMul());

        // 5. 推荐分账
        referral.bind(msg.sender, ref);
        _distributeRef(msg.sender, usdtAmount);

        emit Deposited(msg.sender, usdtAmount, zytMinted, power, u.dynamicQuota, ref);
    }

    /// @notice 卖出 ZYT 换 USDT（滑点档位由 Pool 判定，分配 30/30/40）
    function sellZyt(uint256 zytGross) external nonReentrant whenNotPaused {
        // V17：卖出前读取滑点档位（与 settleSell 内部同区块同状态，值一致），事件携带便于链下对账
        uint256 rate = pool.getCurrentSlippage();
        uint256 usdtOut = pool.settleSell(msg.sender, zytGross);
        // v7：卖出 USDT 折合上报给 token（累计卖出统计）
        IZYTTokenLike(zytToken).recordSellUsdt(msg.sender, usdtOut);
        UserState storage u = users[msg.sender];
        u.withdrawTotal += usdtOut;
        if (!u.isExited && ZYTCompute.isStaticExited(u.withdrawTotal, u.depositTotal, config.staticExitMul())) {
            u.isExited = true;
            u.powerBase = 0; // 静态出局：算力停发
            emit StaticExited(msg.sender);
        }
        emit Sold(msg.sender, zytGross, usdtOut, rate);
    }

    /// @notice 每日释放（ZYTDeflation 调用）：记录当日全网算力与释放量
    function dailyRelease(uint256 day, uint256 totalPower) external onlyDeflation {
        dailyInfo[day].totalPower = totalPower;
        dailyInfo[day].releaseAmount = dailyReleaseAmount;
        emit DailyReleased(day, totalPower, dailyReleaseAmount);
    }

    /// @notice 领取某日出产（按当日算力份额）
    function claimReward(uint256 day) external nonReentrant {
        DailyInfo storage info = dailyInfo[day];
        UserState storage u = users[msg.sender];
        require(info.releaseAmount > 0 && info.totalPower > 0, "Mining: no info");
        require(!u.isExited, "Mining: exited");
        // P1-1 修复：只能领取入金日（含）之后的产出，禁止回溯领取入金前的历史日产出
        require(day >= u.powerDay, "Mining: before deposit");
        require(!ZYTCompute.isQuotaExhausted(u.dynamicWithdrawn, u.dynamicQuota), "Mining: quota exhausted");

        uint256 powerAt = _powerOf(msg.sender, day);
        if (powerAt == 0) revert("Mining: no power");
        uint256 reward = info.releaseAmount * powerAt / info.totalPower;
        if (reward == 0) revert("Mining: zero reward");
        require(!_rewardClaimed[msg.sender][day], "Mining: claimed");

        // v8 修复：额度消耗统一按 USDT 等值（按当日快照锁定价折算，与推荐奖励单位一致）
        uint256 price = pool.getTradePrice();
        require(price > 0, "Mining: price zero");
        uint256 usdtVal = reward * price / 1e18;
        IZYTTokenLike(zytToken).mintTo(msg.sender, reward);
        // P2-1 修复：状态变更全部后置到 mint 成功之后——
        // 原实现先置 _rewardClaimed 再 mint，若 totalSupplyCap 触发 revert，标记已置位导致当日产出永久丢失
        _rewardClaimed[msg.sender][day] = true;
        u.dynamicWithdrawn += usdtVal;
        emit Claimed(msg.sender, reward, day, usdtVal);
    }

    /// @notice 领取分红（滑点 30% + 通缩 1% 累计池，按最新全网算力加权）
    /// @dev V13：按用户按日记录（每天最多一次），防反复领取导致的算力占比虚高
    function claimDividend() external nonReentrant {
        UserState storage u = users[msg.sender];
        require(!u.isExited, "Mining: exited");
        // P1-2 修复：动态额度耗尽后停发分红（与 claimReward 对齐，堵「额度耗尽仍每日领分红」漏洞）
        require(!ZYTCompute.isQuotaExhausted(u.dynamicWithdrawn, u.dynamicQuota), "Mining: quota exhausted");
        uint256 day = block.timestamp / 86400;
        require(lastDividendDay[msg.sender] < day, "Mining: claimed today");
        uint256 totalPower = _latestTotalPower();
        require(totalPower > 0, "Mining: no power pool");
        uint256 poolDividend = pool.dividendPool();
        if (poolDividend == 0) revert("Mining: no dividend");
        uint256 powerNow = _powerOf(msg.sender, day);
        uint256 share = poolDividend * powerNow / totalPower;
        if (share == 0) revert("Mining: zero share");
        pool.payoutDividend(msg.sender, share);
        lastDividendDay[msg.sender] = day; // V13：标记当日已领
        // 修复 V2：分红额度消耗统一按 USDT 等值折算（与 claimReward 一致，share 为 ZYT 数）
        uint256 price = pool.getTradePrice();
        require(price > 0, "Mining: price zero");
        uint256 usdtVal = share * price / 1e18;
        u.dynamicWithdrawn += usdtVal;
        emit Claimed(msg.sender, share, 0, usdtVal);
    }

    /// @notice 当前算力（复利）
    function powerOf(address user) public view returns (uint256) {
        return _powerOf(user, block.timestamp / 86400);
    }

    function _powerOf(address user, uint256 day) internal view returns (uint256) {
        UserState storage u = users[user];
        if (u.powerBase == 0) return 0;
        uint256 daysElapsed = day > u.powerDay ? day - u.powerDay : 0;
        return ZYTCompute.powerWithCompound(u.powerBase, config.dailyCompoundRate(), daysElapsed);
    }

    function _latestTotalPower() internal view returns (uint256) {
        uint256 day = block.timestamp / 86400;
        for (uint256 i = 0; i < 30; i++) {
            if (dailyInfo[day - i].totalPower > 0) return dailyInfo[day - i].totalPower;
        }
        return 0;
    }

    function _distributeRef(address user, uint256 usdtAmount) internal {
        address[] memory ancestors = referral.getAncestors(user, config.refDepth());
        uint256 price = pool.getTradePrice(); // v7：按当日快照锁定价换算
        require(price > 0, "Mining: price zero");

        // 技术运维 10%（按 USDT 计，mint 时按价格换算为 ZYT）
        uint256 techUsdt = usdtAmount * config.refTechnicalRate() / 10000;
        if (techUsdt > 0) {
            IZYTTokenLike(zytToken).mintTo(config.technicalAddress(), techUsdt * 1e18 / price);
        }

        for (uint256 i = 0; i < ancestors.length; i++) {
            address a = ancestors[i];
            if (a == address(0)) break;
            uint256 rate = config.refRateForLevel(i + 1);
            if (rate == 0) continue;
            uint256 rewardUsdt = usdtAmount * rate / 10000;
            if (rewardUsdt == 0) continue;
            // 奖励以 USDT 计价，mint 时按当前价格换算为 ZYT
            uint256 rewardZyt = rewardUsdt * 1e18 / price;
            IZYTTokenLike(zytToken).mintTo(a, rewardZyt);
            users[a].dynamicWithdrawn += rewardUsdt; // 动态额度按 USDT 计（耗尽=入金×5）
            emit RefReward(a, rewardZyt, i + 1, rewardUsdt);
        }
    }

    // ---- 读接口（前端/链下） ----
    function userInfo(address user)
        external
        view
        returns (uint256 depositTotal, uint256 withdrawTotal, uint256 dynamicQuota, uint256 dynamicWithdrawn, uint256 power, uint256 lpQuota, bool isExited)
    {
        UserState storage u = users[user];
        return (u.depositTotal, u.withdrawTotal, u.dynamicQuota, u.dynamicWithdrawn, _powerOf(user, block.timestamp / 86400), u.lpQuota, u.isExited);
    }

    mapping(address => mapping(uint256 => bool)) private _rewardClaimed;
}

