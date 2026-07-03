import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const defaultPath = join(__dirname, '..', '..', 'gateway.db');
const dbPath = process.env.DB_PATH || defaultPath;

const dataDir = dirname(dbPath);
if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_path TEXT NOT NULL,
        route_method TEXT NOT NULL,
        ip TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        algorithm TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ip_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('allow', 'deny')),
        note TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ip, action)
    );

    CREATE TABLE IF NOT EXISTS rate_limit_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_path TEXT NOT NULL,      -- API路径，如 '/api/users'
        route_method TEXT DEFAULT 'GET', -- HTTP方法
        max_requests INTEGER NOT NULL,   -- 窗口内最大请求数
        window_ms INTEGER NOT NULL,      -- 时间窗口（毫秒）
        algorithm TEXT DEFAULT 'sliding-window', -- 限流算法：fixed-window | sliding-window | token-bucket
        enabled INTEGER DEFAULT 1,       -- 是否启用：1启用，0禁用
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

console.log('数据库初始化完成');

export default db;