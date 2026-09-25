// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ZYTCompute
 * @notice 算力与出局阈值纯计算库：
 *         - 算力日复利 +1%（power = base × 1.01^n）
 *         - 静态 2 倍出局（累计提取 ≥ 2×入金 + 累计受赠，P1-7）
 *         - 动态额度 5 倍（已废弃，v8 起由「算力即额度」取代，保留函数仅为兼容）
 */
library ZYTCompute {
    uint256 public constant MAX_COMPOUND_DAYS = 365;

    /**
     * @notice 算力复利计算
     * @param base 算力基数
     * @param rateBps 日复利率（基点，1% = 100）
     * @param days_ 已过天数
     */
    function powerWithCompound(
        uint256 base,
        uint256 rateBps,
        uint256 days_
    ) public pure returns (uint256) {
        uint256 p = base;
        uint256 n = days_ > MAX_COMPOUND_DAYS ? MAX_COMPOUND_DAYS : days_;
        for (uint256 i = 0; i < n; i++) {
            p = p + p * rateBps / 10000;
        }
        return p;
    }

    /**
     * @notice 静态 2 倍出局判断（P1-7 修复版）
     * @param withdrawTotal 累计提取 USDT 等值（卖出 + 算力兑换 + 转出折算）
     * @param depositTotal 累计入金 USDT
     * @param exitMul 出局倍数（默认 2）
     * @param receivedValue 累计受赠 USDT 等值（转入折算）
     * @dev 修复两个绕过路径：
     *      1. 转账不写 withdrawTotal（转出方按快照价折算计入 withdrawTotal，额度守恒）
     *      2. 零入金地址不出局（原 depositTotal == 0 早退已移除，改为上限含 receivedValue）
     *      早退条件用双零判定而非 cap == 0：exitMul 被置 0 时 cap 亦可为 0，
     *      但语义上应判「任何提取都已到顶」，不可早退。
     */
    function isStaticExited(
        uint256 withdrawTotal,
        uint256 depositTotal,
        uint256 exitMul,
        uint256 receivedValue
    ) public pure returns (bool) {
        if (depositTotal == 0 && receivedValue == 0) return false;
        return withdrawTotal >= depositTotal * exitMul + receivedValue;
    }

    /// @notice 动态额度耗尽判断（已废弃，v8 起无调用方）
    function isQuotaExhausted(
        uint256 dynamicWithdrawn,
        uint256 dynamicQuota
    ) public pure returns (bool) {
        if (dynamicQuota == 0) return false;
        return dynamicWithdrawn >= dynamicQuota;
    }

    /// @notice 动态额度 = 累计入金 × 倍数（已废弃，v8 起无调用方）
    function quotaFor(uint256 depositTotal, uint256 mul) public pure returns (uint256) {
        return depositTotal * mul;
    }
}
