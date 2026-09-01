// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ZYTConfig
 * @notice 全局参数中心（方案 v7 冻结版）。部署后 owner 应转移给 Gnosis Safe 多签。
 *         所有数值参数与关键地址集中管理，满足「参数可调」需求（不采用 UUPS 升级）。
 */
contract ZYTConfig is Ownable {
    // ---------- 数值参数（基点 = 万分比） ----------
    uint256 public gstMaxSupply = 333_000_000e18;   // 3.33 亿
    uint256 public zytMaxSupply = 2_100_000_000e18; // 21 亿
    uint256 public minDeposit = 100e18;             // 最小入金 100U
    uint256 public maxDeposit = 500e18;             // 最大入金 500U（参数可调）
    uint256 public marketingRate = 4000;            // 40% 营销/生态
    uint256 public poolRate = 6000;                 // 60% 注入底池
    uint256 public powerRate = 10000;               // 算力倍率 1.0（1000U → 1000 算力）
    uint256 public dailyCompoundRate = 100;         // 日复利 1%
    uint256 public dynamicQuotaMul = 5;             // 动态收益额度 = 入金 × 5
    uint256 public staticExitMul = 2;               // 静态 2 倍出局
    uint256 public deflationRate = 200;             // 每日通缩 2%
    uint256 public deflationFloor = 5_000_000e18;   // 通缩至 500 万枚停止
    uint256 public baseSlippage = 500;              // 基础滑点 5%
    uint256 public slippageTier1 = 1000;            // 底池 GST 减少 ≥1% → 10%
    uint256 public slippageTier2 = 2000;            // ≥2% → 20%
    uint256 public slippageTier3 = 4000;            // ≥3% → 40%
    uint256 public slippageTier4 = 8000;            // ≥4% → 80%
    uint256 public transferSlippage = 1000;         // 转账滑点 10%（转账视同卖出）
    uint256 public poolStage1USDT = 10_000_000e18;  // 阶段1 < 1000 万 U
    uint256 public poolStage2USDT = 20_000_000e18;  // 阶段2 < 2000 万 U
    uint256 public snapshotTime = 28800;            // 08:00 UTC+8（秒），与 Ave 同步
    uint256 public refLevel1Rate = 700;             // 1 代 7%
    uint256 public refLevel2Rate = 200;             // 2-10 代各 2%
    uint256 public refLevel3Rate = 50;              // 11-20 代各 0.5%
    uint256 public refTechnicalRate = 1000;         // 技术运维 10%
    uint256 public refDepth = 20;                   // 推荐最大深度 20 代
    // V7：总供应保险丝上限（防无限增发；默认 1000 亿 = 初始池 21 亿 + 增发空间，多签可调）
    // 语义：zytMaxSupply = 初始底池量（21 亿），totalSupplyCap = mint 硬顶
    uint256 public totalSupplyCap = 100_000_000_000e18;

    // ---------- 开关（v7 新增） ----------
    bool public buyWhitelistEnabled = true;         // 买入白名单开关：全程启用（防闪电贷）

    // ---------- 地址 ----------
    address public marketAddress;       // 营销地址（Gnosis Safe 多签）
    address public technicalAddress;    // 技术运维地址（多签）
    address public blackHole;           // 黑洞地址
    address public router;              // PancakeSwap V2 Router
    address public usdt;                // BSC 官方 USDT
    address public gst;                 // GSTToken
    address public zyt;                 // ZYTToken
    address public pool;                // ZYTPoolManager
    address public mining;              // ZYTMining
    address public deflation;           // ZYTDeflation
    address public forceSell;           // ZYTForceSell
    address public referral;            // ZYTReferral
    address public keeperAddress;       // 链下 Keeper 触发地址（V4：快照/通缩仅 keeper 或 owner 可调）

    bool public paused;

    event Paused(address account);
    event Unpaused(address account);
    event ParamSet(string indexed key, uint256 value);
    event AddressSet(string indexed key, address value);
    event ParamBoolSet(string indexed key, bool value);

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

    /** @notice 批量设置数值参数（多签调用；V10：费率类基点参数强制 ≤ 10000） */
    function setUint(string calldata key, uint256 value) external onlyOwner {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("gstMaxSupply")) gstMaxSupply = value;
        else if (k == keccak256("zytMaxSupply")) zytMaxSupply = value;
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
        else if (k == keccak256("totalSupplyCap")) totalSupplyCap = value;
        else revert("ZYTConfig: unknown key");
        emit ParamSet(key, value);
    }

    /// @notice V10：费率类基点参数统一校验（>10000 会破坏资金分配/滑点计算）
    function _requireRate(uint256 value) private pure {
        require(value <= 10000, "ZYTConfig: rate > 10000");
    }

    /** @notice 批量设置地址参数（多签调用） */
    function setAddress(string calldata key, address value) external onlyOwner {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("marketAddress")) marketAddress = value;
        else if (k == keccak256("technicalAddress")) technicalAddress = value;
        else if (k == keccak256("blackHole")) blackHole = value;
        else if (k == keccak256("router")) router = value;
        else if (k == keccak256("usdt")) usdt = value;
        else if (k == keccak256("gst")) gst = value;
        else if (k == keccak256("zyt")) zyt = value;
        else if (k == keccak256("pool")) pool = value;
        else if (k == keccak256("mining")) mining = value;
        else if (k == keccak256("deflation")) deflation = value;
        else if (k == keccak256("forceSell")) forceSell = value;
        else if (k == keccak256("referral")) referral = value;
        else if (k == keccak256("keeperAddress")) keeperAddress = value;
        else revert("ZYTConfig: unknown key");
        emit AddressSet(key, value);
    }

    /** @notice 买入白名单开关（多签调用；默认 true 全程启用） */
    function setBuyWhitelistEnabled(bool enabled) external onlyOwner {
        buyWhitelistEnabled = enabled;
        emit ParamBoolSet("buyWhitelistEnabled", enabled);
    }

    /** @notice 推荐层级奖励率（1 代 7% / 2-10 代 2% / 11-20 代 0.5%） */
    function refRateForLevel(uint256 level) public view returns (uint256) {
        if (level == 1) return refLevel1Rate;
        if (level <= 10) return refLevel2Rate;
        if (level <= refDepth) return refLevel3Rate;
        return 0;
    }
}
