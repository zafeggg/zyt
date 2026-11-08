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

/**
 * users 表列定义（两套方言各一份）。
 * 2026-11-08：抽成常量，供 users 与影子表 users_next 共用，避免两处 DDL 漂移。
 */
const MEM_USERS_COLS = `address TEXT PRIMARY KEY,
    deposit_total TEXT DEFAULT '0',
    withdraw_total TEXT DEFAULT '0',
    dynamic_quota TEXT DEFAULT '0',
    dynamic_withdrawn TEXT DEFAULT '0',
    converted_total TEXT DEFAULT '0',
    received_value TEXT DEFAULT '0',
    exit_day INTEGER DEFAULT 0,
    power_base TEXT DEFAULT '0',
    power_day INTEGER DEFAULT 0,
    is_exited INTEGER DEFAULT 0,
    updated_at INTEGER`;

const MYSQL_USERS_COLS = `address VARCHAR(42) PRIMARY KEY,
      deposit_total VARCHAR(80) DEFAULT '0',
      withdraw_total VARCHAR(80) DEFAULT '0',
      dynamic_quota VARCHAR(80) DEFAULT '0',
      dynamic_withdrawn VARCHAR(80) DEFAULT '0',
      converted_total VARCHAR(80) DEFAULT '0',
      received_value VARCHAR(80) DEFAULT '0',
      exit_day INT DEFAULT 0,
      power_base VARCHAR(80) DEFAULT '0',
      power_day INT DEFAULT 0,
      is_exited TINYINT(1) DEFAULT 0,
      updated_at BIGINT`;

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
    /**
     * 建空的影子表 users_next（2026-11-08）。
     * 重建流程：prepareUsersNext → 逐条写入 users_next → swapUsers 原子改名。
     */
    prepareUsersNext: async () => {
      d.exec("DROP TABLE IF EXISTS users_next;");
      d.exec(`CREATE TABLE users_next (${MEM_USERS_COLS});`);
    },
    /** 原子切换：SQLite 无多表 RENAME，两次改名放进同一次 exec，中间不插入其他语句 */
    swapUsers: async () => {
      d.exec("DROP TABLE IF EXISTS users_old;");
      d.exec("ALTER TABLE users RENAME TO users_old; ALTER TABLE users_next RENAME TO users;");
    },
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
    block_time INTEGER,
    UNIQUE(chain_id, tx_hash, log_index)
  );
  CREATE TABLE IF NOT EXISTS indexer_state (
    chain_id INTEGER PRIMARY KEY,
    last_block INTEGER NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS users (
    ${MEM_USERS_COLS}
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
    day_sold_gst TEXT DEFAULT '0',
    snapshot_pool_usdt TEXT DEFAULT '0',
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
    updated_at INTEGER,
    -- v9.2 卖币窗口（14/28 日历窗）字段；current_window/required_sell 为旧 4×15 天模型遗留，不再写入
    -- target_bps 复用为「当期档位（bps）」：2000 首期 / 1000 常规 / 200 达入金 60% 后
    window_id BIGINT DEFAULT 0,
    phase TEXT DEFAULT '',
    quota TEXT DEFAULT '0',
    deficit TEXT DEFAULT '0',
    deadline_sec BIGINT DEFAULT 0
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
    // 2026-11-07 抗雪崩：磁盘写满事故后补的兜底线
    //   背景：MySQL 卡在 waiting for handler commit 时，未设超时的连接会永久挂起，
    //   10 个连接被占满后所有查询无限排队，/stats 直接 120s 无响应。
    connectTimeout: 8000, // 建连超时，避免 TCP 握手挂死
    idleTimeout: 60_000, // 空闲连接回收，防长期占用
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
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
      block_time BIGINT DEFAULT NULL,
      UNIQUE KEY uk_evt (chain_id, tx_hash, log_index)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS indexer_state (
      chain_id INT PRIMARY KEY,
      last_block BIGINT NOT NULL,
      updated_at BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS users (
      ${MYSQL_USERS_COLS}
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
      day_sold_gst VARCHAR(80) DEFAULT '0',
      snapshot_pool_usdt VARCHAR(80) DEFAULT '0',
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
      updated_at BIGINT,
      window_id BIGINT DEFAULT 0,
      phase VARCHAR(16) DEFAULT '',
      quota VARCHAR(80) DEFAULT '0',
      deficit VARCHAR(80) DEFAULT '0',
      deadline_sec BIGINT DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];
  for (const sql of DDL) await pool.query(sql);

  // v17 列迁移：老库已存在 users 表时 CREATE TABLE IF NOT EXISTS 不会补列，需显式 ALTER（已存在则忽略）
  const MIGRATIONS = [
    "ALTER TABLE users ADD COLUMN converted_total VARCHAR(80) DEFAULT '0'",
    "ALTER TABLE users ADD COLUMN received_value VARCHAR(80) DEFAULT '0'",
    "ALTER TABLE users ADD COLUMN exit_day INT DEFAULT 0",
    "ALTER TABLE pool_state ADD COLUMN day_sold_gst VARCHAR(80) DEFAULT '0'",
    "ALTER TABLE pool_state ADD COLUMN snapshot_pool_usdt VARCHAR(80) DEFAULT '0'",
    // 2026-09-26：events 补区块时间戳列（power_day / exit_day 与合约 block.timestamp/86400 同口径）
    "ALTER TABLE events ADD COLUMN block_time BIGINT DEFAULT NULL",
    // 2026-10-14（v9.2）：force_sell 由「4×15 天窗口」改为「14/28 日历窗」，补窗口字段
    "ALTER TABLE force_sell ADD COLUMN window_id BIGINT DEFAULT 0",
    "ALTER TABLE force_sell ADD COLUMN phase VARCHAR(16) DEFAULT ''",
    "ALTER TABLE force_sell ADD COLUMN quota VARCHAR(80) DEFAULT '0'",
    "ALTER TABLE force_sell ADD COLUMN deficit VARCHAR(80) DEFAULT '0'",
    "ALTER TABLE force_sell ADD COLUMN deadline_sec BIGINT DEFAULT 0",
    // 2026-11-07：keeper_runs 加建表时间索引，配合 cleanRuns 的 7 天清理任务
    //   老库 CREATE TABLE IF NOT EXISTS 不会补索引，这条 ALTER 负责补齐（已存在则忽略）
    "ALTER TABLE keeper_runs ADD INDEX idx_runs_created (created_at)",
  ];
  for (const sql of MIGRATIONS) {
    try {
      await pool.query(sql);
    } catch {
      /* 列已存在，忽略 */
    }
  }

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
      // 2026-11-08：改用 query（文本协议）替代 execute（二进制预处理）。
      // 原因：影子表重建用 RENAME TABLE 切换 users，MySQL 会让已缓存的预处理语句失效，
      // 后续 execute 报 ER_NEED_REPREPARE。表数据量很小（百级用户 / 千级事件），文本协议足够。
      const [r] = await pool.query(translate(sql), params);
      return { affectedRows: r.affectedRows, insertId: r.insertId };
    },
    get: async (sql, params = []) => {
      const [rows] = await pool.query(translate(sql), params);
      return rows[0] ?? null;
    },
    all: async (sql, params = []) => {
      const [rows] = await pool.query(translate(sql), params);
      return rows;
    },
    /** 建空的影子表 users_next（2026-11-08），与 users 同结构 */
    prepareUsersNext: async () => {
      await pool.query("DROP TABLE IF EXISTS users_next");
      await pool.query(`CREATE TABLE users_next (${MYSQL_USERS_COLS}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    },
    /** 原子切换：MySQL 的 RENAME TABLE 多表操作在服务端一次性完成，读方无中间态 */
    swapUsers: async () => {
      await pool.query("DROP TABLE IF EXISTS users_old");
      await pool.query("RENAME TABLE users TO users_old, users_next TO users");
    },
  };
}
