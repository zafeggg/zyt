// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title UniV2
 * @notice PancakeSwap V2 标准接口（v9 全程直连 pair，不经 Router）。
 *         PoolManager 直接 transferFrom + pair.swap 完成买卖，
 *         LiquidityCreator 直接转币 + pair.mint 建池、pair.burn 抽通缩。
 */
interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function sync() external;
    function totalSupply() external view returns (uint256);
}

library UniV2Lib {
    /// @notice V2 getAmountOut（含 fee）
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 feeBps
    ) internal pure returns (uint256 amountOut) {
        require(amountIn > 0, "UniV2: INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "UniV2: INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * (10000 - feeBps);
        amountOut = amountInWithFee * reserveOut / (reserveIn * 10000 + amountInWithFee);
    }

    /// @notice 给定 amountA 与两侧储备，返回按当前比例配对的 amountB（V2 quote）
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) internal pure returns (uint256 amountB) {
        require(amountA > 0, "UniV2: INSUFFICIENT_AMOUNT");
        require(reserveA > 0 && reserveB > 0, "UniV2: INSUFFICIENT_LIQUIDITY");
        amountB = amountA * reserveB / reserveA;
    }
}
