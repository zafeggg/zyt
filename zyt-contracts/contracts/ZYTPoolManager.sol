// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ZYTConfig.sol";
import "./interfaces/UniV2.sol";

/**
 * @title ZYTPoolManager
 * @notice v9 底池管理：真实 PancakeSwap V2 ZYT/USDT pair 为唯一底池，
 *         本合约是唯一交易通道（gate 模式，ZYTToken 强制校验）。
 *         - 入金 60%：一半 USDT 换 ZYT（真实 swap），另一半与换得 ZYT 按最优比例组 LP，
 *           LP 凭证全额转黑洞销毁（NBDAO buyAndAddLP 模式的真池实现）
 *         - 买入：USDT → pair.swap → ZYT 直达用户（阶段 1 禁买；阶段 2 由 Mining 校验买额）
 *         - 卖出：ZYT 滑点档位（30% 营销 / 30% 分红池 / 40% 销毁）→ 净额 swap → USDT 给用户
 *         - 滑点档位基准（v9 拍板）：max(初始池U, 历史峰值池U)；当前池 U 较基准减 1/2/3/4% → 10/20/40/80%
 *         - 每日通缩：锁仓合约报销 2% 初始 LP → 抽出 ZYT_a/U_b；ZYT_a 1% 烧 + 1% 分红，
 *           U_b 直接转回 pair 并 sync（净效果只减池内 ZYT，池 U 不变，价格单边上行）
 *         - swapGate：swap 前置位/后清位，ZYTToken 据此放行「流出 pair」路径
 */
contract ZYTPoolManager is Ownable, ReentrancyGuard {
    ZYTConfig public config;
    address public zytToken;
    address public usdt;
    address public pair;        // ZYT/USDT 交易对
    address public locker;      // 锁仓合约（= ZYTLiquidityCreator，持初始 LP）
    address public mining;      // ZYTMining（入金/买/卖主入口）
    address public deflation;   // ZYTDeflation

    bool public swapGate;       // 交易闸门（ZYTToken 流出 pair 路径校验）
    bool public zytIsToken0;    // pair 内排序标记

    // ---------- 快照与基准 ----------
    uint256 public snapshotPrice;       // 每日 08:01 快照锁定价（记账：转账计值/强卖/额度）
    uint256 public snapshotPoolUSDT;    // 每日快照的池 USDT（统计）
    uint256 public lastSnapshotAt;
    uint256 public peakPoolUSDT;        // 历史峰值池 USDT（滑点档位基准，max(初始, 峰值)）
    uint256 public totalLpBurned;       // 累计销毁 LP（入金 60% 凭证）

    uint256 public dividendPoolZyt;     // 分红池（ZYT）：通缩 1% + 卖币滑点 30% + 转账税 30%
    uint256 public reserveUSDT;         // 自持 USDT（组 LP 残留，兑付兜底储备）

    event LiquidityInjected(address indexed user, uint256 usdtIn, uint256 lpBurned);
    event Bought(address indexed user, uint256 usdtIn, uint256 zytOut);
    event Sold(address indexed seller, uint256 zytGross, uint256 slip, uint256 usdtOut);
    event SnapshotUpdated(uint256 price, uint256 poolUSDT, uint256 time);
    event Deflated(uint256 burned, uint256 dividend, uint256 usdtResynced);
    event SlippageCollected(uint256 rate, uint256 toMarket, uint256 toDividend, uint256 toBurn);
    event DividendAccrued(uint256 amount);

    modifier onlyMining() {
        require(msg.sender == mining, "Pool: only mining");
        _;
    }

    modifier onlyDeflation() {
        require(msg.sender == deflation, "Pool: only deflation");
        _;
    }

    modifier gated() {
        swapGate = true;
        _;
        swapGate = false;
    }

    constructor(address config_, address zytToken_, address usdt_) Ownable(msg.sender) {
        config = ZYTConfig(config_);
        zytToken = zytToken_;
        usdt = usdt_;
    }

    function setPair(address _pair) external onlyOwner {
        require(_pair != address(0), "Pool: zero pair");
        pair = _pair;
        zytIsToken0 = IUniswapV2Pair(_pair).token0() == zytToken;
        // 初始峰值 = 建池后的池 USDT（2.1 万）
        (, uint256 uRes) = _reserves();
        if (peakPoolUSDT < uRes) peakPoolUSDT = uRes;
    }

    function setLocker(address _locker) external onlyOwner {
        locker = _locker;
    }

    function setMining(address _mining) external onlyOwner {
        mining = _mining;
    }

    function setDeflation(address _deflation) external onlyOwner {
        deflation = _deflation;
    }

    // ---------- 视图 ----------

    /// @notice pair 储备（zytReserve, usdtReserve）
    function _reserves() internal view returns (uint256 zRes, uint256 uRes) {
        (uint112 r0, uint112 r1, ) = IUniswapV2Pair(pair).getReserves();
        if (zytIsToken0) {
            return (uint256(r0), uint256(r1));
        }
        return (uint256(r1), uint256(r0));
    }

    function getReservesPublic() external view returns (uint256 zytReserve, uint256 usdtReserve) {
        return _reserves();
    }

    function poolZYT() external view returns (uint256) {
        (uint256 zRes, ) = _reserves();
        return zRes;
    }

    function poolUSDT() external view returns (uint256) {
        (, uint256 uRes) = _reserves();
        return uRes;
    }

    /// @notice 实时价（U per ZYT，1e18 精度）
    function getPrice() public view returns (uint256) {
        (uint256 zRes, uint256 uRes) = _reserves();
        if (zRes == 0) return 0;
        return uRes * 1e18 / zRes;
    }

    /// @notice 记账价（当日 08:01 快照锁定价；转账计值/强卖/额度折算统一用）
    function getTradePrice() external view returns (uint256) {
        if (snapshotPrice == 0) return getPrice();
        return snapshotPrice;
    }

    /// @notice 阶段门控：1 只卖不买 / 2 买额 1:1 / 3 自由（度量 = 池 USDT 余额）
    function getStage() public view returns (uint256) {
        (, uint256 uRes) = _reserves();
        if (uRes < config.poolStage1USDT()) return 1;
        if (uRes < config.poolStage2USDT()) return 2;
        return 3;
    }

    /// @notice 当前滑点档位（基点）：池 USDT 较峰值基准的减少比例分档
    function getCurrentSlippage() public view returns (uint256) {
        (, uint256 uRes) = _reserves();
        if (peakPoolUSDT == 0 || uRes >= peakPoolUSDT) return config.baseSlippage();
        uint256 reduction = (peakPoolUSDT - uRes) * 10000 / peakPoolUSDT;
        if (reduction >= 400) return config.slippageTier4();   // 80%
        if (reduction >= 300) return config.slippageTier3();   // 40%
        if (reduction >= 200) return config.slippageTier2();   // 20%
        if (reduction >= 100) return config.slippageTier1();   // 10%
        return config.baseSlippage();                          // 5%
    }

    // ---------- 入金 60% 处置 ----------

    /**
     * @notice 入金 60% 注入流动性：一半真实 swap 买 ZYT，另一半与 ZYT 按最优比例组 LP，
     *         LP 凭证全额转黑洞销毁。仅 ZYTMining 调用（Mining 已完成 40% 直发与校验）。
     */
    function injectLiquidity(uint256 usdtIn) external onlyMining nonReentrant gated returns (uint256 lpBurned) {
        require(pair != address(0) && locker != address(0), "Pool: pair/locker unset");
        require(usdtIn > 0, "Pool: zero");
        uint256 half = usdtIn / 2;
        require(half > 0, "Pool: too small");

        // 1. 一半 USDT 真实换 ZYT（swap 输出到本合约）
        uint256 zytC = _swapUsdtForZyt(half, address(this));

        // 2. 另一半 USDT 与 ZYT 按最优比例组 LP（V2 公式，不经 Router）
        uint256 usdtLeft = usdtIn - half;
        uint256 lp;
        uint256 zytUsed;
        (lp, zytUsed) = _addLiquidity(usdtLeft, zytC, address(this));

        // 3. 组 LP 未用尽的 ZYT 残留转入分红池（防止账面漂移）
        uint256 residue = zytC - zytUsed;
        if (residue > 0) {
            dividendPoolZyt += residue;
            emit DividendAccrued(residue);
        }

        // 4. LP 凭证销毁（「60% 注入流动性池并销毁」的落实）
        lpBurned = lp;
        if (lp > 0) {
            IERC20(pair).transfer(config.blackHole(), lp);
            totalLpBurned += lp;
        }
        emit LiquidityInjected(msg.sender, usdtIn, lp);
    }

    // ---------- 买入 / 卖出 ----------

    /**
     * @notice 买入：USDT → pair → ZYT 直达用户。仅 ZYTMining 调用（阶段与买额在 Mining 校验）。
     * @dev USDT 须已由 Mining 转入本合约。
     */
    function buyFor(address user, uint256 usdtIn) external onlyMining nonReentrant gated returns (uint256 zytOut) {
        require(getStage() != 1, "Pool: buy disabled in stage1");
        require(user != address(0) && usdtIn > 0, "Pool: zero");
        // 先读储备再转币（getAmountOut 的 reserveIn 必须不含 amountIn，peak 不得双重计入）
        (uint256 zRes, uint256 uResBefore) = _reserves();
        IERC20(usdt).transfer(pair, usdtIn);
        zytOut = UniV2Lib.getAmountOut(usdtIn, uResBefore, zRes, config.swapFeeBps());
        require(zytOut > 0, "Pool: zero out");
        _pairSwap(0, zytOut, user);
        _updatePeak(uResBefore + usdtIn);
        emit Bought(user, usdtIn, zytOut);
    }

    /**
     * @notice 卖出：ZYT 滑点分配后净额换 USDT。仅 ZYTMining 调用。
     * @dev ZYT 须已由本合约 transferFrom 用户（卖闸：msg.sender = pool）。
     * @return usdtOut 净 USDT 输出（滑点后）
     */
    function sellFor(address user, uint256 zytGross) external onlyMining nonReentrant gated returns (uint256 usdtOut) {
        require(zytGross > 0, "Pool: zero");
        (uint256 zRes, uint256 uRes) = _reserves();

        // 0. 从用户拉入 ZYT（msg.sender = pool，卖闸放行；to = pool 白名单 → 记账/强卖/统计在 Token 层完成）
        IERC20(zytToken).transferFrom(user, address(this), zytGross);

        // 1. 滑点档位 + 分配（30% 营销 / 30% 分红池 / 40% 销毁）
        uint256 rate = getCurrentSlippage();
        uint256 slip = zytGross * rate / 10000;
        uint256 netZyt = zytGross - slip;
        uint256 slipMarket = slip * 3000 / 10000;
        uint256 slipDiv = slip * 3000 / 10000;
        uint256 slipBurn = slip - slipMarket - slipDiv;
        if (slipMarket > 0) IERC20(zytToken).transfer(config.marketAddress(), slipMarket);
        if (slipDiv > 0) {
            dividendPoolZyt += slipDiv;
            emit DividendAccrued(slipDiv);
        }
        if (slipBurn > 0) IZYTTokenBurn(zytToken).burnFrom(address(this), slipBurn);
        emit SlippageCollected(rate, slipMarket, slipDiv, slipBurn);

        // 2. 净额真实 swap（ZYT 净额进 pair，USDT 输出到本合约再转用户）
        IERC20(zytToken).transfer(pair, netZyt);
        usdtOut = UniV2Lib.getAmountOut(netZyt, zRes, uRes, config.swapFeeBps());
        require(usdtOut > 0, "Pool: zero out");
        _pairSwap(usdtOut, 0, address(this));
        IERC20(usdt).transfer(user, usdtOut);

        emit Sold(user, zytGross, slip, usdtOut);
    }

    /// @notice 转账税 30% 分红入池（仅 ZYTToken 调用，ZYT 已转入本合约）
    function accrueDividendZyt(uint256 amount) external {
        require(msg.sender == zytToken, "Pool: only token");
        if (amount > 0) {
            dividendPoolZyt += amount;
            emit DividendAccrued(amount);
        }
    }

    // ---------- 每日快照与通缩 ----------

    /// @notice 更新快照（Keeper 每日 08:01，由 Deflation 转调）
    function updateSnapshot() external onlyDeflation {
        (, uint256 uRes) = _reserves();
        snapshotPrice = getPrice();
        snapshotPoolUSDT = uRes;
        if (peakPoolUSDT < uRes) peakPoolUSDT = uRes;
        lastSnapshotAt = block.timestamp;
        emit SnapshotUpdated(snapshotPrice, uRes, block.timestamp);
    }

    /**
     * @notice 每日通缩：锁仓合约报销 2% 初始 LP → 抽出 ZYT_a/U_b。
     *         ZYT_a：1% 烧黑洞 + 1% 进分红池；U_b：直接转回 pair + sync
     *         （净效果只减池内 ZYT，池 U 不变，价格单边上行，不干扰滑点档位）。
     */
    function deflate() external onlyDeflation nonReentrant gated returns (uint256 burned, uint256 dividend) {
        (uint256 zRes, ) = _reserves();
        if (zRes <= config.deflationFloor()) return (0, 0);
        require(locker != address(0), "Pool: locker unset");

        // 1. 锁仓合约报销 LP 并把两侧资产转入本合约
        (uint256 zytA, uint256 usdtB) = ILocker(locker).skimDeflation(config.deflationLpRate());

        // 2. U 回池（sync，不组 LP）
        uint256 resynced = 0;
        if (usdtB > 0) {
            IERC20(usdt).transfer(pair, usdtB);
            IUniswapV2Pair(pair).sync();
            resynced = usdtB;
        }

        // 3. ZYT 分配：1% 烧 + 1% 分红
        if (zytA > 0) {
            uint256 burnPart = zytA / 2;
            uint256 divPart = zytA - burnPart;
            if (burnPart > 0) {
                IZYTTokenBurn(zytToken).burnFrom(address(this), burnPart);
                burned = burnPart;
            }
            if (divPart > 0) {
                dividendPoolZyt += divPart;
                dividend = divPart;
                emit DividendAccrued(divPart);
            }
        }
        emit Deflated(burned, dividend, resynced);
    }

    /// @notice 分红发放（ZYT，ZYTMining claimDividend 调用）
    function payoutDividend(address user, uint256 amount) external onlyMining {
        require(dividendPoolZyt >= amount, "Pool: div insufficient");
        dividendPoolZyt -= amount;
        IERC20(zytToken).transfer(user, amount);
    }

    // ---------- 内部 ----------

    /// @notice USDT → ZYT 真实 swap（先转入 pair 再 swap）
    function _swapUsdtForZyt(uint256 usdtIn, address to) internal returns (uint256 zytOut) {
        (uint256 zRes, uint256 uRes) = _reserves();
        zytOut = UniV2Lib.getAmountOut(usdtIn, uRes, zRes, config.swapFeeBps());
        require(zytOut > 0, "Pool: zero out");
        IERC20(usdt).transfer(pair, usdtIn);
        _pairSwap(0, zytOut, to);
    }

    /// @notice V2 addLiquidity（不经 Router：按最优比例转两侧进 pair 再 mint）
    /// @return liquidity LP 数量；zytUsed 实际入池的 ZYT（残留留在本合约由调用方处置）
    function _addLiquidity(uint256 usdtAmt, uint256 zytAmt, address to)
        internal
        returns (uint256 liquidity, uint256 zytUsed)
    {
        (uint256 zRes, uint256 uRes) = _reserves();
        uint256 zytOpt = zRes > 0 ? UniV2Lib.quote(usdtAmt, uRes, zRes) : zytAmt;
        uint256 usdtIn2;
        if (zytAmt >= zytOpt) {
            usdtIn2 = usdtAmt;
            zytUsed = zytOpt;
        } else {
            zytUsed = zytAmt;
            usdtIn2 = UniV2Lib.quote(zytAmt, zRes, uRes);
        }
        require(usdtIn2 <= usdtAmt && zytUsed <= zytAmt, "Pool: liquidity calc");
        if (usdtIn2 > 0) IERC20(usdt).transfer(pair, usdtIn2);
        if (zytUsed > 0) IERC20(zytToken).transfer(pair, zytUsed);
        liquidity = IUniswapV2Pair(pair).mint(to);
        require(liquidity > 0, "Pool: zero liquidity");
        _updatePeak(uRes + usdtIn2);
    }

    /// @notice pair.swap 封装（按 zytIsToken0 排序输出侧）
    function _pairSwap(uint256 usdtOut, uint256 zytOut, address to) internal {
        if (zytIsToken0) {
            IUniswapV2Pair(pair).swap(zytOut, usdtOut, to, "");
        } else {
            IUniswapV2Pair(pair).swap(usdtOut, zytOut, to, "");
        }
    }

    function _updatePeak(uint256 uRes) internal {
        if (peakPoolUSDT < uRes) peakPoolUSDT = uRes;
    }
}

/// @notice 锁仓合约接口（初始 LP 持有方）
interface ILocker {
    /// @notice 报销 rate 基点的初始 LP，removeLiquidity 后把两侧资产转给调用方（Pool）
    function skimDeflation(uint256 rateBps) external returns (uint256 zytAmt, uint256 usdtAmt);
}

/// @notice ZYT 销毁接口
interface IZYTTokenBurn {
    function burnFrom(address from, uint256 amount) external;
}
