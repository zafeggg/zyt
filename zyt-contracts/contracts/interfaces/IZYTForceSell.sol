// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IZYTForceSell
 * @notice ZYTToken 转账 hook 调用的强制卖出检查接口
 */
interface IZYTForceSell {
    /**
     * @notice 记录一次转账/卖出并返回需要自动销毁的数量
     * @param from 转账发起方（视为卖出方）
     * @param to 接收方
     * @param amount 转账金额
     * @return burnAmount 需销毁的 ZYT 数量（由 token 内部执行 _burn）
     */
    function checkAndBurn(address from, address to, uint256 amount) external returns (uint256 burnAmount);

    /**
     * @notice 记录铸币接收方的首次收币时间（启动强制卖出窗口）
     * @param to 接收方
     * @param amount 铸币金额
     */
    function onMint(address to, uint256 amount) external;
}
