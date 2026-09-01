// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title GSTToken（古水币）
 * @notice 项目自建底池代币，总量 3.33 亿枚，初始价 1 USDT。
 *         底池注入 2.1 万枚，其余供应永久锁定（转黑洞，底池外零流通）。
 *         前端对用户隐藏，仅作为 USDT ↔ ZYT 之间的计价层与滑点承受层。
 */
contract GSTToken is ERC20, Ownable {
    address public blackHole;
    bool public supplyLocked;
    // V14：锁定后豁免地址（pool/router 等合约可转出，前瞻 DEX 接入；默认空）
    mapping(address => bool) public transferAllowed;

    event SupplyLocked(address indexed blackHole, uint256 amount);
    event TransferAllowedSet(address indexed addr, bool allowed);

    constructor(address blackHole_) ERC20("Gushui Token", "GST") Ownable(msg.sender) {
        require(blackHole_ != address(0), "GST: zero blackhole");
        blackHole = blackHole_;
        // 全量铸造给部署者（多签），底池部分转出后其余永久锁定
        _mint(msg.sender, 333_000_000e18);
    }

    /// @notice V14：设置锁定后的转账豁免地址（仅 owner=多签）
    function setTransferAllowed(address addr, bool allowed) external onlyOwner {
        transferAllowed[addr] = allowed;
        emit TransferAllowedSet(addr, allowed);
    }

    /**
     * @notice 永久锁定剩余供应（底池注入完成后调用，仅一次）
     * @dev 将部署者（多签）持有的其余 GST 全部转入黑洞地址，之后不可逆
     */
    function lockRemaining() external onlyOwner {
        require(!supplyLocked, "GST: already locked");
        uint256 bal = balanceOf(msg.sender);
        require(bal > 0, "GST: nothing to lock");
        supplyLocked = true;
        _transfer(msg.sender, blackHole, bal);
        emit SupplyLocked(blackHole, bal);
    }

    /// @notice 黑洞地址外的代币锁定后禁止转出（豁免 transferAllowed 地址，防误操作）
    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!supplyLocked || to == blackHole || to == address(0) || transferAllowed[to], "GST: supply locked");
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        require(!supplyLocked || to == blackHole || to == address(0) || transferAllowed[to], "GST: supply locked");
        return super.transferFrom(from, to, amount);
    }
}
