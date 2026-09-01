import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "./config.js";

/**
 * 数据存储层（v8：双后端）
 * - DB_URL=:memory:           内存 SQLite（默认，本地快速联调；重启从链上全量重同步，幂等）
 * - DB_URL=mysql://user:pass@host:port/db  MySQL 持久化（生产/testnet；外部服务天然绕开沙箱文件限制）
 *
 * 统一异步接口：exec / run / get / all（内存模式内部同步但对外 async，调用方统一 await）
 * MySQL 方言自动翻译：INSERT OR IGNORE → INSERT IGNORE；INSERT OR REPLACE → REPLACE INTO；
 *                     ON CONFLICT(...) DO UPDATE → ON DUPLICATE KEY UPDATE
 */
let dbPromise = null;

/** 获取存储层（并发安全：多次调用共享同一初始化 promise；首次调用建表） */
export function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const url = (CONFIG.dbPath || ":memory:").trim();
      if (url === ":memory:") {
        return createMemoryDb();
      }
      if (url.startsWith("mysql://")) {
        return await createMysqlDb(url);
      }
      throw new Error(`unknown DB_URL: ${url} (支持 :memory: 或 mysql://...)`);
    })();
    // 初始化失败允许下次重试
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

/** 测试/重置用（避免多实例共享句柄） */
export function _resetDb() {
  dbPromise = null;
}

// ===================== 内存 SQLite 后端 =====================

function createMemoryDb() {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA journal_mode=WAL;");
  migrateMemory(d);
  return {
    mode: "memory",
    exec: async (sql) => d.exec(sql),
    run: async (sql, params = []) => {
      const r = d.prepare(sql).run(...params);
      return { affectedRows: Number(r.changes), insertId: Number(r.lastInsertRowid) };
    },
    get: async (sql, params = []) => d.prepare(sql).get(...params) ?? null,
    all: async (sql, params = []) => d.prepare(sql).all(...params),
  };
}

function migrateMemory(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id INTEGER,
    block INTEGER,
    tx_hash TEXT,
    log_index INTEGER,
    name TEXT,
    from_addr TEXT,
    to_addr TEXT,
    amount TEXT,
    extra TEXT,
    created_at INTEGER,
    UNIQUE(chain_id, tx_hash, log_index)
  );
  CREATE TABLE IF NOT EXISTS users (
    address TEXT PRIMARY KEY,
    deposit_total TEXT DEFAULT '0',
    withdraw_total TEXT DEFAULT '0',
    dynamic_quota TEXT DEFAULT '0',
    dynamic_withdrawn TEXT DEFAULT '0',
    power_base TEXT DEFAULT '0',
    power_day INTEGER DEFAULT 0,
    is_exited INTEGER DEFAULT 0,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    day INTEGER PRIMARY KEY,
    burned TEXT,
    dividend TEXT,
    released TEXT,
    snapshot_gst TEXT,
    total_power TEXT,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS pool_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pool_gst TEXT,
    pool_zyt TEXT,
    pool_usdt TEXT,
    snapshot_gst TEXT,
    price TEXT,
    slippage_pct INTEGER,
    stage INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS keeper_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    status TEXT,
    detail TEXT,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS reconcile_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checked_at INTEGER,
    total_users INTEGER,
    diff_users INTEGER,
    max_diff_pct REAL,
    status TEXT,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS force_sell (
    address TEXT PRIMARY KEY,
    first_receive_at INTEGER,
    sold_amount TEXT DEFAULT '0',
    balance TEXT DEFAULT '0',
    current_window INTEGER DEFAULT 0,
    target_bps INTEGER DEFAULT 0,
    required_sell TEXT DEFAULT '0',
    sell_count INTEGER DEFAULT 0,
    total_sell TEXT DEFAULT '0',
    at_risk INTEGER DEFAULT 0,
    updated_at INTEGER
  );
  `);
}

// ===================== MySQL 后端 =====================

async function createMysqlDb(url) {
  const { createPool } = await import("mysql2/promise");
  const u = new URL(url);
  const pool = createPool({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    connectionLimit: 10,
    charset: "utf8mb4",
  });
  // 建表（MySQL DDL，幂等）
  const DDL = [
    `CREATE TABLE IF NOT EXISTS events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      chain_id INT,
      block BIGINT,
      tx_hash VARCHAR(66),
      log_index INT,
      name VARCHAR(64),
      from_addr VARCHAR(42),
      to_addr VARCHAR(42),
      amount TEXT,
      extra TEXT,
      created_at BIGINT,
      UNIQUE KEY uk_evt (chain_id, tx_hash, log_index)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS users (
      address VARCHAR(42) PRIMARY KEY,
      deposit_total VARCHAR(80) DEFAULT '0',
      withdraw_total VARCHAR(80) DEFAULT '0',
      dynamic_quota VARCHAR(80) DEFAULT '0',
      dynamic_withdrawn VARCHAR(80) DEFAULT '0',
      power_base VARCHAR(80) DEFAULT '0',
      power_day INT DEFAULT 0,
      is_exited TINYINT(1) DEFAULT 0,
      updated_at BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS snapshots (
      day INT PRIMARY KEY,
      burned VARCHAR(80),
      dividend VARCHAR(80),
      released VARCHAR(80),
      snapshot_gst VARCHAR(80),
      total_power VARCHAR(80),
      created_at BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS pool_state (
      id INT PRIMARY KEY,
      pool_gst VARCHAR(80),
      pool_zyt VARCHAR(80),
      pool_usdt VARCHAR(80),
      snapshot_gst VARCHAR(80),
      price VARCHAR(80),
      slippage_pct INT,
      stage INT,
      updated_at BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS keeper_runs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(32),
      status VARCHAR(32),
      detail TEXT,
      created_at BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS reconcile_results (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      checked_at BIGINT,
      total_users INT,
      diff_users INT,
      max_diff_pct DOUBLE,
      status VARCHAR(16),
      detail TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS force_sell (
      address VARCHAR(42) PRIMARY KEY,
      first_receive_at BIGINT,
      sold_amount VARCHAR(80) DEFAULT '0',
      balance VARCHAR(80) DEFAULT '0',
      current_window INT DEFAULT 0,
      target_bps INT DEFAULT 0,
      required_sell VARCHAR(80) DEFAULT '0',
      sell_count INT DEFAULT 0,
      total_sell VARCHAR(80) DEFAULT '0',
      at_risk TINYINT(1) DEFAULT 0,
      updated_at BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];
  for (const sql of DDL) await pool.query(sql);

  // SQLite 方言 → MySQL（在统一 SQL 基础上做最小翻译）
  // 注意：MySQL 的 ON DUPLICATE KEY UPDATE 不带 SET 关键字；新值引用用 VALUES(col)（8.0.20+ 兼容）
  const translate = (sql) =>
    sql
      .replace(/INSERT OR IGNORE\s+INTO/i, "INSERT IGNORE INTO")
      .replace(/INSERT OR REPLACE\s+INTO/i, "REPLACE INTO")
      .replace(/ON CONFLICT\([^)]*\) DO UPDATE\s+SET/i, "ON DUPLICATE KEY UPDATE")
      .replace(/excluded\.(\w+)/g, "VALUES($1)");

  return {
    mode: "mysql",
    exec: async (sql) => {
      await pool.query(sql);
    },
    run: async (sql, params = []) => {
      const [r] = await pool.execute(translate(sql), params);
      return { affectedRows: r.affectedRows, insertId: r.insertId };
    },
    get: async (sql, params = []) => {
      const [rows] = await pool.execute(translate(sql), params);
      return rows[0] ?? null;
    },
    all: async (sql, params = []) => {
      const [rows] = await pool.execute(translate(sql), params);
      return rows;
    },
  };
}
