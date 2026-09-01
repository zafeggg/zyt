// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ZYTCompute
 * @notice 算力与出局阈值纯计算库：
 *         - 算力日复利 +1%（power = base × 1.01^n）
 *         - 静态 2 倍出局（累计提取 ≥ 2×入金）
 *         - 动态额度 5 倍（动态收益额度 = 入金 × 5，耗尽停发、复投恢复）
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

    /// @notice 静态 2 倍出局判断
    function isStaticExited(
        uint256 withdrawTotal,
        uint256 depositTotal,
        uint256 exitMul
    ) public pure returns (bool) {
        if (depositTotal == 0) return false;
        return withdrawTotal >= depositTotal * exitMul;
    }

    /// @notice 动态额度耗尽判断（耗尽后停发收益，复投恢复）
    function isQuotaExhausted(
        uint256 dynamicWithdrawn,
        uint256 dynamicQuota
    ) public pure returns (bool) {
        if (dynamicQuota == 0) return false;
        return dynamicWithdrawn >= dynamicQuota;
    }

    /// @notice 动态额度 = 累计入金 × 倍数
    function quotaFor(uint256 depositTotal, uint256 mul) public pure returns (uint256) {
        return depositTotal * mul;
    }
}
