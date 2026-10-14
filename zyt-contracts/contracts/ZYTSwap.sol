// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ZYTSwap（v9.2 一次性迁移配套：旧 ZYT 1:1 兑换新 ZYT）
 * @notice 迁移路线 A（2026-10-13 拍板）的兑换入口：
 *         - 新币来源：Treasury（W3 营销 Safe）approve 本合约后经 fund 注入（预算 12 亿档）
 *         - 兑换比例 1:1，无滑点、无税、无手续费
 *         - 窗口 = 首次 fund 起 14 天；owner（多签）可提前 close；到期后 reclaim 回收未用新币
 *         - 兑入的旧币逐笔转黑地址销毁（统一处置，不回流市场）
 *
 * 部署/迁移顺序红线（必须全部满足，否则 1:1 承诺失效）：
 *   1. oldZyt.setWhiteList(address(this), true)  —— 否则用户转入旧币被扣 10% 转账税
 *   2. newZyt.setWhiteList(address(this), true)  —— 否则向用户转出新币也被扣 10%
 *   本合约在 fund 时对两条做硬校验（一次性，不占用每笔兑换的 gas）。
 *
 * 注：旧币合约已部署且不可升级（burnFrom 仅限 pool/forceSell），因此旧币销毁走
 *    「转入黑地址」路径；白名单化后转账 hook 直接放行，不触发税、不登记强卖义务。
 */
contract ZYTSwap is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant SWAP_WINDOW = 14 days;

    IERC20 public immutable oldZyt;  // 旧 ZYT（迁移前代币）
    IERC20 public immutable newZyt;  // 新 ZYT（v9.2 代币）
    address public immutable blackHole; // 旧币统一销毁地址

    uint256 public startTime;  // 首次注资时刻（0 = 未开启）
    bool public closed;        // owner 提前关闭标记
    uint256 public totalOldIn; // 累计兑入旧币
    uint256 public totalNewOut; // 累计兑出新币

    event Funded(address indexed from, uint256 amount, uint256 deadline);
    event Swapped(address indexed user, uint256 oldAmount, uint256 newAmount);
    event Closed(uint256 at);
    event Reclaimed(address indexed to, uint256 amount);

    constructor(address oldZyt_, address newZyt_, address blackHole_) Ownable(msg.sender) {
        require(
            oldZyt_ != address(0) && newZyt_ != address(0) && blackHole_ != address(0),
            "Swap: zero addr"
        );
        require(oldZyt_ != newZyt_, "Swap: same token");
        oldZyt = IERC20(oldZyt_);
        newZyt = IERC20(newZyt_);
        blackHole = blackHole_;
    }

    // ---------- 视图 ----------

    /// @notice 兑换窗口是否开放（前端展示与引导）
    function isOpen() public view returns (bool) {
        return startTime != 0 && !closed && block.timestamp <= startTime + SWAP_WINDOW;
    }

    /// @notice 窗口截止时间戳（0 = 未开启）
    function deadline() external view returns (uint256) {
        return startTime == 0 ? 0 : startTime + SWAP_WINDOW;
    }

    // ---------- 治理 ----------

    /**
     * @notice 注资新币并开启 14 天兑换窗口（owner = 多签；Treasury 需先 approve 本合约）
     * @dev 首次调用写入 startTime；后续追加注资不重置窗口起点。
     */
    function fund(uint256 amount) external onlyOwner {
        require(amount > 0, "Swap: zero");
        // 红线硬校验：两端白名单齐备才允许开启，防 1:1 被转账税削掉
        require(IWhitelist(address(oldZyt)).isWhiteList(address(this)), "Swap: old token not whitelisted");
        require(IWhitelist(address(newZyt)).isWhiteList(address(this)), "Swap: new token not whitelisted");
        newZyt.safeTransferFrom(msg.sender, address(this), amount);
        if (startTime == 0) startTime = block.timestamp;
        emit Funded(msg.sender, amount, startTime + SWAP_WINDOW);
    }

    /// @notice 提前关闭兑换窗口（owner；到期亦自动关闭）
    function close() external onlyOwner {
        require(!closed, "Swap: already closed");
        closed = true;
        emit Closed(block.timestamp);
    }

    /// @notice 窗口关闭/到期后回收未使用的新币（owner）
    function reclaim(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Swap: zero addr");
        require(amount > 0, "Swap: zero");
        require(!isOpen(), "Swap: still open");
        newZyt.safeTransfer(to, amount);
        emit Reclaimed(to, amount);
    }

    // ---------- 兑换 ----------

    /**
     * @notice 旧 ZYT 1:1 兑换新 ZYT（用户需先 approve 旧币给本合约）
     * @param amount 旧币数量
     * @return 实得新币数量（恒等于 amount）
     */
    function swap(uint256 amount) external nonReentrant returns (uint256) {
        require(isOpen(), "Swap: window closed");
        require(amount > 0, "Swap: zero");
        oldZyt.safeTransferFrom(msg.sender, address(this), amount);
        oldZyt.safeTransfer(blackHole, amount); // 兑入旧币统一销毁
        newZyt.safeTransfer(msg.sender, amount); // 1:1 兑出
        totalOldIn += amount;
        totalNewOut += amount;
        emit Swapped(msg.sender, amount, amount);
        return amount;
    }
}

/// @notice ZYTToken 白名单查询（旧币与新币均为 ZYTToken）
interface IWhitelist {
    function isWhiteList(address) external view returns (bool);
}
