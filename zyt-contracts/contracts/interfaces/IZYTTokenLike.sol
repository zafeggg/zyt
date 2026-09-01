// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IZYTTokenLike
 * @notice ZYTToken 对外关键接口（mint / burn），供 Pool / Mining / Deflation 调用
 */
interface IZYTTokenLike {
    function mintTo(address to, uint256 amount) external;

    function burnFrom(address from, uint256 amount) external;

    /// @notice 记录卖出 USDT 折合（ZYTMining.sellZyt 后调用，累计卖出统计）
    function recordSellUsdt(address seller, uint256 usdtOut) external;
}
