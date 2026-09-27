// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title GSTToken（古水币）
 * @notice 项目自建底池代币，总量 3.33 亿枚，记账价 1 USDT。
 *         底池注入 2.1 万枚（供初始建池），其余划入 LP 补充储备池，按 1:1 挂钩逐笔释放，
 *         不再转入黑洞。前端对用户隐藏，仅作为 USDT ↔ ZYT 之间的计价层与滑点承受层。
 */
contract GSTToken is ERC20, Ownable {
    address public blackHole;
    address public reserve;      // LP 补充储备池（ZYTLiquidityCreator 的 GST 来源）
    address public creator;      // P1-11：储备池唯一出口（底池创建合约）
    bool public supplyLocked;
    // V14：锁定后豁免地址（pool/router/pair 等合约可接收，默认空）
    mapping(address => bool) public transferAllowed;

    event SupplyLocked(address indexed reserve, uint256 amount);
    event TransferAllowedSet(address indexed addr, bool allowed);
    event ReserveChanged(address indexed reserve);
    event CreatorChanged(address indexed creator);

    constructor(address blackHole_) ERC20("Gushui Token", "GST") Ownable(msg.sender) {
        require(blackHole_ != address(0), "GST: zero blackhole");
        blackHole = blackHole_;
        // 全量铸造给部署者（多签），底池部分转出后其余划入储备池
        _mint(msg.sender, 333_000_000e18);
    }

    /// @notice V14：设置锁定后的转账豁免地址（仅 owner=多签）
    function setTransferAllowed(address addr, bool allowed) external onlyOwner {
        transferAllowed[addr] = allowed;
        emit TransferAllowedSet(addr, allowed);
    }

    /// @notice 设置 LP 补充储备池（ZYTLiquidityCreator 的 GST 来源）
    function setReserve(address _reserve) external onlyOwner {
        require(_reserve != address(0), "GST: zero reserve");
        reserve = _reserve;
        emit ReserveChanged(_reserve);
    }

    /**
     * @notice P1-11：设置储备池唯一出口（底池创建合约）
     * @dev 储备池的 GST 只允许流向该地址。Creator 内部按入金量取用（记账 1U = 1 枚），
     *      使「1:1 挂钩释放」在链上被强制，而非仅靠运营自律。
     *      地址配置错误时的后果是「取不出」而非「可挪用」，属失效保护。
     */
    function setCreator(address _creator) external onlyOwner {
        require(_creator != address(0), "GST: zero creator");
        creator = _creator;
        emit CreatorChanged(_creator);
    }

    /**
     * @notice 锁定剩余供应并全部划入 LP 补充储备池（底池注入完成后调用，仅一次）
     * @dev 口径（2026-09-22 用户确认）：GST 不再转入黑洞。
     *      底池创建每笔消耗 600 枚（300 枚进 LP；另 300 枚兑换 ZYT 时转黑洞退出流通），
     *      储备池按 1:1 挂钩逐笔释放，即每沉淀 1 USDT 释放 1 枚 GST。
     *      3.32979 亿枚可支撑约 554,965 笔，对应累计入金约 5.5 亿 U。
     *      supplyLocked 置位后，除储备池向 Creator 的取用路径外，其余转出一律被拒。
     */
    function lockRemaining() external onlyOwner {
        require(!supplyLocked, "GST: already locked");
        require(reserve != address(0), "GST: reserve unset");
        uint256 bal = balanceOf(msg.sender);
        require(bal > 0, "GST: nothing to lock");
        supplyLocked = true;
        _transfer(msg.sender, reserve, bal);
        emit SupplyLocked(reserve, bal);
    }

    /**
     * @notice 锁定后的转出检查
     * @dev P1-11：按转出方分两档。
     *      1. 转出方为储备池 → 只允许流向 creator（1:1 挂钩释放的唯一出口）
     *      2. 其他转出方 → 接收方须为黑洞 / 零地址 / 白名单（pair、router、pool 等）
     *      黑洞与零地址（销毁）恒放行。
     */
    function _checkTransfer(address from, address to) internal view {
        if (!supplyLocked) return;
        if (to == blackHole || to == address(0)) return;
        if (from == reserve) {
            require(creator != address(0) && to == creator, "GST: reserve outflow restricted");
            return;
        }
        require(transferAllowed[to], "GST: supply locked");
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        _checkTransfer(msg.sender, to);
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _checkTransfer(from, to);
        return super.transferFrom(from, to, amount);
    }
}
