-- 001_baseline.sql
-- 屏幕笔记 · 数据底座基线迁移（共享于 Node 与 Rust 后端）。
-- 约定：通过 PRAGMA user_version 管理版本；本文件将版本推进到 1。
--
-- 迁移策略：
--   1. 迁移前由调用方备份 notes.sqlite3 到 data/backups/。
--   2. 每步包裹在事务中，失败回滚且保持旧版本可启动。
--   3. 幂等：重复执行不产生副作用（旧 notes 表若已存在则跳过重建）。
--
-- 注意：旧库只有一张 notes 表（title/summary/ocr_text/keywords/section 等）。
-- 本迁移在保留旧 notes 表不动的前提下，新增 sections/assets/drafts/
-- caption_sessions/transcripts 表，并新增字段以承接 v0.4 需求。

BEGIN;

-- 1. sections：一级分区（预留 parent_id 供后续多级）。
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 预置默认「收集箱」分区。
INSERT INTO sections (name, sort, builtin, created_at)
SELECT '收集箱', 0, 1, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM sections WHERE builtin = 1 AND name = '收集箱');

-- 2. 给旧 notes 表补充新字段（若不存在）。这些字段不改变旧列，纯增量。
-- kind / section_id / primary_asset_id / brief_json / detail_json /
-- ocr_raw / ocr_clean / ocr_lines_json / transcript_text
ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'screenshot';
ALTER TABLE notes ADD COLUMN section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL;
ALTER TABLE notes ADD COLUMN primary_asset_id INTEGER;
ALTER TABLE notes ADD COLUMN brief_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE notes ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE notes ADD COLUMN ocr_raw TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN ocr_clean TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN ocr_lines_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE notes ADD COLUMN transcript_text TEXT NOT NULL DEFAULT '';

-- 3. assets：图片等资源文件（只存相对路径，文件在 data/assets/）。
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  draft_id INTEGER REFERENCES drafts(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 4. drafts：可恢复草稿（选分区前不建正式笔记）。
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  brief_json TEXT NOT NULL DEFAULT '{}',
  detail_json TEXT NOT NULL DEFAULT '{}',
  ocr_raw TEXT NOT NULL DEFAULT '',
  ocr_clean TEXT NOT NULL DEFAULT '',
  ocr_lines_json TEXT NOT NULL DEFAULT '[]',
  transcript_text TEXT NOT NULL DEFAULT '',
  source_app TEXT NOT NULL DEFAULT '',
  window_title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  committed_note_id INTEGER
);

-- 5. caption_sessions：字幕会话。
CREATE TABLE IF NOT EXISTS caption_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  review_deadline INTEGER
);

-- 6. transcripts：字幕片段（final 字幕在会话期间写入待处理区）。
CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES caption_sessions(id) ON DELETE CASCADE,
  note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  is_final INTEGER NOT NULL DEFAULT 0,
  selected INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_assets_note ON assets(note_id);
CREATE INDEX IF NOT EXISTS idx_assets_draft ON assets(draft_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);

PRAGMA user_version = 1;

COMMIT;
