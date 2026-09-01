// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./ZYTConfig.sol";
import "./interfaces/IZYTTokenLike.sol";

/**
 * @title ZYTPoolManager
 * @notice 底池管理：GST 记账、阶段门控、每日快照基准、动态滑点档位、滑点分配（30/30/40）。
 *         v7 新增：
 *         - 买入白名单（buyWhitelist）：防闪电贷第一道防线，仅白名单地址可买入
 *         - 当日快照基准价（snapshotPrice）：08:00 快照锁定价，买入/卖出统一计价（防价格操纵）
 *         价格模型：price = poolUSDT / poolZYT（U per ZYT）。
 *         滑点判定基准 = 底池古水币（GST）数量相对每日 08:00 快照的减少比例：
 *         减少 ≥1%→10%、≥2%→20%、≥3%→40%、≥4%→80%。
 *         （MVP 采用记账模型，DEX 兑换预留 router 接口）
 */
contract ZYTPoolManager is Ownable {
    ZYTConfig public config;
    address public zytToken;
    address public usdt;
    address public gstToken;
    address public mining;      // ZYTMining（入金/卖出主入口）
    address public deflation;   // ZYTDeflation（每日快照/通缩）

    // ---------- 底池状态 ----------
    uint256 public poolGST;             // 底池古水币数量（滑点判定基准）
    uint256 public poolZYT;             // 底池 ZYT 数量
    uint256 public poolUSDT;            // 底池折算 USDT（阶段判断 / 价格）
    uint256 public snapshotPoolGST;     // 每日 08:00 快照基准（底池 GST 数量，当日滑点判定）
    uint256 public snapshotPrice;       // v7: 每日 08:00 快照锁定价（当日买入/卖出统一计价，防闪电贷操纵）
    uint256 public lastSnapshotAt;      // 上次快照时间
    uint256 public dividendPool;        // 滑点 30% + 通缩 1% 累计（ZYT 计，按算力加权分发）

    // ---------- 买入白名单（v7：防闪电贷） ----------
    mapping(address => bool) public buyWhitelist;   // 白名单地址 → 可买入

    bool public initialized;

    event PoolInitialized(uint256 gst, uint256 zyt, uint256 usdt);
    event SnapshotUpdated(uint256 snapshotGST, uint256 snapshotPrice, uint256 time);
    event SlippageCollected(uint256 rate, uint256 toMarket, uint256 toDividend, uint256 toBurn);
    event BuyRecorded(uint256 usdtIn, uint256 gstIn);
    event SellSettled(address indexed seller, uint256 zytGross, uint256 usdtOut);
    event DividendAccrued(uint256 amount);
    event PoolBurned(uint256 amount);
    event BuyWhitelistSet(address indexed addr, bool enabled);

    modifier onlyMining() {
        require(msg.sender == mining, "Pool: only mining");
        _;
    }

    modifier onlyDeflation() {
        require(msg.sender == deflation, "Pool: only deflation");
        _;
    }

    constructor(address config_, address zytToken_, address usdt_, address gstToken_) Ownable(msg.sender) {
        config = ZYTConfig(config_);
        zytToken = zytToken_;
        usdt = usdt_;
        gstToken = gstToken_;
    }

    function setMining(address _mining) external onlyOwner {
        mining = _mining;
    }

    function setDeflation(address _deflation) external onlyOwner {
        deflation = _deflation;
    }

    /**
     * @notice 初始化底池（GST/USDT 池建立后调用一次）
     * @param gstAmount 底池 GST（2.1 万枚）
     * @param zytAmount 底池 ZYT（21 亿枚，全量）
     */
    function initialize(uint256 gstAmount, uint256 zytAmount) external onlyOwner {
        require(!initialized, "Pool: initialized");
        require(gstToken != address(0) && zytToken != address(0), "Pool: token not set");
        initialized = true;
        // GST 由部署者转入池合约
        IERC20(gstToken).transferFrom(msg.sender, address(this), gstAmount);
        // V5 修复：初始 2.1 万 USDT 真实转入池（账面 poolUSDT = 实际余额，消除缺口）
        // 需部署者先 faucet/持有并 approve 等值 USDT
        IERC20(usdt).transferFrom(msg.sender, address(this), gstAmount);
        // ZYT 全量铸造至池合约（ZYTToken.mintTo 允许 pool 调用）
        IZYTTokenLike(zytToken).mintTo(address(this), zytAmount);
        poolGST = gstAmount;
        poolZYT = zytAmount;
        poolUSDT = gstAmount; // GST 初始 1U = 1:1
        snapshotPoolGST = gstAmount;
        snapshotPrice = poolUSDT * 1e18 / poolZYT; // 初始锁定价（1 ZYT = 0.00001 U）
        lastSnapshotAt = block.timestamp;
        emit PoolInitialized(gstAmount, zytAmount, gstAmount);
    }

    // ---------- 买入白名单（v7：多签管理） ----------

    /// @notice 设置单个白名单（多签调用）
    function setBuyWhitelist(address addr, bool enabled) external onlyOwner {
        require(addr != address(0), "Pool: zero addr");
        buyWhitelist[addr] = enabled;
        emit BuyWhitelistSet(addr, enabled);
    }

    /// @notice 批量设置白名单（多签调用，运营批量放行）
    function setBuyWhitelistBatch(address[] calldata addrs, bool enabled) external onlyOwner {
        for (uint256 i = 0; i < addrs.length; i++) {
            buyWhitelist[addrs[i]] = enabled;
            emit BuyWhitelistSet(addrs[i], enabled);
        }
    }

    /// @notice 当前价格（U per ZYT，1e18 精度；实时价，仅供展示）
    function getPrice() public view returns (uint256) {
        if (poolZYT == 0) return 0;
        return poolUSDT * 1e18 / poolZYT;
    }

    /// @notice 交易计价价（v7）：当日 08:00 快照锁定价，买入/卖出统一使用；未快照前回退实时价
    function getTradePrice() public view returns (uint256) {
        if (snapshotPrice == 0) return getPrice();
        return snapshotPrice;
    }

    /// @notice 阶段门控：1 只卖不买 / 2 按 LP 额度 / 3 自由
    function getStage() public view returns (uint256) {
        if (poolUSDT < config.poolStage1USDT()) return 1;
        if (poolUSDT < config.poolStage2USDT()) return 2;
        return 3;
    }

    /// @notice 当前滑点档位（基点）：按底池 GST 减少比例
    function getCurrentSlippage() public view returns (uint256) {
        if (snapshotPoolGST == 0) return config.baseSlippage();
        if (poolGST >= snapshotPoolGST) return config.baseSlippage();
        uint256 reduction = (snapshotPoolGST - poolGST) * 10000 / snapshotPoolGST;
        if (reduction >= 400) return config.slippageTier4();   // 80%
        if (reduction >= 300) return config.slippageTier3();   // 40%
        if (reduction >= 200) return config.slippageTier2();   // 20%
        if (reduction >= 100) return config.slippageTier1();   // 10%
        return config.baseSlippage();                          // 5%
    }

    /// @notice 更新快照基准（Keeper 每日 08:00 调用，由 Deflation 转调）
    /// @dev v7：同时锁定当日计价基准价（snapshotPrice），当日买入/卖出统一按此价
    function updateSnapshot() external onlyDeflation {
        snapshotPoolGST = poolGST;
        snapshotPrice = poolUSDT * 1e18 / poolZYT;
        lastSnapshotAt = block.timestamp;
        emit SnapshotUpdated(snapshotPoolGST, snapshotPrice, block.timestamp);
    }

    /// @notice 入金记账（ZYTMining 调用）：60% 注入底池
    function recordBuy(uint256 usdtIn) external onlyMining {
        poolUSDT += usdtIn;
        poolGST += usdtIn; // GST 1U 折算注入
        emit BuyRecorded(usdtIn, usdtIn);
    }

    /**
     * @notice 卖出结算（ZYTMining 调用）
     * @dev 流程：从 seller 转出 zytGross → 扣滑点（30% 营销 / 30% 分红池 / 40% 销毁）→ 净额换 USDT 给 seller
     */
    function settleSell(address seller, uint256 zytGross) external onlyMining returns (uint256 usdtOut) {
        require(zytGross > 0, "Pool: zero");
        // 1. 转入 ZYT（需 seller 已授权 pool）
        IERC20(zytToken).transferFrom(seller, address(this), zytGross);

        // 2. 滑点档位
        uint256 rate = getCurrentSlippage();
        uint256 slippageAmt = zytGross * rate / 10000;
        uint256 netZyt = zytGross - slippageAmt;

        // 3. 滑点分配 30/30/40
        uint256 toMarket = slippageAmt * 3000 / 10000;
        uint256 toDividend = slippageAmt * 3000 / 10000;
        uint256 toBurn = slippageAmt - toMarket - toDividend;
        if (toMarket > 0) IERC20(zytToken).transfer(config.marketAddress(), toMarket);
        if (toDividend > 0) dividendPool += toDividend;
        if (toBurn > 0) _burnPoolZyt(toBurn);
        emit SlippageCollected(rate, toMarket, toDividend, toBurn);

        // 4. 净额换 USDT（v7：按当日快照锁定价计价，防闪电贷操纵）
        uint256 price = getTradePrice();
        usdtOut = netZyt * price / 1e18;
        require(poolUSDT >= usdtOut, "Pool: insufficient USDT");
        poolUSDT -= usdtOut;
        poolZYT += netZyt;   // 池内 ZYT 增加
        poolGST = poolGST > usdtOut ? poolGST - usdtOut : 0; // GST 减少（计价层抽血）
        if (usdtOut > 0) IERC20(usdt).transfer(seller, usdtOut);
        emit SellSettled(seller, zytGross, usdtOut);
    }

    /// @notice 每日通缩：1% 销毁池内 ZYT + 1% 转入分红池（ZYTDeflation 调用）
    function dailyBurn() external onlyDeflation returns (uint256 burned, uint256 dividend) {
        uint256 totalBurn = poolZYT * config.deflationRate() / 10000; // 2%
        uint256 burnAmt = totalBurn / 2;      // 1% 销毁
        uint256 divAmt = totalBurn - burnAmt; // 1% 分红
        if (burnAmt > 0) {
            _burnPoolZyt(burnAmt);
            burned = burnAmt;
        }
        if (divAmt > 0) {
            // 分红部分从底池划出（账面 poolZYT 同步减少）
            poolZYT = poolZYT > divAmt ? poolZYT - divAmt : 0;
            dividendPool += divAmt;
            dividend = divAmt;
            emit DividendAccrued(divAmt);
        }
    }

    /// @notice 销毁池内 ZYT（滑点 40% / 每日通缩 1%）
    function _burnPoolZyt(uint256 amount) internal {
        uint256 bal = IERC20(zytToken).balanceOf(address(this));
        if (amount > bal) amount = bal;
        if (amount == 0) return;
        IZYTTokenLike(zytToken).burnFrom(address(this), amount);
        poolZYT = poolZYT > amount ? poolZYT - amount : 0;
        emit PoolBurned(amount);
    }

    /// @notice 分红发放（ZYTMining claim 时调用，从池内 ZYT 转出）
    function payoutDividend(address user, uint256 amount) external onlyMining {
        require(dividendPool >= amount, "Pool: div insufficient");
        dividendPool -= amount;
        IERC20(zytToken).transfer(user, amount);
    }
}
