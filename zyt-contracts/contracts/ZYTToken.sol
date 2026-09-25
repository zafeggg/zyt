// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./ZYTConfig.sol";
import "./interfaces/IZYTForceSell.sol";

/**
 * @title ZYTToken（众赢币）
 * @notice v9 主代币。初始底池 21 亿枚由 Creator 一次铸出组真池，此后无任何 mint 路径。
 *         真池 gate 模式（唯一交易通道 = ZYTPoolManager）：
 *         - ZYT 流入 pair（卖出 / 加 LP）：require msg.sender 为 pool 或 creator（锁仓合约），
 *           用户无法直接向 pair 转 ZYT 卖出，也无法用 Router 绕过（Router 主动拉币时 msg.sender = Router 被拒）
 *         - ZYT 流出 pair（买入 / 通缩 removeLiquidity）：require pool.swapGate() 置位，
 *           gate 由 PoolManager 在 swap 前置位、后清位；用户直接在 Pancake 前端买币被拦
 *         - 用户间转账扣 10% 滑点（转账视同卖出）：30% 营销 / 30% 分红池 / 40% 销毁
 *         - P1-7 双向记账沿用：转出按快照价折算计入提取额，转入计入受赠额（堵静态 2 倍绕过）
 *         - P1-9 强卖基数沿用：checkAndBurn 用转账前余额
 *         - v7 卖出统计（UserSellInfo + userList）沿用：供 Ave/TP 审核与链下对账
 */
contract ZYTToken is ERC20, Ownable {
    address public minter;      // ZYTLiquidityCreator（仅建池 mint 一次）
    address public ledger;      // ZYTMining（P1-7 双向记账对象）
    address public pool;        // ZYTPoolManager（唯一 swap 通道 / 分红池载体）
    /// @dev 税分配内部转移标志（2026-09-25）：税分发（烧/营销/分红池）不再触发 _update hook，
    ///      防发送方转出折算重复计入（转出基数已含全额税，税内部分发若再折算会多计 30%×税率）
    bool private _inTax;
    address public forceSell;   // ZYTForceSell
    address public blackHole;
    address public configAddr;
    address public creator;     // 锁仓合约（= ZYTLiquidityCreator，持初始 LP）
    address public pairAddress; // ZYT/USDT 交易对（gate 判定用）

    mapping(address => bool) public isWhiteList; // 系统豁免（跳过税/记账/强卖 hook）

    // ---------- 卖出统计 ----------
    struct UserSellInfo {
        uint256 sellCount;
        uint256 totalSellZyt;
        uint256 totalSellUsdt;
        uint256 firstReceiveAt;
        uint256 lastSellAt;
        uint256 windowFlags;
    }
    mapping(address => UserSellInfo) public sellInfo;
    address[] public userList;
    mapping(address => uint256) public userIndex;

    event MinterChanged(address indexed minter);
    event LedgerChanged(address indexed ledger);
    event PoolChanged(address indexed pool);
    event ForceSellChanged(address indexed forceSell);
    event CreatorChanged(address indexed creator);
    event PairChanged(address indexed pair);
    event WhiteListSet(address indexed addr, bool enabled);
    event SellStatUpdated(address indexed user, uint256 zytAmount, uint256 usdtOut);

    modifier onlyMinter() {
        require(msg.sender == minter, "ZYT: not minter");
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

    function setLedger(address _ledger) external onlyOwner {
        ledger = _ledger;
        emit LedgerChanged(_ledger);
    }

    function setPool(address _pool) external onlyOwner {
        pool = _pool;
        emit PoolChanged(_pool);
    }

    function setForceSell(address _forceSell) external onlyOwner {
        forceSell = _forceSell;
        emit ForceSellChanged(_forceSell);
    }

    function setCreator(address _creator) external onlyOwner {
        creator = _creator;
        emit CreatorChanged(_creator);
    }

    function setPair(address _pair) external onlyOwner {
        pairAddress = _pair;
        emit PairChanged(_pair);
    }

    function setConfig(address _config) external onlyOwner {
        configAddr = _config;
    }

    function setWhiteList(address addr, bool enabled) external onlyOwner {
        isWhiteList[addr] = enabled;
        emit WhiteListSet(addr, enabled);
    }

    /// @notice 铸造（v9 仅 Creator 建池铸 21 亿一次，受 totalSupplyCap 保险丝限制）
    function mintTo(address to, uint256 amount) external onlyMinter {
        require(
            configAddr != address(0) && totalSupply() + amount <= ZYTConfig(configAddr).totalSupplyCap(),
            "ZYT: supply cap"
        );
        _mint(to, amount);
    }

    /// @notice 销毁（滑点 40% 黑洞 / 强制卖出 / 每日通缩 1%）
    function burnFrom(address from, uint256 amount) external {
        require(msg.sender == pool || msg.sender == forceSell, "ZYT: not burner");
        _burn(from, amount);
    }

    /// @notice 记录卖出 USDT 折合（ZYTMining.sellZyt 调用）
    function recordSellUsdt(address seller, uint256 usdtOut) external {
        require(msg.sender == ledger, "ZYT: not ledger");
        sellInfo[seller].totalSellUsdt += usdtOut;
        emit SellStatUpdated(seller, 0, usdtOut);
    }

    function getUserCount() external view returns (uint256) {
        return userList.length;
    }

    function getUserAt(uint256 i) external view returns (address) {
        return userList[i];
    }

    function getSellInfo(address user)
        external
        view
        returns (uint256 sellCount, uint256 totalSellZyt, uint256 totalSellUsdt, uint256 firstReceiveAt, uint256 lastSellAt, uint256 windowFlags)
    {
        UserSellInfo storage s = sellInfo[user];
        return (s.sellCount, s.totalSellZyt, s.totalSellUsdt, s.firstReceiveAt, s.lastSellAt, s.windowFlags);
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);

        // 税分配内部转移：跳过全部 hook（金额已含在发送方转出折算基数里，防重复记账/统计/强卖触发）
        if (_inTax) return;

        // 铸币：接收方启动强卖计时（v9 仅 creator 铸币，creator 为白名单，实际不触发）
        if (from == address(0)) {
            if (to != address(0) && !isWhiteList[to]) {
                _onReceive(to);
            }
            return;
        }
        // 销毁：无 hook
        if (to == address(0)) return;

        bool fromPair = from == pairAddress;
        bool toPair = to == pairAddress;

        if (toPair) {
            // ---- 卖闸：ZYT 流入 pair，仅 pool（卖出/加 LP）或 creator 允许 ----
            require(msg.sender == pool || msg.sender == creator, "ZYT: pair inflow gated");
            if (!isWhiteList[from]) {
                // 真实卖出计入强卖进度（P1-9 语义沿用：转账前余额为基数）
                if (forceSell != address(0)) {
                    uint256 burnAmount = IZYTForceSell(forceSell).checkAndBurn(from, to, amount);
                    if (burnAmount > 0) _burn(from, burnAmount);
                }
                _recordSell(from, amount);
            }
            return;
        }

        if (fromPair) {
            // ---- 买闸：ZYT 流出 pair，要求 pool 的 swapGate 置位（买币/通缩抽池均由 pool 发起）----
            require(pool != address(0) && IPoolGate(pool).swapGate(), "ZYT: pair outflow gated");
            if (!isWhiteList[to]) {
                // 买币到账：启动强卖计时（不计受赠额，买币成本不抬高静态上限）
                _onReceive(to);
            }
            return;
        }

        // ---- 普通转账 ----
        if (isWhiteList[from]) {
            // 系统路径（pool 分红转出 / creator 建池等）：接收方启动强卖计时，
            // 不计受赠额（分红/买币类系统转入不抬高静态上限，受赠额只来自用户间转账）
            if (!isWhiteList[to]) {
                _onReceive(to);
            }
            return;
        }
        if (isWhiteList[to]) {
            // 用户转给系统地址（卖出路径 user→pool 等）：无转账税（防止 _distributeTax
            // 内部 _transfer 递归到白名单分支重复收税），按转出处理记账/强卖/统计。
            // 2026-09-24 双计修复：to == pool 的转移必然是 Mining.sellZyt 卖出流程
            // （pool 先拉币再 swap），提取记账由 Mining 实收单点完成（withdrawTotal += usdtOut），
            // 此处再折算会导致同一笔卖出双计（实测 1.0363 + 0.9819 = 2.0182）。
            // 用户直转 pool 无收益（币滞留池合约），无套利通道；其余系统地址（market 等）保留折算。
            if (forceSell != address(0)) {
                uint256 burnAmount = IZYTForceSell(forceSell).checkAndBurn(from, to, amount);
                if (burnAmount > 0) _burn(from, burnAmount);
            }
            _recordSell(from, amount);
            if (ledger != address(0) && to != pool) {
                IZYTMiningLedger(ledger).recordTransferOut(from, amount);
            }
            return;
        }

        // 双方均非白名单的用户间转账（转账视同卖出）
        uint256 tax2 = configAddr != address(0)
            ? amount * ZYTConfig(configAddr).transferSlippage() / 10000
            : 0;
        // 1. 强卖 hook + 卖出统计（基数 = amount，与 v8 P1-9「转账前余额」口径精确一致：
        //    checkAndBurn 时刻余额已扣 amount、未扣税，bal = balanceOf + amount = 转账前余额）
        if (forceSell != address(0)) {
            uint256 burnAmount = IZYTForceSell(forceSell).checkAndBurn(from, to, amount);
            if (burnAmount > 0) _burn(from, burnAmount);
        }
        _recordSell(from, amount);
        // 接收方首收登记（强卖窗口起点 + 用户列表；普通转账路径）
        if (!isWhiteList[to]) _onReceive(to);
        // 2. P1-7 记账（基数 = amount + tax，转出总量计入提取额，防绕过口径从严）
        if (ledger != address(0)) {
            IZYTMiningLedger(ledger).recordTransferOut(from, amount + tax2);
            IZYTMiningLedger(ledger).recordTransferIn(to, amount); // 接收方实收（税从发送方另扣）
        }
        // 3. 执行税（放最后：不影响 checkAndBurn 读到的余额）
        if (tax2 > 0) _distributeTax(from, tax2);
    }

    /// @notice 转账税分配：40% 销毁 + 30% 营销 + 30% 分红池
    function _distributeTax(address from, uint256 tax) internal {
        uint256 burnPart = tax * 4000 / 10000;
        uint256 marketPart = tax * 3000 / 10000;
        uint256 divPart = tax - burnPart - marketPart;
        // 2026-09-25：分发期间置位，_update hook 全部跳过（发送方转出折算只算一次全额含税）
        _inTax = true;
        if (burnPart > 0) _burn(from, burnPart);
        if (marketPart > 0 && configAddr != address(0)) {
            address market = ZYTConfig(configAddr).marketAddress();
            if (market != address(0)) _transfer(from, market, marketPart);
        }
        if (divPart > 0 && pool != address(0)) {
            _transfer(from, pool, divPart);
            IPoolTax(pool).accrueDividendZyt(divPart);
        }
        _inTax = false;
    }

    /// @notice 接收方首次收币：启动强卖窗口 + 入用户列表（幂等）
    function _onReceive(address to) internal {
        if (forceSell != address(0)) {
            IZYTForceSell(forceSell).onMint(to, 0);
        }
        if (sellInfo[to].firstReceiveAt == 0) {
            sellInfo[to].firstReceiveAt = block.timestamp;
            _addToUserList(to);
        }
    }

    /// @notice 卖出统计（卖出/转出次数、累计量、首收、入列表）
    function _recordSell(address from, uint256 amount) internal {
        UserSellInfo storage s = sellInfo[from];
        s.sellCount += 1;
        s.totalSellZyt += amount;
        s.lastSellAt = block.timestamp;
        if (s.firstReceiveAt == 0) {
            s.firstReceiveAt = block.timestamp;
        }
        _addToUserList(from);
        emit SellStatUpdated(from, amount, 0);
    }

    function _addToUserList(address addr) internal {
        if (userIndex[addr] == 0) {
            userList.push(addr);
            userIndex[addr] = userList.length;
        }
    }
}

/// @notice PoolManager 的 swap 闸门（买币/通缩抽池期间置位）
interface IPoolGate {
    function swapGate() external view returns (bool);
}

/// @notice PoolManager 的转账税分红入账（30% 部分）
interface IPoolTax {
    function accrueDividendZyt(uint256 amount) external;
}

/// @notice P1-7：ZYTMining 侧的折算记账接口（仅 ZYTToken 可调用）
interface IZYTMiningLedger {
    function recordTransferOut(address user, uint256 zytAmount) external;
    function recordTransferIn(address user, uint256 zytAmount) external;
}
