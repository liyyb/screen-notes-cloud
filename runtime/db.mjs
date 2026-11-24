/** SQLite + FTS5 note store. Chinese is indexed per-character for reliable substring search. */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { migrate, currentVersion } from './migrate.mjs';
import { ContractError } from '../contracts/errors.mjs';

const CJK = /[\u3400-\u9fff\u3040-\u30ff]/g;

export function segmentForFts(text) {
  return String(text ?? '')
    .replace(CJK, (c) => ` ${c} `)
    .replace(/[\s]+/g, ' ')
    .trim();
}

function buildMatch(query) {
  const seg = segmentForFts(query);
  const tokens = seg.split(' ').filter((t) => t.length > 0);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}

function rowToNote(row) {
  if (!row) return null;
  let keywords = [];
  try { keywords = JSON.parse(row.keywords || '[]'); } catch { keywords = []; }
  return {
    id: Number(row.id),
    title: row.title,
    summary: row.summary,
    ocr_text: row.ocr_text,
    keywords,
    source_app: row.source_app,
    window_title: row.window_title,
    section: row.section || '收集箱',
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    capture_mode: row.capture_mode,
    latency_ms: Number(row.latency_ms),
    provider: row.provider,
    parse_ok: !!row.parse_ok,
    ocr_chars: Number(row.ocr_chars),
    section_id: row.section_id == null ? null : Number(row.section_id),
    kind: row.kind ?? 'screenshot',
    transcript_text: row.transcript_text ?? '',
    primary_asset_id: row.primary_asset_id == null ? null : Number(row.primary_asset_id)
  };
}

function rowToDraft(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    kind: row.kind,
    status: row.status,
    brief_json: row.brief_json ?? '{}',
    detail_json: row.detail_json ?? '{}',
    ocr_raw: row.ocr_raw ?? '',
    ocr_clean: row.ocr_clean ?? '',
    ocr_lines_json: row.ocr_lines_json ?? '[]',
    transcript_text: row.transcript_text ?? '',
    source_app: row.source_app ?? '',
    window_title: row.window_title ?? '',
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    committed_note_id: row.committed_note_id == null ? null : Number(row.committed_note_id)
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/**
 * A killed process can leave a stale -wal / -shm behind and SQLite then opens
 * the main file effectively read-only, which produces a confusing
 * "attempt to write a readonly database" on every later INSERT. Probe write
 * access at construction time, retry once, and otherwise fail with an
 * actionable message instead of letting half the selftest fail mysteriously.
 */
function openWritable(dbPath) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let db;
    try {
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      db.exec('CREATE TABLE IF NOT EXISTS _sn_write_probe (id INTEGER)');
      db.exec('DROP TABLE IF EXISTS _sn_write_probe');
      return db;
    } catch (e) {
      lastErr = e;
      try { db?.close(); } catch { /* ignore */ }
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 200);
    }
  }
  throw new Error(
    `笔记数据库无法写入：${dbPath}（${lastErr?.message ?? 'unknown'}）。` +
    '请确认没有其他屏幕笔记实例正在运行；若仍失败，退出后删除 data/notes.sqlite3-wal 与 data/notes.sqlite3-shm 再启动。'
  );
}

export class NoteStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'notes.sqlite3');
    this.db = openWritable(this.dbPath);
    // 建立旧表与 FTS（保持向后兼容）。新表（sections/assets/drafts 等）由共享迁移负责。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
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
      CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notes_merge ON notes(merge_key, created_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, summary, ocr_text, seg, tokenize='unicode61'
      );
    `);
    // Forward-compatible migration for databases created before sections existed.
    const cols = this.db.prepare('PRAGMA table_info(notes)').all().map((c) => c.name);
    if (!cols.includes('section')) {
      this.db.exec("ALTER TABLE notes ADD COLUMN section TEXT NOT NULL DEFAULT '收集箱'");
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_notes_section ON notes(section)');
    // 应用共享迁移（sections/assets/drafts/caption_sessions/transcripts）。
    this.migrated = migrate(this.db, dataDir);
    this._buildStatements();
  }

  _buildStatements() {
    this.stmts = {
      insert: this.db.prepare(`INSERT INTO notes
        (title, summary, ocr_text, keywords, source_app, window_title, created_at, updated_at,
         capture_mode, latency_ms, provider, parse_ok, ocr_chars, ocr_hash, merge_key, section)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      ftsInsert: this.db.prepare(`INSERT INTO notes_fts(rowid, title, summary, ocr_text, seg) VALUES (?, ?, ?, ?, ?)`),
      ftsDelete: this.db.prepare('DELETE FROM notes_fts WHERE rowid = ?'),
      get: this.db.prepare('SELECT * FROM notes WHERE id = ?'),
      update: this.db.prepare('UPDATE notes SET title=?, summary=?, updated_at=? WHERE id=?'),
      setSection: this.db.prepare('UPDATE notes SET section=?, updated_at=? WHERE id=?'),
      del: this.db.prepare('DELETE FROM notes WHERE id = ?'),
      count: this.db.prepare('SELECT COUNT(*) AS c FROM notes'),
      latest: this.db.prepare('SELECT * FROM notes WHERE (? = \'\' OR section = ?) ORDER BY created_at DESC LIMIT ?'),
      search: this.db.prepare(`SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.rowid
        WHERE notes_fts MATCH ? AND (? = '' OR n.section = ?) ORDER BY n.created_at DESC LIMIT ?`),
      sections: this.db.prepare('SELECT section, COUNT(*) AS c FROM notes GROUP BY section ORDER BY MIN(created_at) ASC'),
      mergeCandidate: this.db.prepare(`SELECT * FROM notes WHERE merge_key = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`),
      lastByHash: this.db.prepare('SELECT * FROM notes WHERE ocr_hash = ? ORDER BY created_at DESC LIMIT 1'),
      clear: this.db.prepare('DELETE FROM notes')
    };
  }

  syncFts(id, title, summary, ocrText) {
    this.stmts.ftsDelete.run(id);
    this.stmts.ftsInsert.run(
      id, title, summary, ocrText,
      segmentForFts(`${title} ${summary} ${ocrText}`)
    );
  }

  insert(note) {
    const now = note.created_at ?? Date.now();
    const r = this.stmts.insert.run(
      note.title, note.summary, note.ocr_text, JSON.stringify(note.keywords ?? []),
      note.source_app ?? '', note.window_title ?? '', now, note.updated_at ?? now,
      note.capture_mode ?? 'manual', note.latency_ms ?? 0, note.provider ?? 'LocalLlama',
      note.parse_ok === false ? 0 : 1, (note.ocr_text ?? '').length,
      note.ocr_hash ?? '', note.merge_key ?? '', note.section ?? '收集箱'
    );
    const id = Number(r.lastInsertRowid);
    this.syncFts(id, note.title, note.summary, note.ocr_text);
    return this.get(id);
  }

  get(id) { return rowToNote(this.stmts.get.get(id)); }

  update(id, title, summary) {
    this.stmts.update.run(title, summary, Date.now(), id);
    const n = this.get(id);
    if (n) this.syncFts(id, n.title, n.summary, n.ocr_text);
    return n;
  }

  replaceContent(id, patch) {
    const n = this.get(id);
    if (!n) return null;
    this.db.prepare(`UPDATE notes SET title=?, summary=?, keywords=?, ocr_text=?, ocr_chars=?, updated_at=?,
      latency_ms=?, provider=?, parse_ok=?, ocr_hash=? WHERE id=?`).run(
      patch.title, patch.summary, JSON.stringify(patch.keywords ?? []), patch.ocr_text,
      patch.ocr_text.length, Date.now(), patch.latency_ms ?? n.latency_ms,
      patch.provider ?? n.provider, patch.parse_ok === false ? 0 : 1,
      patch.ocr_hash ?? n.ocr_hash, id
    );
    this.syncFts(id, patch.title, patch.summary, patch.ocr_text);
    return this.get(id);
  }

  delete(id) {
    this.stmts.del.run(id);
    this.stmts.ftsDelete.run(id);
    return true;
  }

  clear() {
    this.stmts.clear.run();
    this.db.exec('DELETE FROM notes_fts;');
    return true;
  }

  list(query = '', limit = 200, section = '') {
    const match = buildMatch(query);
    const sec = String(section ?? '').trim();
    const rows = match
      ? this.stmts.search.all(match, sec, sec, limit)
      : this.stmts.latest.all(sec, sec, limit);
    return rows.map(rowToNote);
  }

  listSections() {
    const rows = this.stmts.sections.all();
    return [
      { name: '全部', count: this.count(), builtin: true },
      ...rows.map((r) => ({ name: r.section || '收集箱', count: Number(r.c), builtin: false }))
    ];
  }

  setSection(id, section) {
    const name = String(section ?? '').trim().slice(0, 40) || '收集箱';
    this.stmts.setSection.run(name, Date.now(), id);
    return this.get(id);
  }

  searchCount(query, limit = 50) { return this.list(query, limit).length; }

  count() { return Number(this.stmts.count.get().c); }

  mergeCandidate(mergeKey, sinceMs) {
    return rowToNote(this.stmts.mergeCandidate.get(mergeKey, sinceMs));
  }

  lastByHash(hash) { return rowToNote(this.stmts.lastByHash.get(hash)); }

  toMarkdown(n) {
    const d = new Date(n.created_at);
    const pad = (x) => String(x).padStart(2, '0');
    const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return [
      `# ${n.title}`,
      '',
      `> 时间：${time}  `,
      `> 来源：${n.source_app || '未知'} / ${n.window_title || '未知窗口'}  `,
      `> 方式：${n.capture_mode === 'auto' ? '自动记录' : '手动记录'}  `,
      `> 分区：${n.section || '收集箱'}  `,
      `> 关键词：${(n.keywords || []).join('、') || '无'}`,
      '',
      '## 摘要',
      '',
      n.summary || '（无摘要）',
      '',
      '## OCR 原文',
      '',
      '```text',
      n.ocr_text || '（未识别到文字）',
      '```',
      ''
    ].join('\n');
  }

  // ---------------- sections / drafts / assets ----------------

  /** 新建分区。path 可选：指定磁盘文件夹作为该分区存储位置。 */
  createSection(name, sectionPath = '') {
    const n = String(name ?? '').trim().slice(0, 40);
    if (!n) throw new ContractError('INVALID_ARGS', '分区名不能为空');
    const p = String(sectionPath ?? '').trim();
    const now = Date.now();
    const r = this.db.prepare('INSERT INTO sections (name, sort, builtin, path, created_at) VALUES (?, 0, 0, ?, ?)').run(n, p, now);
    return this.getSection(Number(r.lastInsertRowid));
  }

  getSection(id) {
    const row = this.db.prepare('SELECT * FROM sections WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: Number(row.id),
      parent_id: row.parent_id == null ? null : Number(row.parent_id),
      name: row.name,
      sort: Number(row.sort),
      builtin: !!row.builtin,
      path: row.path ?? '',
      count: Number(this.db.prepare('SELECT COUNT(*) AS c FROM notes WHERE section_id = ?').get(id)?.c ?? 0)
    };
  }

  /** 更新分区存储路径。 */
  setSectionPath(id, sectionPath) {
    this.db.prepare('UPDATE sections SET path = ? WHERE id = ?').run(String(sectionPath ?? '').trim(), id);
    return this.getSection(id);
  }

  listSectionRows() {
    return this.db.prepare('SELECT * FROM sections ORDER BY sort ASC, id ASC').all().map((row) => this.getSection(row.id));
  }

  renameSection(id, name) {
    const n = String(name ?? '').trim().slice(0, 40);
    if (!n) throw new ContractError('INVALID_ARGS', '分区名不能为空');
    this.db.prepare('UPDATE sections SET name = ? WHERE id = ?').run(n, id);
    // 同步旧的 notes.section 字符串字段，保证旧 UI/搜索仍一致。
    this.db.prepare("UPDATE notes SET section = ? WHERE section_id = ?").run(n, id);
    return this.getSection(id);
  }

  deleteSection(id) {
    const s = this.getSection(id);
    if (!s) return false;
    if (s.builtin) throw new ContractError('INVALID_ARGS', '内置分区不可删除');
    // 该分区下的笔记回落到「收集箱」。
    const inbox = this.db.prepare("SELECT id FROM sections WHERE builtin = 1 AND name = '收集箱' LIMIT 1").get();
    const inboxId = inbox ? Number(inbox.id) : null;
    this.db.exec('BEGIN');
    try {
      if (inboxId != null) {
        this.db.prepare('UPDATE notes SET section_id = ? WHERE section_id = ?').run(inboxId, id);
        this.db.prepare("UPDATE notes SET section = '收集箱' WHERE section_id = ?").run(inboxId);
      } else {
        this.db.prepare('UPDATE notes SET section_id = NULL WHERE section_id = ?').run(id);
      }
      this.db.prepare('DELETE FROM sections WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return true;
  }

  /** 草稿 CRUD：不进入 FTS、不进 notes。 */

  createDraft(draft) {
    const now = draft.created_at ?? Date.now();
    const r = this.db.prepare(`INSERT INTO drafts
      (kind, status, brief_json, detail_json, ocr_raw, ocr_clean, ocr_lines_json,
       transcript_text, source_app, window_title, created_at, updated_at)
      VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      draft.kind ?? 'manual',
      JSON.stringify(draft.brief ?? {}),
      JSON.stringify(draft.detail ?? {}),
      draft.ocr_raw ?? '',
      draft.ocr_clean ?? '',
      JSON.stringify(draft.ocr_lines ?? []),
      draft.transcript_text ?? '',
      draft.source_app ?? '',
      draft.window_title ?? '',
      now, now
    );
    return this.getDraft(Number(r.lastInsertRowid));
  }

  getDraft(id) {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
    return row ? rowToDraft(row) : null;
  }

  listDrafts(status = null) {
    const rows = status
      ? this.db.prepare('SELECT * FROM drafts WHERE status = ? ORDER BY updated_at DESC').all(status)
      : this.db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC').all();
    return rows.map(rowToDraft);
  }

  discardDraft(id) {
    const r = this.db.prepare("UPDATE drafts SET status = 'discarded', updated_at = ? WHERE id = ?").run(Date.now(), id);
    return r.changes > 0;
  }

  /** 将草稿提交为正式笔记：事务中建 notes + FTS + 回填 draft.committed_note_id。 */
  commitDraft(id, sectionId) {
    const draft = this.getDraft(id);
    if (!draft) throw new ContractError('NOT_FOUND', `草稿 #${id} 不存在`);
    if (draft.status === 'committed') throw new ContractError('DRAFT_NOT_COMMITTED', '草稿已归档');
    const brief = draft.brief_json ? safeJson(draft.brief_json) : {};
    const sec = sectionId != null ? this.getSection(sectionId) : null;
    const sectionName = sec?.name ?? '收集箱';
    let noteId;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO notes
        (title, summary, ocr_text, keywords, source_app, window_title, created_at, updated_at,
         capture_mode, latency_ms, provider, parse_ok, ocr_chars, section, section_id,
         kind, brief_json, detail_json, ocr_raw, ocr_clean, ocr_lines_json, transcript_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        '',
        brief.display ?? '',
        draft.ocr_clean || draft.ocr_raw || '',
        '[]',
        draft.source_app ?? '',
        draft.window_title ?? '',
        Date.now(), Date.now(),
        'manual',
        brief.provider ?? 'LocalLlama',
        brief.parse_ok === false ? 0 : 1,
        (draft.ocr_raw ?? '').length,
        sectionName,
        sec ? sec.id : null,
        draft.kind === 'auto_promoted' ? 'auto_promoted' : 'screenshot',
        draft.brief_json ?? '{}',
        draft.detail_json ?? '{}',
        draft.ocr_raw ?? '',
        draft.ocr_clean ?? '',
        draft.ocr_lines_json ?? '[]',
        draft.transcript_text ?? ''
      );
      noteId = Number(this.db.prepare('SELECT last_insert_rowid() AS id').get().id);
      this.db.prepare('UPDATE drafts SET status = ?, committed_note_id = ?, updated_at = ? WHERE id = ?').run('committed', noteId, Date.now(), id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.syncFts(noteId, '', brief.display ?? '', draft.ocr_clean || draft.ocr_raw || '');
    this.transferDraftAssets(id, noteId);
    return this.get(noteId);
  }

  // ---------------- assets ----------------

  /** 新增图片资源记录。relative_path 指向 data/assets/ 下文件。 */
  addAsset(asset) {
    const now = asset.created_at ?? Date.now();
    const r = this.db.prepare(`INSERT INTO assets
      (note_id, draft_id, relative_path, mime, width, height, bytes, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      asset.note_id ?? null,
      asset.draft_id ?? null,
      asset.relative_path,
      asset.mime ?? 'image/png',
      asset.width ?? 0,
      asset.height ?? 0,
      asset.bytes ?? 0,
      asset.sha256 ?? '',
      now
    );
    return Number(r.lastInsertRowid);
  }

  listAssets(noteId = null, draftId = null) {
    const rows = noteId != null
      ? this.db.prepare('SELECT * FROM assets WHERE note_id = ? ORDER BY id').all(noteId)
      : draftId != null
        ? this.db.prepare('SELECT * FROM assets WHERE draft_id = ? ORDER BY id').all(draftId)
        : [];
    return rows.map((r) => ({
      id: Number(r.id),
      note_id: r.note_id == null ? null : Number(r.note_id),
      draft_id: r.draft_id == null ? null : Number(r.draft_id),
      relative_path: r.relative_path,
      mime: r.mime,
      width: Number(r.width),
      height: Number(r.height),
      bytes: Number(r.bytes),
      sha256: r.sha256,
      created_at: Number(r.created_at)
    }));
  }

  /** 批量取多个笔记的主图 relative_path，映射 note_id -> path（供列表缩略图）。 */
  primaryAssetPaths(noteIds) {
    const ids = [...new Set((noteIds ?? []).filter((n) => n != null).map(Number))];
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT a.note_id AS note_id, a.relative_path AS relative_path FROM assets a
       WHERE a.note_id IN (${placeholders})
       ORDER BY a.id ASC`
    ).all(...ids);
    const map = new Map();
    for (const r of rows) {
      if (!map.has(Number(r.note_id))) map.set(Number(r.note_id), r.relative_path);
    }
    return map;
  }

  /** 关联资产到草稿（commit 时再转移到 note）。 */
  linkAssetToDraft(assetId, draftId) {
    this.db.prepare('UPDATE assets SET draft_id = ? WHERE id = ?').run(draftId, assetId);
  }

  /** 给已存在的正式笔记附加一张主图（captureOnce 直接建笔记链路用）。 */
  attachPrimaryImage(noteId, asset) {
    const assetId = this.addAsset({ ...asset, note_id: noteId });
    this.db.prepare('UPDATE notes SET primary_asset_id = ? WHERE id = ? AND primary_asset_id IS NULL').run(assetId, noteId);
    return assetId;
  }

  /** commit 时将草稿资产转移到正式笔记。 */
  transferDraftAssets(draftId, noteId) {
    this.db.prepare('UPDATE assets SET draft_id = NULL, note_id = ? WHERE draft_id = ?').run(noteId, draftId);
    // 设置 primary_asset_id 为第一张图片。
    const first = this.db.prepare('SELECT id FROM assets WHERE note_id = ? ORDER BY id LIMIT 1').get(noteId);
    if (first) {
      this.db.prepare('UPDATE notes SET primary_asset_id = ? WHERE id = ?').run(first.id, noteId);
    }
  }

  // ---------------- close ----------------

  close() { this.db.close(); }
}
