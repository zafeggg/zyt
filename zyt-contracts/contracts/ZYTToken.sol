// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./ZYTConfig.sol";
import "./interfaces/IZYTForceSell.sol";

/**
 * @title ZYTToken（众赢币）
 * @notice BEP20 主代币，初始底池 21 亿枚，初始价 0.00001 USDT。
 *         - mint 仅限 ZYTMining / ZYTPoolManager / ZYTDeflation，且受 totalSupplyCap 保险丝限制（V7）
 *         - burn 仅限授权合约（滑点 40% 销毁、强制卖出销毁、V6 转账滑点销毁）
 *         - 用户间转账扣 10% 滑点（V6：转账视同卖出）+ 触发强制卖出 hook
 *         - 卖出到池（to=白名单）同样计入强制卖出义务（V1 修复）
 *         v7 新增：
 *         - 用户卖出统计（UserSellInfo）：卖出次数/累计卖出 ZYT/累计卖出 USDT/首收时间/最近卖出时间
 *         - userList 遍历接口（getUserCount/getUserAt/getSellInfo）：供 Ave/TP 审核与链下对账交叉校验
 */
contract ZYTToken is ERC20, Ownable {
    address public minter;      // ZYTMining（产出/奖励 mint）
    address public pool;        // ZYTPoolManager（滑点结算、底池持有）
    address public forceSell;   // ZYTForceSell（强制卖出 hook）
    address public blackHole;
    address public configAddr;  // ZYTConfig（V6 转账滑点率 / V7 增发上限）

    mapping(address => bool) public isWhiteList; // 白名单（池/合约）跳过强制卖出 hook

    // ---------- v7：用户卖出统计 ----------
    struct UserSellInfo {
        uint256 sellCount;      // 卖出/转账转出次数
        uint256 totalSellZyt;   // 累计卖出/转出 ZYT
        uint256 totalSellUsdt;  // 累计卖出折合 USDT（sellZyt 上报）
        uint256 firstReceiveAt; // 首次收币时间（强制卖出起点）
        uint256 lastSellAt;     // 最近卖出时间
        uint256 windowFlags;    // 4 窗口位图（与 ZYTForceSell 共用）
    }
    mapping(address => UserSellInfo) public sellInfo;   // 按用户卖出统计
    address[] public userList;                          // 用户列表（首次收币/卖出时 push，供遍历）
    mapping(address => uint256) public userIndex;       // 用户列表索引（1 起；0 = 不在列表）

    event MinterChanged(address indexed minter);
    event PoolChanged(address indexed pool);
    event ForceSellChanged(address indexed forceSell);
    event WhiteListSet(address indexed addr, bool enabled);
    event SellStatUpdated(address indexed user, uint256 zytAmount, uint256 usdtOut);

    modifier onlyMinter() {
        require(msg.sender == minter || msg.sender == pool, "ZYT: not minter");
        _;
    }

    constructor(address blackHole_) ERC20("ZhongYing Token", "ZYT") Ownable(msg.sender) {
        require(blackHole_ != address(0), "ZYT: zero blackhole");
        blackHole = blackHole_;
    }

    function setMinter(address _minter) external onlyOwner {
        minter = _minter;
        emit MinterChanged(_minter);
    }

    function setPool(address _pool) external onlyOwner {
        pool = _pool;
        emit PoolChanged(_pool);
    }

    function setForceSell(address _forceSell) external onlyOwner {
        forceSell = _forceSell;
        emit ForceSellChanged(_forceSell);
    }

    /// @notice 设置 ZYTConfig（V6/V7：转账滑点率 + 增发上限）
    function setConfig(address _config) external onlyOwner {
        configAddr = _config;
    }

    function setWhiteList(address addr, bool enabled) external onlyOwner {
        isWhiteList[addr] = enabled;
        emit WhiteListSet(addr, enabled);
    }

    /// @notice 铸造（入金发币 / 产出 / 推荐奖励 / 分红）
    /// @dev V7：受 totalSupplyCap 保险丝限制（防无限增发）
    function mintTo(address to, uint256 amount) external onlyMinter {
        require(
            configAddr != address(0) && totalSupply() + amount <= ZYTConfig(configAddr).totalSupplyCap(),
            "ZYT: supply cap"
        );
        _mint(to, amount);
    }

    /// @notice 销毁（滑点 40% 黑洞、强制卖出、通缩）
    function burnFrom(address from, uint256 amount) external {
        require(
            msg.sender == minter || msg.sender == pool || msg.sender == forceSell,
            "ZYT: not burner"
        );
        _burn(from, amount);
    }

    /// @notice 记录卖出 USDT 折合（ZYTMining.sellZyt 调用；ZYT 部分由 _update 统计）
    function recordSellUsdt(address seller, uint256 usdtOut) external {
        require(msg.sender == minter, "ZYT: not minter");
        UserSellInfo storage s = sellInfo[seller];
        s.totalSellUsdt += usdtOut;
        emit SellStatUpdated(seller, 0, usdtOut);
    }

    /// @notice 用户总数（供遍历）
    function getUserCount() external view returns (uint256) {
        return userList.length;
    }

    /// @notice 第 i 个用户地址（供 Ave/TP / 链下对账遍历）
    function getUserAt(uint256 i) external view returns (address) {
        return userList[i];
    }

    /// @notice 用户卖出统计查询
    function getSellInfo(address user)
        external
        view
        returns (uint256 sellCount, uint256 totalSellZyt, uint256 totalSellUsdt, uint256 firstReceiveAt, uint256 lastSellAt, uint256 windowFlags)
    {
        UserSellInfo storage s = sellInfo[user];
        return (s.sellCount, s.totalSellZyt, s.totalSellUsdt, s.firstReceiveAt, s.lastSellAt, s.windowFlags);
    }

    /**
     * @notice 转账 hook：铸币时记录首次收币；用户间转账触发强制卖出检查 + 卖出统计
     */
    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (forceSell == address(0)) return;
        if (from == address(0) && to != address(0)) {
            // 铸币：启动接收方强制卖出窗口 + 记录首收时间 + 入用户列表
            if (!isWhiteList[to]) {
                IZYTForceSell(forceSell).onMint(to, amount);
                if (sellInfo[to].firstReceiveAt == 0) {
                    sellInfo[to].firstReceiveAt = block.timestamp;
                    _addToUserList(to);
                }
            }
        } else if (from != address(0) && to != address(0)) {
            // 用户间转账/卖出（转账视同卖出）
            // 修复 V1：真实卖出（to=池，白名单）同样计入强制卖出义务——
            // 判断条件从「双方都非白名单」改为「仅看 from」，避免卖出到池绕过 checkAndBurn
            if (!isWhiteList[from]) {
                uint256 burnAmount = IZYTForceSell(forceSell).checkAndBurn(from, to, amount);
                if (burnAmount > 0) {
                    _burn(from, burnAmount);
                }
            } else if (!isWhiteList[to]) {
                // P2-2 决策（推荐 A）：from 为白名单合约（如 payoutDividend 分红转出）时，
                // 接收方首次收币同样启动强制卖出窗口 + 入用户列表（与产出 mint 渠道行为一致）。
                // 幂等：onMint 内部仅首次收币时设置 firstReceiveTime。
                IZYTForceSell(forceSell).onMint(to, amount);
                if (sellInfo[to].firstReceiveAt == 0) {
                    sellInfo[to].firstReceiveAt = block.timestamp;
                    _addToUserList(to);
                }
            }
            // 修复 V6：用户间转账扣 10% 滑点（转账视同卖出；from 需留足滑点余额）
            if (configAddr != address(0) && !isWhiteList[from] && !isWhiteList[to]) {
                uint256 tax = amount * ZYTConfig(configAddr).transferSlippage() / 10000;
                if (tax > 0) {
                    _burn(from, tax);
                }
            }
            // v7：卖出统计（非白名单 from 转出即计入；池/合约内部划转不计）
            if (!isWhiteList[from]) {
                UserSellInfo storage s = sellInfo[from];
                s.sellCount += 1;
                s.totalSellZyt += amount;
                s.lastSellAt = block.timestamp;
                if (s.firstReceiveAt == 0) s.firstReceiveAt = block.timestamp;
                _addToUserList(from);
                emit SellStatUpdated(from, amount, 0);
            }
        }
    }

    /// @notice 用户列表去重入列（索引 1 起，0 表示不在列表）
    function _addToUserList(address addr) internal {
        if (userIndex[addr] == 0) {
            userList.push(addr);
            userIndex[addr] = userList.length;
        }
    }
}
