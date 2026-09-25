// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ZYTConfig
 * @notice 全局参数中心（v9 口径，2026-09-24 拍板）。
 *         v9 范式：弃 GST，USDT↔ZYT 单币直换，真实 PancakeSwap V2 pair 为唯一底池。
 *         - 删除 GST 相关参数与地址
 *         - 删除买入白名单（v9 买币门槛 = 阶段门控 + 买额 1:1）
 *         - 新增 swapFeeBps（Pancake V2 0.25% 交易费）、deflationLpRate（每日报销初始 LP 2%）
 *         部署后 owner 应转移给 Gnosis Safe 多签。
 */
contract ZYTConfig is Ownable {
    // ---------- 数值参数（基点 = 万分比） ----------
    uint256 public zytMaxSupply = 2_100_000_000e18; // 21 亿（初始底池全量，一次铸出）
    uint256 public minDeposit = 100e18;             // 最小入金 100U
    uint256 public maxDeposit = 500e18;             // 单笔上限 500U（可调）
    uint256 public marketingRate = 4000;            // 40% 生态（30% 代数 + 10% 技术）
    uint256 public poolRate = 6000;                 // 60% 组 LP 凭证销毁
    uint256 public powerRate = 10000;               // 算力倍率 1.0（1000U → 1000 算力）
    uint256 public dailyCompoundRate = 100;         // 日复利 1%
    uint256 public dynamicQuotaMul = 5;             // 动态额度 = 入金 × 5（加速释放载体）
    uint256 public staticExitMul = 2;               // 静态 2 倍出局
    uint256 public deflationRate = 200;             // 每日通缩 2%（1% 销毁 + 1% 分红）
    uint256 public deflationFloor = 5_000_000e18;   // 通缩至 500 万枚停止
    uint256 public baseSlippage = 500;              // 基础滑点 5%
    uint256 public slippageTier1 = 1000;            // 池U较峰值减 ≥1% → 10%
    uint256 public slippageTier2 = 2000;            // ≥2% → 20%
    uint256 public slippageTier3 = 4000;            // ≥3% → 40%
    uint256 public slippageTier4 = 8000;            // ≥4% → 80%
    uint256 public transferSlippage = 1000;         // 转账滑点 10%（转账视同卖出）
    uint256 public poolStage1USDT = 10_000_000e18;  // 阶段1 < 1000 万 U 只卖
    uint256 public poolStage2USDT = 20_000_000e18;  // 阶段2 < 2000 万 U 买额 1:1
    uint256 public snapshotTime = 28860;            // 08:01 北京（秒），keeper cron 对齐
    uint256 public refLevel1Rate = 700;             // 1 代 7%
    uint256 public refLevel2Rate = 200;             // 2-10 代各 2%
    uint256 public refLevel3Rate = 50;              // 11-20 代各 0.5%
    uint256 public refTechnicalRate = 1000;         // 技术运维 10%
    uint256 public refDepth = 20;                   // 推荐最大深度 20 代
    uint256 public swapFeeBps = 25;                 // Pancake V2 交易费 0.25%（getAmountOut 用）
    uint256 public deflationLpRate = 200;           // 每日报销初始 LP 凭证 2%
    uint256 public buyQuotaRate = 10000;            // 买额 = 入金 1:1（阶段 2 用）
    // V9：总供应保险丝。ZYT 仅在建池时由 Creator 铸出一次（21 亿），此后无任何 mint 路径
    uint256 public totalSupplyCap = 2_100_000_000e18;

    // ---------- 地址 ----------
    address public marketAddress;       // 营销地址（Gnosis Safe 多签）
    address public technicalAddress;    // 技术运维地址（多签）
    address public blackHole;           // 黑洞地址（销毁 + 增量 LP 销毁）
    address public usdt;                // BSC 官方 USDT
    address public factory;             // PancakeSwap V2 Factory（建/查 pair）
    address public pair;                // ZYT/USDT 交易对
    address public zyt;                 // ZYTToken
    address public pool;                // ZYTPoolManager（唯一 swap 通道）
    address public mining;              // ZYTMining（入金/买/卖主入口）
    address public deflation;           // ZYTDeflation
    address public forceSell;           // ZYTForceSell
    address public referral;            // ZYTReferral
    address public creator;             // ZYTLiquidityCreator（初始建池 + LP 锁仓）
    address public keeperAddress;       // 链下 Keeper 触发地址

    bool public paused;

    event Paused(address account);
    event Unpaused(address account);
    event ParamSet(string indexed key, uint256 value);
    event AddressSet(string indexed key, address value);

    constructor() Ownable(msg.sender) {}

    modifier whenNotPaused() {
        require(!paused, "ZYTConfig: paused");
        _;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /** @notice 设置数值参数（多签调用；费率类基点参数强制 ≤ 10000） */
    function setUint(string calldata key, uint256 value) external onlyOwner {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("zytMaxSupply")) zytMaxSupply = value;
        else if (k == keccak256("minDeposit")) minDeposit = value;
        else if (k == keccak256("maxDeposit")) maxDeposit = value;
        else if (k == keccak256("marketingRate")) { _requireRate(value); marketingRate = value; }
        else if (k == keccak256("poolRate")) { _requireRate(value); poolRate = value; }
        else if (k == keccak256("powerRate")) { _requireRate(value); powerRate = value; }
        else if (k == keccak256("dailyCompoundRate")) { _requireRate(value); dailyCompoundRate = value; }
        else if (k == keccak256("dynamicQuotaMul")) dynamicQuotaMul = value;
        else if (k == keccak256("staticExitMul")) staticExitMul = value;
        else if (k == keccak256("deflationRate")) { _requireRate(value); deflationRate = value; }
        else if (k == keccak256("deflationFloor")) deflationFloor = value;
        else if (k == keccak256("baseSlippage")) { _requireRate(value); baseSlippage = value; }
        else if (k == keccak256("slippageTier1")) { _requireRate(value); slippageTier1 = value; }
        else if (k == keccak256("slippageTier2")) { _requireRate(value); slippageTier2 = value; }
        else if (k == keccak256("slippageTier3")) { _requireRate(value); slippageTier3 = value; }
        else if (k == keccak256("slippageTier4")) { _requireRate(value); slippageTier4 = value; }
        else if (k == keccak256("transferSlippage")) { _requireRate(value); transferSlippage = value; }
        else if (k == keccak256("poolStage1USDT")) poolStage1USDT = value;
        else if (k == keccak256("poolStage2USDT")) poolStage2USDT = value;
        else if (k == keccak256("snapshotTime")) snapshotTime = value;
        else if (k == keccak256("refLevel1Rate")) { _requireRate(value); refLevel1Rate = value; }
        else if (k == keccak256("refLevel2Rate")) { _requireRate(value); refLevel2Rate = value; }
        else if (k == keccak256("refLevel3Rate")) { _requireRate(value); refLevel3Rate = value; }
        else if (k == keccak256("refTechnicalRate")) { _requireRate(value); refTechnicalRate = value; }
        else if (k == keccak256("refDepth")) refDepth = value;
        else if (k == keccak256("swapFeeBps")) { _requireRate(value); swapFeeBps = value; }
        else if (k == keccak256("deflationLpRate")) { _requireRate(value); deflationLpRate = value; }
        else if (k == keccak256("buyQuotaRate")) { _requireRate(value); buyQuotaRate = value; }
        else if (k == keccak256("totalSupplyCap")) totalSupplyCap = value;
        else revert("ZYTConfig: unknown key");
        emit ParamSet(key, value);
    }

    /// @notice 费率类基点参数统一校验（>10000 会破坏资金分配/滑点计算）
    function _requireRate(uint256 value) private pure {
        require(value <= 10000, "ZYTConfig: rate > 10000");
    }

    /** @notice 设置地址参数（多签调用） */
    function setAddress(string calldata key, address value) external onlyOwner {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("marketAddress")) marketAddress = value;
        else if (k == keccak256("technicalAddress")) technicalAddress = value;
        else if (k == keccak256("blackHole")) blackHole = value;
        else if (k == keccak256("usdt")) usdt = value;
        else if (k == keccak256("factory")) factory = value;
        else if (k == keccak256("pair")) pair = value;
        else if (k == keccak256("zyt")) zyt = value;
        else if (k == keccak256("pool")) pool = value;
        else if (k == keccak256("mining")) mining = value;
        else if (k == keccak256("deflation")) deflation = value;
        else if (k == keccak256("forceSell")) forceSell = value;
        else if (k == keccak256("referral")) referral = value;
        else if (k == keccak256("creator")) creator = value;
        else if (k == keccak256("keeperAddress")) keeperAddress = value;
        else revert("ZYTConfig: unknown key");
        emit AddressSet(key, value);
    }

    /** @notice 推荐层级奖励率（1 代 7% / 2-10 代 2% / 11-20 代 0.5%） */
    function refRateForLevel(uint256 level) public view returns (uint256) {
        if (level == 1) return refLevel1Rate;
        if (level <= 10) return refLevel2Rate;
        if (level <= refDepth) return refLevel3Rate;
        return 0;
    }
}
