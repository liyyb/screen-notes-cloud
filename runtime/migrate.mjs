/**
 * 共享 SQL 迁移执行器（Node 端）。
 * 与 Rust 端 src-tauri/src/db.rs 未来应使用同一份 migrations/*.sql。
 *
 * 特性：
 *  - PRAGMA user_version 管理版本；
 *  - 迁移前自动备份到 data/backups/；
 *  - 每步事务化，失败回滚；
 *  - 幂等：已应用版本不重复执行；
 *  - 中断后从上次版本继续。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError } from '../contracts/errors.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '..', 'migrations');

/** 列出按版本号升序的迁移文件。 */
export function listMigrations(dir = MIGRATIONS_DIR) {
  const names = fs.readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => {
      const va = Number(a.split('_')[0]);
      const vb = Number(b.split('_')[0]);
      return va - vb;
    });
  return names.map((name) => ({
    name,
    version: Number(name.split('_')[0]),
    file: path.join(dir, name)
  }));
}

/** 读取数据库当前 user_version。 */
export function currentVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

/**
 * 应用所有尚未执行的迁移。
 * @param {object} db node:sqlite DatabaseSync 实例
 * @param {string} dataDir 数据目录（用于备份）
 * @returns {string[]} 已应用（含跳过）的迁移文件名
 */
export function migrate(db, dataDir) {
  const from = currentVersion(db);
  const migrations = listMigrations();
  const applied = [];

  for (const m of migrations) {
    if (m.version <= from) continue; // 已应用，跳过
    backup(db, dataDir, m.version);

    const sql = fs.readFileSync(m.file, 'utf8');
    // 迁移文件自身已含 BEGIN/COMMIT（保证在 Rust 等其他执行器中同样原子）。
    // 这里直接执行，不再额外包裹事务。
    try {
      db.exec(sql);
      applied.push(m.name);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 可能未开始事务 */ }
      throw new ContractError('MIGRATION_FAILED', `${m.name}: ${e?.message ?? e}`);
    }
  }
  return applied;
}

/** 迁移前备份数据库到 data/backups/，文件名带版本与时间戳。 */
function backup(db, dataDir, toVersion) {
  const backupsDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const dbPath = path.join(dataDir, 'notes.sqlite3');
  if (!fs.existsSync(dbPath)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir, `notes.sqlite3.pre-v${toVersion}-${ts}.bak`);
  // 使用 SQLite 在线备份语义：确保 WAL 已 checkpoint 后复制。
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  fs.copyFileSync(dbPath, dest);
}
