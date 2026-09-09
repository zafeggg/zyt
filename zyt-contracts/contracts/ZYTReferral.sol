// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ZYTReferral
 * @notice 推荐关系与 20 代分账（纯记账；奖励 mint 由 ZYTMining 执行）。
 *         1 代 7%、2-10 代各 2%、11-20 代各 0.5%、10% 技术运维。
 */
contract ZYTReferral is Ownable {
    address public mining;

    mapping(address => address) public referrerOf;   // 用户的直推上级
    mapping(address => uint256) public downlineCount; // 直推人数（= 可拿代数）

    event Bound(address indexed user, address indexed ref);

    modifier onlyMining() {
        require(msg.sender == mining, "Ref: only mining");
        _;
    }

    constructor() Ownable(msg.sender) {}

    function setMining(address _mining) external onlyOwner {
        mining = _mining;
    }

    /// @notice 绑定推荐关系（仅在未绑定、用户≠上级、且不形成循环时生效）
    /// @dev V3 修复：ref 的祖先链不得含 user（防 A→B→A 循环自我奖励）
    function bind(address user, address ref) external onlyMining {
        if (user == address(0) || ref == address(0) || user == ref) return;
        if (referrerOf[user] != address(0)) return;
        // 防循环：遍历 ref 的上级链（最多 20 代），若含 user 则拒绝绑定
        address cur = ref;
        for (uint256 i = 0; i < 20 && cur != address(0); i++) {
            if (cur == user) return;
            cur = referrerOf[cur];
        }
        referrerOf[user] = ref;
        downlineCount[ref]++;
        emit Bound(user, ref);
    }

    /// @notice 获取用户的上级链（从直推开始，最多 depth 代，空位为 0 地址）
    function getAncestors(address user, uint256 depth) public view returns (address[] memory) {
        address[] memory arr = new address[](depth);
        address cur = referrerOf[user];
        for (uint256 i = 0; i < depth && cur != address(0); i++) {
            arr[i] = cur;
            cur = referrerOf[cur];
        }
        return arr;
    }

    /// @notice 返回 user 在推荐树中的上溯链深（与"可拿代数=直推人数"规则无关，
    ///         可拿代数校验在 ZYTMining._distributeRef 中按 downlineCount(上级) 判定）
    function getDepth(address user) public view returns (uint256) {
        uint256 depth = 0;
        address cur = user;
        while (referrerOf[cur] != address(0) && depth < 20) {
            depth++;
            cur = referrerOf[cur];
        }
        return depth;
    }
}
