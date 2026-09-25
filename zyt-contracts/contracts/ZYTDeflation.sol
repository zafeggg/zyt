// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./ZYTConfig.sol";
import "./ZYTPoolManager.sol";
import "./ZYTMining.sol";

/**
 * @title ZYTDeflation
 * @notice 每日快照（北京时间 08:01，keeper cron `1 0 * * *` UTC 触发）：
 *         1. 更新快照基准（快照锁定价 + 池 USDT 快照 + 峰值基准刷新）
 *         2. 每日通缩 2%：锁仓合约报销 2% 初始 LP → 抽出 ZYT_a/U_b；
 *            ZYT_a 1% 销毁 + 1% 算力加权分红；U_b 转回 pair + sync（池 U 不变，价格单边上行）
 *         3. 记录当日全网算力（分红分配分母）与当日分红池
 *         通缩至池剩 500 万枚 ZYT 停止（约 299 天，机制自然终止）。
 */
contract ZYTDeflation is Ownable {
    ZYTConfig public config;
    ZYTPoolManager public pool;
    ZYTMining public mining;

    uint256 public lastSnapshotDay;
    uint256 public snapshotCount;

    event DailySnapshot(uint256 day, uint256 burned, uint256 dividend, uint256 snapshotPrice, uint256 snapshotPoolUSDT);
    event DeflationFloorHit(uint256 day);

    constructor(address config_, address pool_, address mining_) Ownable(msg.sender) {
        config = ZYTConfig(config_);
        pool = ZYTPoolManager(pool_);
        mining = ZYTMining(mining_);
    }

    /**
     * @notice 每日快照（北京时间 08:01 触发；仅 Keeper 地址或 owner 可调用，防注入恶意 totalPower）
     * @param totalPower 全网算力和（Keeper 链下统计后传入，避免链上遍历）
     */
    function dailySnapshot(uint256 totalPower) external {
        require(
            msg.sender == config.keeperAddress() || msg.sender == owner(),
            "Deflation: not keeper"
        );
        uint256 day = block.timestamp / 86400;
        require(day > lastSnapshotDay, "Deflation: once per day");
        lastSnapshotDay = day;
        snapshotCount++;

        // 1. 更新快照基准（快照锁定价 / 池 USDT 快照 / 峰值基准）
        pool.updateSnapshot();

        // 2. 每日通缩 2%（真池抽 LP：1% 销毁 + 1% 分红，U 回池 sync），至 500 万枚停止
        uint256 burned = 0;
        uint256 dividend = 0;
        if (pool.poolZYT() > config.deflationFloor()) {
            (burned, dividend) = pool.deflate();
        } else {
            emit DeflationFloorHit(day);
        }

        // 3. 记录全网算力（分红分配分母）与当日分红池
        mining.dailyRelease(day, totalPower);
        mining.recordDailyDividend(day, dividend);

        emit DailySnapshot(day, burned, dividend, pool.getTradePrice(), pool.snapshotPoolUSDT());
    }
}
