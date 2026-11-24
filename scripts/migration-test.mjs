/**
 * 数据底座迁移验收测试（Node 端）。
 * 验证：
 *  - 全新库迁移到最新版本，新表齐全；
 *  - 旧库（仅 notes 表 + section 字符串）无损迁移，section -> section_id 回填；
 *  - 迁移幂等：重复执行不报错、不重复建表；
 *  - 草稿与正式笔记严格分离（草稿不进 FTS、不进 notes）；
 *  - 备份在迁移前生成。
 * 使用临时目录，绝不触碰真实 data/。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { NoteStore } = await import('../runtime/db.mjs');
const { migrate, currentVersion, listMigrations } = await import('../runtime/migrate.mjs');

const results = [];
function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: String(detail ?? ''), duration_ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - t0 });
  }
}

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sn-mig-')); }

// 构造一个「旧库」：只有旧 notes 表 + section 字符串，无新表。
function makeLegacyDb(dir) {
  const db = new DatabaseSync(path.join(dir, 'notes.sqlite3'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      ocr_text TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      source_app TEXT NOT NULL DEFAULT '',
      window_title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      capture_mode TEXT NOT NULL,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL DEFAULT '',
      parse_ok INTEGER NOT NULL DEFAULT 1,
      ocr_chars INTEGER NOT NULL DEFAULT 0,
      ocr_hash TEXT NOT NULL DEFAULT '',
      merge_key TEXT NOT NULL DEFAULT '',
      section TEXT NOT NULL DEFAULT '收集箱'
    );
    CREATE VIRTUAL TABLE notes_fts USING fts5(title, summary, ocr_text, seg, tokenize='unicode61');
  `);
  db.prepare(`INSERT INTO notes (title, summary, ocr_text, keywords, source_app, window_title, created_at, updated_at, capture_mode, latency_ms, provider, parse_ok, ocr_chars, ocr_hash, merge_key, section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    '旧笔记', '旧摘要', '旧OCR内容', '[]', 'legacy', '旧窗口',
    Date.now(), Date.now(), 'manual', 0, 'LocalLlama', 1, 6, 'h', 'k', '工作'
  );
  const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(`INSERT INTO notes_fts(rowid, title, summary, ocr_text, seg) VALUES (?, ?, ?, ?, ?)`).run(
    id, '旧笔记', '旧摘要', '旧OCR内容', '旧 笔 记 旧 摘 要 旧 O C R 内 容'
  );
  db.close();
}

async function main() {
  // 1. 全新库迁移
  check('全新库迁移到最新版本', () => {
    const dir = tmpdir();
    const db = new NoteStore(dir);
    const v = currentVersion(db.db);
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    for (const t of ['notes', 'sections', 'assets', 'drafts', 'caption_sessions', 'transcripts']) {
      if (!tables.includes(t)) throw new Error(`缺少表 ${t}`);
    }
    const latest = listMigrations().at(-1);
    if (v !== latest.version) throw new Error(`user_version=${v}，期望 ${latest.version}`);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return `user_version=${v}，表 ${tables.join(',')}`;
  });

  // 2. 旧库无损迁移 + section 回填
  check('旧库无损迁移并回填 section_id', () => {
    const dir = tmpdir();
    makeLegacyDb(dir);
    const db = new NoteStore(dir);
    const note = db.list('', 10)[0];
    if (!note) throw new Error('旧笔记丢失');
    if (note.title !== '旧笔记' || note.ocr_text !== '旧OCR内容') throw new Error('旧笔记内容被改动');
    const sec = db.listSectionRows().find((s) => s.name === '工作');
    if (!sec) throw new Error('旧 section 字符串未迁移为分区');
    if (note.section_id !== sec.id) throw new Error(`section_id 未回填：${note.section_id} != ${sec.id}`);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return `旧笔记保留，section「工作」-> id ${sec.id}，回填成功`;
  });

  // 3. 迁移幂等
  check('迁移幂等（重复打开不报错、不重复建行）', () => {
    const dir = tmpdir();
    const db = new NoteStore(dir);
    const secBefore = db.listSectionRows().length;
    db.close();
    const db2 = new NoteStore(dir);
    const secAfter = db2.listSectionRows().length;
    if (db2.migrated.length !== 0) throw new Error(`不应再执行迁移，实际执行 ${db2.migrated.join(',')}`);
    if (secBefore !== secAfter) throw new Error(`重复打开导致分区行变化 ${secBefore}->${secAfter}`);
    db2.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return `重复打开 migrated=0，分区行 ${secBefore} 不变`;
  });

  // 4. 草稿与正式笔记严格分离
  check('草稿不进 notes / FTS，提交后进入', () => {
    const dir = tmpdir();
    const db = new NoteStore(dir);
    const d = db.createDraft({ kind: 'manual', brief: { display: '草稿简报' }, ocr_raw: '草稿OCR', source_app: 't', window_title: 't' });
    if (db.count() !== 0) throw new Error('草稿不应计入 notes');
    if (db.list('草稿OCR', 10).length !== 0) throw new Error('草稿不应进入 FTS 检索');
    const sec = db.listSectionRows()[0];
    const note = db.commitDraft(d.id, sec.id);
    if (db.count() !== 1) throw new Error('提交后应有 1 条笔记');
    if (db.list('草稿OCR', 10).length !== 1) throw new Error('提交后应可检索');
    if (db.getDraft(d.id).status !== 'committed') throw new Error('草稿状态未更新');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return `草稿提交前 0 笔记/0 命中，提交后 1 笔记/1 命中，草稿 committed`;
  });

  // 5. 迁移前备份
  check('迁移前生成备份', () => {
    const dir = tmpdir();
    makeLegacyDb(dir);
    const db = new NoteStore(dir);
    const backups = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.includes('pre-v'));
    if (backups.length === 0) throw new Error('未生成备份');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return `备份 ${backups[0]}`;
  });

  // 6. 提交后 section_id 关联正确 + 删除分区回落收集箱
  check('删除分区后笔记回落收集箱', () => {
    const dir = tmpdir();
    const db = new NoteStore(dir);
    const sec = db.createSection('临时分区');
    const d = db.createDraft({ kind: 'manual', brief: { display: 'x' }, ocr_raw: '内容' });
    const note = db.commitDraft(d.id, sec.id);
    if (note.section_id !== sec.id) throw new Error('提交后 section_id 未关联');
    db.deleteSection(sec.id);
    const after = db.get(note.id);
    const inbox = db.listSectionRows().find((s) => s.builtin);
    if (after.section_id !== inbox.id) throw new Error(`删除分区后未回落收集箱：${after.section_id}`);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return `删除分区后笔记 section_id 回落到收集箱 id ${inbox.id}`;
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 数据底座迁移测试 =====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${String(r.duration_ms).padStart(5)} ms  ${r.detail}`);
  console.log(`${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('MIGRATION_TEST_ERROR:', e);
  process.exit(1);
});
