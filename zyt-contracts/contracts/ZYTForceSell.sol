// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ZYTForceSell
 * @notice v9.2 卖出窗口 + 强制卖出（2026-10-13 / 10-14 拍板终版）。
 *
 * 规则：
 *  1. 唯一卖币窗口：每月 14 日、28 日全天（北京时间 UTC+8）；窗口外真实卖出直接 revert。
 *  2. 每期额度 = 该窗口首次活动时的持币数量 × 档位，并锁存于窗口内（可多次卖，累计不得超额 = 不可多卖）。
 *     档位（基点）：首期（尚未发生首卖 / 首转出）2000 = 20%；
 *                   否则 withdrawTotal ≥ 60% × depositTotal → 200 = 2%；否则 1000 = 10%。
 *     「60%」口径：卖出实收 + 转账折算（withdrawTotal），与清单一致。
 *  3. 未卖足处理：次日凌晨（15 日 / 29 日）keeper 调 settleExpired，差额销毁，无宽限期。
 *  4. 转账视同卖出：计入当期已卖额度与首期进度；窗口外转账不阻断（照走 10% 税），也不即时销毁。
 *  5. 复投 / 迁移：由 ZYTMining 调 resetWindow 复位首期标记与窗口锁存。
 *
 * 口径与防护：
 *  - P1-9 基数口径沿用：本函数在 token 的 super._update 之后调用，余额已扣 amount，
 *    故「转账前余额」= balanceOf(from) + amount。
 *  - P1-13：settleExpired 按「窗口 id」去重，同一窗口只结算一次。旧实现按当前余额重算 required
 *    且销毁不扣减 soldAmount，重复调用会递归衰减（余额 1000 在 20% 档连调 4 次蚀掉约 59%）。
 *  - 旧 15 天 ×4 期模型（WINDOW1..4_TARGET / firstReceiveTime 计时）已整体作废。
 *  - 事件签名 ForceSellBurned / WindowSettled / FirstReceive 保持不变（keeper ABI 依赖）。
 */
contract ZYTForceSell is Ownable {
    // ---------- 档位默认值（基点，仅 config 未接线时兜底） ----------
    uint256 public constant DEFAULT_TIER_FIRST_BPS = 2000;  // 首期 20%
    uint256 public constant DEFAULT_TIER_STEP_BPS = 1000;   // 常规每期 10%
    uint256 public constant DEFAULT_TIER_AFTER60_BPS = 200; // 达 60% 且动态不在玩 → 2%
    uint256 public constant DEFAULT_TIER60_BPS = 6000;      // 60% 阈值（分子 withdrawTotal / 分母 depositTotal）

    address public token;  // ZYTToken
    address public mining; // ZYTMining（档位输入来源 + 窗口重置授权）
    address public keeper; // 到期结算触发方
    address public config; // ZYTConfig（v9.2b：档位参数来源；0 = 回退默认常量）

    struct Window {
        uint256 windowId; // 最近一次锁存的窗口 id（0 = 未锁存）
        uint256 quota;    // 该窗口额度（ZYT，锁存）
        uint256 sold;     // 该窗口已卖（ZYT，含转账视同卖出）
    }

    mapping(address => Window) public windows;
    mapping(address => bool) public initialized;         // 曾收到币（结算前置）
    mapping(address => uint256) public firstReceiveTime; // 首收时间（留档 / 审计）
    mapping(address => bool) public firstSellDone;       // 首期是否已完成（首卖或首转出后置位）
    mapping(address => mapping(uint256 => bool)) public windowSettled; // 窗口结算去重（P1-13）

    event FirstReceive(address indexed user, uint256 time);
    event ForceSellBurned(address indexed user, uint256 amount, uint256 window);
    event WindowSettled(address indexed user, uint256 window);
    event WindowOpened(address indexed user, uint256 window, uint256 quota, uint256 tierBps);
    event WindowSold(address indexed user, uint256 window, uint256 amount, uint256 sold);
    event WindowReset(address indexed user);

    constructor(address token_) Ownable(msg.sender) {
        token = token_;
    }

    /// @notice 设置 Keeper 结算地址（owner = 多签）
    function setKeeper(address _keeper) external onlyOwner {
        keeper = _keeper;
    }

    /// @notice 设置 Mining（档位输入来源 + 窗口重置授权）
    function setMining(address _mining) external onlyOwner {
        mining = _mining;
    }

    /// @notice 设置 Config（v9.2b 档位参数来源；部署红线：必须与 setKeeper/setMining 一同接线）
    function setConfig(address _config) external onlyOwner {
        config = _config;
    }

    // ---------- 视图 ----------

    /// @notice 当前北京时间的卖币窗口（windowId 为 0 表示今日非卖币日）
    function currentWindow() external view returns (uint256 windowId, bool open) {
        return _windowIdAt(block.timestamp);
    }

    /// @notice 待结算窗口 id（昨日为 14/28 日时返回其 id，否则 0）；keeper 结算前可预检
    function pendingSettleWindow() external view returns (uint256) {
        return _previousWindowId(block.timestamp);
    }

    /// @notice 用户当期档位（基点）
    function tierBpsOf(address user) external view returns (uint256) {
        return _tierBps(user);
    }

    // ---------- 记录与校验（ZYTToken 转账钩子调用） ----------

    /**
     * @notice 由 ZYTToken 调用：记录一次转出并返回需销毁量
     * @dev 真实卖出（to == pool）受窗口与额度强约束；转账仅计数、不阻断、不即时销毁。
     * @return burned 需销毁量（v9.2 仅转账路径恒为 0；销毁统一由 settleExpired 完成）
     */
    function checkAndBurn(address from, address to, uint256 amount) external returns (uint256 burned) {
        require(msg.sender == token, "FS: only token");
        burned = 0;
        if (from == address(0) || to == address(0) || amount == 0) return 0;

        _touch(from);
        _touch(to);

        address poolAddr = IZYTTokenInfo(token).pool();
        bool isSell = poolAddr != address(0) && to == poolAddr;

        (uint256 windowId, bool open) = _windowIdAt(block.timestamp);
        if (isSell) require(open, "FS: window closed"); // 窗口外禁卖（合约强制）

        if (open) {
            // P1-9 口径：余额已扣 amount，故「转账前余额」= balanceOf + amount
            uint256 balBefore = IERC20View(token).balanceOf(from) + amount;
            Window storage w = windows[from];
            if (w.windowId != windowId) {
                // 窗口首次活动：锁存额度（避免「卖一笔额度就缩水、再卖一笔」的重复放大）
                uint256 bps = _tierBps(from);
                w.windowId = windowId;
                w.quota = balBefore * bps / 10000;
                w.sold = 0;
                emit WindowOpened(from, windowId, w.quota, bps);
            }
            w.sold += amount;
            emit WindowSold(from, windowId, amount, w.sold);
            if (isSell) require(w.sold <= w.quota, "FS: over quota"); // 不可多卖
        }

        // 首期结束：任何一次卖出 / 转出（视同卖出）后，20% 档不再适用于后续窗口
        if (!firstSellDone[from]) {
            firstSellDone[from] = true;
        }
    }

    /// @notice 由 ZYTToken 调用：记录接收方首次收币（启动结算前置标记）
    function onMint(address to, uint256) external {
        require(msg.sender == token, "FS: only token");
        if (to != address(0)) _touch(to);
    }

    /// @notice 复投 / 迁移复位：清窗口锁存并把首期 20% 归还给用户（Mining 或 owner 调用）
    function resetWindow(address user) external {
        require(msg.sender == mining || msg.sender == owner(), "FS: not auth");
        windows[user] = Window(0, 0, 0);
        firstSellDone[user] = false;
        emit WindowReset(user);
    }

    // ---------- 到期结算（keeper：15 日 / 29 日凌晨） ----------

    /**
     * @notice 结算上一个卖币窗口：未卖足额度的差额销毁（无宽限期）
     * @dev 目标窗口由 block.timestamp 推导（昨日为 14/28 日），keeper 无需传参、不会传错。
     *      同一窗口按 windowSettled 去重（P1-13），重复调用为零操作。
     * @return burned 本次销毁数量
     */
    function settleExpired(address user) external returns (uint256 burned) {
        require(msg.sender == keeper || msg.sender == owner(), "FS: not keeper");
        if (!initialized[user]) return 0;
        uint256 targetId = _previousWindowId(block.timestamp);
        if (targetId == 0) return 0; // 昨日非卖币日
        if (windowSettled[user][targetId]) return 0; // P1-13 去重
        windowSettled[user][targetId] = true;

        Window storage w = windows[user];
        uint256 quota;
        uint256 sold;
        if (w.windowId == targetId) {
            quota = w.quota;
            sold = w.sold;
        } else {
            // 该窗口无活动：余额自窗口起未变，可按当前余额 × 档位计算
            quota = IERC20View(token).balanceOf(user) * _tierBps(user) / 10000;
            sold = 0;
        }

        uint256 bal = IERC20View(token).balanceOf(user);
        if (sold < quota) {
            uint256 deficit = quota - sold;
            burned = deficit < bal ? deficit : bal;
            if (burned > 0) {
                IERC20Burnable(token).burnFrom(user, burned); // 本合约持销毁权限
                emit ForceSellBurned(user, burned, targetId);
            }
        }
        emit WindowSettled(user, targetId);
    }

    // ---------- 内部 ----------

    /// @notice 首收登记（幂等）
    function _touch(address user) internal {
        if (!initialized[user]) {
            initialized[user] = true;
            firstReceiveTime[user] = block.timestamp;
            emit FirstReceive(user, block.timestamp);
        }
    }

    /**
     * @notice 当期档位（v9.2b）：首期 20% → 未达 60% 常规 10% → 达 60% 时按「动态是否在玩」分档
     * @dev 达 60%（withdrawTotal ≥ tier60Bps × depositTotal）后：
     *        - 在玩（一级直推累计入金 ≥ 本人入金）→ tierStepBps（默认 10%）
     *        - 不在玩 → tierAfter60Bps（默认 2%）
     *      四个参数优先读 config，未接线时回退默认常量（迁移期可灰度，不会导致档位归零）。
     */
    function _tierBps(address user) internal view returns (uint256) {
        address c = config;
        bool wired = c != address(0);
        if (!firstSellDone[user]) {
            return wired ? IZYTConfigTier(c).tierFirstBps() : DEFAULT_TIER_FIRST_BPS;
        }
        (uint256 dep, uint256 wd) = IZYTMiningTier(mining).sellTierInputs(user);
        uint256 th = wired ? IZYTConfigTier(c).tier60Bps() : DEFAULT_TIER60_BPS;
        if (dep > 0 && wd * 10000 >= dep * th) {
            bool playing = IZYTMiningTier(mining).dynamicPlaying(user);
            if (!playing) return wired ? IZYTConfigTier(c).tierAfter60Bps() : DEFAULT_TIER_AFTER60_BPS;
        }
        return wired ? IZYTConfigTier(c).tierStepBps() : DEFAULT_TIER_STEP_BPS;
    }

    /**
     * @notice 北京时间（UTC+8）日期 → 卖币窗口 id
     * @return windowId 形如 20261014 / 20261028；非 14/28 日返回 0
     * @return open 今日是否为卖币日
     */
    function _windowIdAt(uint256 ts) internal pure returns (uint256 windowId, bool open) {
        (uint256 y, uint256 m, uint256 d) = _beijingDate(ts);
        if (d == 14 || d == 28) return (y * 10000 + m * 100 + d, true);
        return (0, false);
    }

    /// @notice 上一个卖币窗口 id（以「北京时间的昨天」判定；非卖币日返回 0）
    function _previousWindowId(uint256 ts) internal pure returns (uint256) {
        if (ts < 1 days) return 0;
        (uint256 windowId, ) = _windowIdAt(ts - 1 days);
        return windowId;
    }

    /**
     * @notice 时间戳 → 北京时间公历日期（Howard Hinnant civil_from_days，纯整数）
     * @dev 仅用于 1970 年后的时间戳，无需负数分支。
     */
    function _beijingDate(uint256 ts) internal pure returns (uint256 y, uint256 m, uint256 d) {
        uint256 z = (ts + 8 * 3600) / 86400 + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
    }
}

interface IERC20View {
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Burnable {
    function burnFrom(address from, uint256 amount) external;
}

/// @notice ZYTToken 视图（真实卖出识别 + 销毁权限）
interface IZYTTokenInfo {
    function pool() external view returns (address);
}

/// @notice ZYTMining 档位输入（depositTotal / withdrawTotal）+ 动态「在玩」判据
interface IZYTMiningTier {
    function sellTierInputs(address user) external view returns (uint256 depositTotal, uint256 withdrawTotal);
    function dynamicPlaying(address user) external view returns (bool);
}

/// @notice ZYTConfig 卖币档位参数（v9.2b）
interface IZYTConfigTier {
    function tierFirstBps() external view returns (uint256);
    function tierStepBps() external view returns (uint256);
    function tierAfter60Bps() external view returns (uint256);
    function tier60Bps() external view returns (uint256);
}
