// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./MockERC20.sol";

/**
 * @title MockRouter
 * @notice 测试用 PancakeSwap V2 Router 模拟。按请求量拉取两种代币，铸造等额 LP 凭证给 to。
 *         不模拟真实 AMM 的恒定乘积定价，仅用于验证底池创建合约的调用链与 LP 转黑洞路径。
 */
contract MockRouter {
    MockERC20 public lpToken;

    constructor(address lpToken_) {
        require(lpToken_ != address(0), "router: zero lp");
        lpToken = MockERC20(lpToken_);
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256,
        uint256,
        address to,
        uint256
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        require(IERC20(tokenA).transferFrom(msg.sender, address(this), amountADesired), "router: a");
        require(IERC20(tokenB).transferFrom(msg.sender, address(this), amountBDesired), "router: b");
        liquidity = amountADesired < amountBDesired ? amountADesired : amountBDesired;
        lpToken.faucet(liquidity);
        require(lpToken.transfer(to, liquidity), "router: lp");
        return (amountADesired, amountBDesired, liquidity);
    }
}
