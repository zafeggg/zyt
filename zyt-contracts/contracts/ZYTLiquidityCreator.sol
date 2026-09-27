// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/UniV2.sol";

/**
 * @title ZYTLiquidityCreator（初始建池 + LP 持有 + 通缩执行）
 * @notice v9 双重身份：
 *         1. 初始建池：铸造 21 亿 ZYT（一次性的全量供应）+ 收取 2.1 万 USDT，
 *            直接创建 ZYT/USDT 真实 pair 并注入，LP 凭证由本合约持有
 *         2. 通缩执行器：每日被 PoolManager 调用 skimDeflation，报销 2% LP
 *            （removeLiquidity）并把抽出的 ZYT/USDT 转交 Pool 处理（U 回池 sync）
 *         安全设计：
 *         - 常态出口 = skimDeflation（仅 Pool 可调，按剩余凭证 2% 递减，约 299 天自然耗尽）
 *         - owner 出口 = withdrawLp（多签可提取，对应「不锁仓」运营口径）
 *           ⚠️ 提取会同步减少 skimDeflation 的可用 LP 基数，提空则通缩停摆
 *         - 本合约须加入 ZYTToken 白名单（系统路径豁免）
 */
contract ZYTLiquidityCreator is Ownable, ReentrancyGuard {
    address public immutable zyt;
    address public immutable usdt;
    address public immutable factory;
    address public immutable blackHole;
    address public pair;                // ZYT/USDT 交易对（建池后固化）
    address public poolManager;         // ZYTPoolManager（唯一 skimDeflation 调用方）

    // 本合约当前持有的 LP 凭证量。恒等于 IERC20(pair).balanceOf(address(this))，
    // 由 createInitialPool / skimDeflation / withdrawLp 三处同步维护。
    uint256 public lockedLiquidity;
    uint256 public totalZytSeeded;
    uint256 public totalUsdtSeeded;
    uint256 public totalDeflationZytOut;
    uint256 public totalDeflationUsdtOut;
    uint256 public totalLpWithdrawn;    // 累计由 owner 提取的 LP 量

    bool public initialized;

    event InitialPoolCreated(address indexed pair, uint256 zytIn, uint256 usdtIn, uint256 liquidity);
    event PoolManagerChanged(address indexed poolManager);
    event DeflationSkimmed(uint256 lpBurned, uint256 zytAmt, uint256 usdtAmt);
    event LpWithdrawn(address indexed to, uint256 amount);

    constructor(
        address zyt_,
        address usdt_,
        address factory_,
        address blackHole_
    ) Ownable(msg.sender) {
        require(
            zyt_ != address(0) && usdt_ != address(0) &&
            factory_ != address(0) && blackHole_ != address(0),
            "Creator: zero addr"
        );
        zyt = zyt_;
        usdt = usdt_;
        factory = factory_;
        blackHole = blackHole_;
    }

    function setPoolManager(address _pool) external onlyOwner {
        require(_pool != address(0), "Creator: zero addr");
        poolManager = _pool;
        emit PoolManagerChanged(_pool);
    }

    /**
     * @notice 初始建池（部署时手动调用一次）：
     *         铸出全量 ZYT（21 亿）+ 收取初始 USDT（2.1 万）→ 创建/获取 pair →
     *         两侧注入 → LP 由本合约持有（owner 可提取；常态用于每日 2% 递减式通缩报销）
     * @param zytAmount 全量 ZYT（21 亿枚）
     * @param usdtAmount 初始 USDT（2.1 万枚；调用方需先 approve）
     * @return pairAddr 交易对地址
     */
    function createInitialPool(uint256 zytAmount, uint256 usdtAmount)
        external
        onlyOwner
        nonReentrant
        returns (address pairAddr)
    {
        require(!initialized, "Creator: initialized");
        require(zytAmount > 0 && usdtAmount > 0, "Creator: zero amount");

        // 1. 全量铸造 ZYT 到本合约（此后无任何 mint 路径，总供应恒减）
        IZYTTokenMint(zyt).mintTo(address(this), zytAmount);

        // 2. 创建或获取 pair
        pairAddr = IUniswapV2Factory(factory).getPair(zyt, usdt);
        if (pairAddr == address(0)) {
            pairAddr = IUniswapV2Factory(factory).createPair(zyt, usdt);
        }
        pair = pairAddr;
        initialized = true;

        // 3. 两侧注入
        IERC20(usdt).transferFrom(msg.sender, address(this), usdtAmount);
        IERC20(zyt).transfer(pairAddr, zytAmount);
        IERC20(usdt).transfer(pairAddr, usdtAmount);

        // 4. LP 铸给本合约，永久锁仓
        uint256 liquidity = IUniswapV2Pair(pairAddr).mint(address(this));
        lockedLiquidity = liquidity;
        totalZytSeeded = zytAmount;
        totalUsdtSeeded = usdtAmount;

        emit InitialPoolCreated(pairAddr, zytAmount, usdtAmount, liquidity);
    }

    /**
     * @notice 每日通缩报销（仅 ZYTPoolManager 调用；Pool 侧处于 swapGate 期间）
     * @dev 报销 rateBps 基点的锁仓 LP → removeLiquidity → 两侧资产转交 Pool。
     *      Pool 把 U 直接转回 pair + sync（净效果只减池内 ZYT），ZYT 按 1% 烧 + 1% 分红处理。
     *      AUDIT-1：LP 耗尽（withdrawLp 提空或自然衰减至 1 wei 以下）时返回 (0,0)
     *      而非 revert——否则 dailySnapshot 整笔回滚，快照价/分红/全网算力记录全部停摆。
     * @return zytAmt 抽出的 ZYT 数量
     * @return usdtAmt 抽出的 USDT 数量
     */
    function skimDeflation(uint256 rateBps)
        external
        nonReentrant
        returns (uint256 zytAmt, uint256 usdtAmt)
    {
        require(msg.sender == poolManager, "Creator: not pool");
        require(rateBps > 0 && rateBps <= 200, "Creator: bad rate");
        uint256 lpBal = IERC20(pair).balanceOf(address(this));
        uint256 burnAmt = lpBal * rateBps / 10000;
        // AUDIT-1：LP 不足以报销最小单位（提空或极端衰减）→ 静默返回。
        // 通缩停摆但 dailySnapshot 链继续（updateSnapshot/dailyRelease/recordDailyDividend 正常执行）。
        if (burnAmt == 0) return (0, 0);

        // V2 burn：先把 LP 转回 pair，再按比例取回两侧资产
        IERC20(pair).transfer(pair, burnAmt);
        (uint256 a0, uint256 a1) = IUniswapV2Pair(pair).burn(address(this));
        lockedLiquidity -= burnAmt;

        // 按 pair 内排序归位（ZYT/USDT）
        if (IUniswapV2Pair(pair).token0() == zyt) {
            zytAmt = a0;
            usdtAmt = a1;
        } else {
            zytAmt = a1;
            usdtAmt = a0;
        }

        // 转交 Pool 处理（U 回池 sync、ZYT 烧/分红）
        if (zytAmt > 0) {
            IERC20(zyt).transfer(msg.sender, zytAmt);
            totalDeflationZytOut += zytAmt;
        }
        if (usdtAmt > 0) {
            IERC20(usdt).transfer(msg.sender, usdtAmt);
            totalDeflationUsdtOut += usdtAmt;
        }

        emit DeflationSkimmed(burnAmt, zytAmt, usdtAmt);
    }

    /**
     * @notice owner 提取 LP 凭证（对应「不锁仓」运营口径）
     * @dev 提取后 lockedLiquidity 同步递减，skimDeflation 的可用基数随之减少。
     *      提空则 skimDeflation 的 require(burnAmt > 0) 失败，每日通缩停摆，属预期行为。
     *      上线后 owner 归 W2 治理多签，单方无法提取。
     * @param to 接收地址
     * @param amount 提取的 LP 数量
     */
    function withdrawLp(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Creator: zero addr");
        require(amount > 0, "Creator: zero amount");
        uint256 bal = IERC20(pair).balanceOf(address(this));
        require(amount <= bal, "Creator: insufficient lp");
        // 用「实际余额 − 提取量」重算，避免历史不同步导致下溢
        lockedLiquidity = bal - amount;
        totalLpWithdrawn += amount;
        require(IERC20(pair).transfer(to, amount), "Creator: lp out");
        emit LpWithdrawn(to, amount);
    }

    /// @notice 合约当前持有的 LP 读数（前端展示；语义为「持有量」，不再代表「已锁定」）
    function lockedLpOf(address) external view returns (uint256) {
        return lockedLiquidity;
    }
}

interface IZYTTokenMint {
    function mintTo(address to, uint256 amount) external;
}
