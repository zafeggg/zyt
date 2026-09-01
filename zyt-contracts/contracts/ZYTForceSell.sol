// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ZYTForceSell
 * @notice 强制卖出规则（防囤积、促流通）。
 *         每个钱包从首次收到币起 60 天内分 4 个 15 天窗口：
 *         0-15 天需卖出持币 20%；15-30 / 30-45 / 45-60 天各需 10%。
 *         到期未卖足 → 差额自动销毁。转账视同卖出，接收方同样启动。
 *         被 ZYTToken 的 _update hook 调用；V8 新增 settleExpired 供 Keeper 定期结算到期义务。
 */
contract ZYTForceSell is Ownable {
    uint256 public constant WINDOW = 15 days;
    uint256 public constant TOTAL_WINDOWS = 4;
    // 各窗口最低累计卖出比例（基点）：20% / 10% / 10% / 10%
    uint256 public constant WINDOW1_TARGET = 2000;
    uint256 public constant WINDOW2_TARGET = 1000;
    uint256 public constant WINDOW3_TARGET = 1000;
    uint256 public constant WINDOW4_TARGET = 1000;

    address public token; // ZYTToken 地址（读取余额 + burnFrom）
    address public keeper; // V8：到期结算触发方（Keeper 服务地址，owner 可改）

    mapping(address => uint256) public firstReceiveTime;
    mapping(address => uint256) public soldAmount; // 累计卖出量（转账视同卖出；V9：销毁不扣减）
    mapping(address => bool) public initialized;

    event FirstReceive(address indexed user, uint256 time);
    event ForceSellBurned(address indexed user, uint256 amount, uint256 window);

    constructor(address token_) Ownable(msg.sender) {
        token = token_;
    }

    /// @notice 设置 Keeper 结算地址（V8；owner=多签）
    function setKeeper(address _keeper) external onlyOwner {
        keeper = _keeper;
    }

    /// @notice 由 ZYTToken 调用：记录铸币接收方首次收币时间（启动强制卖出窗口）
    function onMint(address to, uint256 amount) external {
        require(msg.sender == token, "ZYTForceSell: only token");
        if (to != address(0) && !initialized[to] && to != address(this)) {
            initialized[to] = true;
            firstReceiveTime[to] = block.timestamp;
            emit FirstReceive(to, block.timestamp);
        }
    }

    /// @notice 由 ZYTToken 调用：记录转账并返回需销毁量
    function checkAndBurn(address from, address to, uint256 amount) external returns (uint256) {
        require(msg.sender == token, "ZYTForceSell: only token");
        uint256 burned = 0;

        // 首次收币（from 为铸币地址时由 to 触发，转账时由 from 触发）
        if (to != address(0) && !initialized[to] && to != address(this)) {
            initialized[to] = true;
            firstReceiveTime[to] = block.timestamp;
            emit FirstReceive(to, block.timestamp);
        }
        if (!initialized[from] && from != address(0)) {
            initialized[from] = true;
            firstReceiveTime[from] = block.timestamp;
            emit FirstReceive(from, block.timestamp);
        }

        // 转账视同卖出：from 累计卖出量增加
        soldAmount[from] += amount;

        // 检查 from 各到期窗口是否卖足，不足部分销毁（以本次转账为限）
        uint256 elapsed = block.timestamp - firstReceiveTime[from];
        if (elapsed >= WINDOW) {
            uint256 targetBps = _targetBps(elapsed);
            uint256 bal = IERC20View(token).balanceOf(from);
            uint256 required = bal * targetBps / 10000;
            if (soldAmount[from] < required) {
                uint256 deficit = required - soldAmount[from];
                burned = amount < deficit ? amount : deficit;
                // V9 修复：销毁后不扣减 soldAmount（销毁是惩罚，不应侵蚀用户已卖进度；
                // 余额下降使 required 按新余额收敛）
                emit ForceSellBurned(from, burned, _currentWindow(elapsed));
            }
        }
        return burned;
    }

    /**
     * @notice V8：到期自动销毁结算（Keeper 或 owner 调用）
     * @dev 对指定用户检查当前窗口累计应卖量，未卖足部分销毁差额（上限为持币余额）
     * @return burned 本次销毁数量
     */
    function settleExpired(address user) external returns (uint256 burned) {
        require(msg.sender == keeper || msg.sender == owner(), "FS: not keeper");
        require(initialized[user], "FS: not init");
        uint256 elapsed = block.timestamp - firstReceiveTime[user];
        if (elapsed < WINDOW) return 0; // 未到期
        uint256 targetBps = _targetBps(elapsed);
        uint256 bal = IERC20View(token).balanceOf(user);
        uint256 required = bal * targetBps / 10000;
        if (soldAmount[user] < required) {
            uint256 deficit = required - soldAmount[user];
            burned = deficit < bal ? deficit : bal;
            if (burned > 0) {
                IERC20Burnable(token).burnFrom(user, burned); // forceSell 为授权 burner
                emit ForceSellBurned(user, burned, _currentWindow(elapsed));
            }
        }
    }

    /// @notice 当前累计应卖目标（基点）：15d=20%、30d=30%、45d=40%、60d+=60%
    function _targetBps(uint256 elapsed) internal pure returns (uint256) {
        if (elapsed >= 4 * WINDOW) return WINDOW1_TARGET + WINDOW2_TARGET + WINDOW3_TARGET + WINDOW4_TARGET; // 60%
        if (elapsed >= 3 * WINDOW) return WINDOW1_TARGET + WINDOW2_TARGET + WINDOW3_TARGET;           // 40%
        if (elapsed >= 2 * WINDOW) return WINDOW1_TARGET + WINDOW2_TARGET;                           // 30%
        return WINDOW1_TARGET;                                                                      // 20%
    }

    function _currentWindow(uint256 elapsed) internal pure returns (uint256) {
        if (elapsed >= 4 * WINDOW) return 4;
        if (elapsed >= 3 * WINDOW) return 3;
        if (elapsed >= 2 * WINDOW) return 2;
        return 1;
    }
}

interface IERC20View {
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Burnable {
    function burnFrom(address from, uint256 amount) external;
}
