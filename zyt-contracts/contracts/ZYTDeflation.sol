// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./ZYTConfig.sol";
import "./ZYTPoolManager.sol";
import "./ZYTMining.sol";

/**
 * @title ZYTDeflation
 * @notice 每日快照（北京时间 08:00，与 Ave 同步，由 Keeper 触发）：
 *         - 更新滑点基准（底池 GST 数量快照）
 *         - 每日底池通缩 2%（1% 销毁 + 1% 算力加权分红），通缩至 500 万枚停止
 *         - 记录当日产出释放（全网算力由 Keeper 统计传入）
 */
contract ZYTDeflation is Ownable {
    ZYTConfig public config;
    ZYTPoolManager public pool;
    ZYTMining public mining;

    uint256 public lastSnapshotDay;
    uint256 public snapshotCount;

    event DailySnapshot(uint256 day, uint256 burned, uint256 dividend, uint256 released, uint256 snapshotGST);
    event DeflationFloorHit(uint256 day);

    constructor(address config_, address pool_, address mining_) Ownable(msg.sender) {
        config = ZYTConfig(config_);
        pool = ZYTPoolManager(pool_);
        mining = ZYTMining(mining_);
    }

    /**
     * @notice 每日快照（北京时间 08:00 触发；仅 Keeper 地址或 owner 可调用，防任意地址注入恶意 totalPower）
     * @param totalPower 全网算力和（Keeper 链下统计后传入，避免链上遍历）
     */
    function dailySnapshot(uint256 totalPower) external {
        // V4 修复：仅 keeper 或 owner 可触发（防 DoS/产出稀释/抢先快照）
        require(
            msg.sender == config.keeperAddress() || msg.sender == owner(),
            "Deflation: not keeper"
        );
        uint256 day = block.timestamp / 86400;
        require(day > lastSnapshotDay, "Deflation: once per day");
        lastSnapshotDay = day;
        snapshotCount++;

        // 1. 更新滑点基准（底池 GST 数量）
        pool.updateSnapshot();

        // 2. 每日通缩 2%（1% 销毁 + 1% 分红），至 500 万枚停止
        uint256 burned = 0;
        uint256 dividend = 0;
        if (pool.poolZYT() > config.deflationFloor()) {
            (burned, dividend) = pool.dailyBurn();
        } else {
            emit DeflationFloorHit(day);
        }

        // 3. 每日产出释放记录
        mining.dailyRelease(day, totalPower);
        uint256 released = mining.dailyReleaseAmount();

        emit DailySnapshot(day, burned, dividend, released, pool.snapshotPoolGST());
    }
}
