import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";
import { logRun } from "./alert.js";

/**
 * 双实例互斥锁（方案 §6.3：Keeper 多实例部署防重复触发快照）
 *
 * - 生产：Redis SET NX PX（原子、带 TTL 防死锁），需配置 REDIS_URL
 * - 降级：本地文件锁（原子 mkdir + TTL 过期检测），单机/本地联调场景
 *
 * 使用：acquire() 返回 true 表示拿到锁；执行完必须 release()；TTL 兜底防进程崩溃死锁。
 */
class Lock {
  constructor() {
    this.redisUrl = CONFIG.lock.redisUrl.trim();
    this.useRedis = this.redisUrl.length > 0;
    this.redis = null;
    this.fileDir = path.join(os.tmpdir(), "zyt-keeper-locks");
    this.heldKeys = new Set();
  }

  /** 初始化 Redis 客户端（动态 import，未配置时不加载依赖） */
  async _initRedis() {
    if (!this.useRedis || this.redis) return;
    const { default: Redis } = await import("ioredis");
    this.redis = new Redis(this.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await this.redis.connect().catch((e) => {
      // Redis 不可用时回退文件锁，并告警
      logRun("lock", "error", `redis unavailable, fallback to file lock: ${e.message}`);
      this.useRedis = false;
      this.redis = null;
    });
  }

  /**
   * 尝试获取锁
   * @param {string} key 锁名称
   * @param {number} ttlMs 过期毫秒（进程崩溃兜底）
   * @returns {Promise<boolean>} true=获取成功
   */
  async acquire(key, ttlMs) {
    if (this.useRedis) {
      await this._initRedis();
      if (this.useRedis && this.redis) {
        // SET key value NX PX ttl —— 原子：不存在才设置，带过期
        const res = await this.redis.set(`zyt:lock:${key}`, String(Date.now()), "PX", ttlMs, "NX");
        const ok = res === "OK";
        if (ok) this.heldKeys.add(key);
        return ok;
      }
    }
    // 文件锁降级
    const ok = this._fileAcquire(key, ttlMs);
    if (ok) this.heldKeys.add(key);
    return ok;
  }

  /** 释放锁 */
  async release(key) {
    this.heldKeys.delete(key);
    if (this.useRedis && this.redis) {
      try {
        await this.redis.del(`zyt:lock:${key}`);
      } catch (e) {
        logRun("lock", "error", `redis release failed: ${e.message}`);
      }
      return;
    }
    this._fileRelease(key);
  }

  /** 进程退出时释放持有的锁 */
  async dispose() {
    for (const k of [...this.heldKeys]) await this.release(k);
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        /* ignore */
      }
    }
  }

  // ---------- 文件锁（原子 mkdir + TTL） ----------

  _fileAcquire(key, ttlMs) {
    const lockPath = path.join(this.fileDir, `${key}.lock`);
    try {
      fs.mkdirSync(this.fileDir, { recursive: true });
    } catch {
      /* dir already exists */
    }
    try {
      // 原子创建目录 = 获取锁（EEXIST 表示已被占用）
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, "owner"), String(process.pid));
      fs.writeFileSync(path.join(lockPath, "expires"), String(Date.now() + ttlMs));
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // 锁存在：检查是否过期（崩溃残留兜底）
      try {
        const exp = Number(fs.readFileSync(path.join(lockPath, "expires"), "utf8"));
        if (Date.now() > exp) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          return this._fileAcquire(key, ttlMs); // 清理后重试一次
        }
      } catch {
        /* 无 expires 文件或读取失败：视为未过期 */
      }
      return false;
    }
  }

  _fileRelease(key) {
    const lockPath = path.join(this.fileDir, `${key}.lock`);
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 全局单例（服务进程共享） */
export const lock = new Lock();

/** Lock 类导出（测试/多实例场景用） */
export { Lock };
