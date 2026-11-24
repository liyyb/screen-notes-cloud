-- 002_backfill_sections.sql
-- 将旧 notes.section 字符串迁移为 sections 实体并回填 notes.section_id。
-- 幂等：仅当存在 section 字符串但 section_id 为空时才回填。
-- 版本推进到 2。

BEGIN;

-- 为每个旧 section 字符串创建对应 sections 行（若不存在）。
INSERT INTO sections (name, sort, builtin, created_at)
SELECT DISTINCT
  CASE WHEN section = '' THEN '收集箱' ELSE section END AS name,
  0, 0,
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM notes
WHERE (section IS NOT NULL AND section != '')
  OR section = '';

-- 回填 notes.section_id（仅当 section_id 为空时）。
UPDATE notes
SET section_id = (
  SELECT s.id FROM sections s
  WHERE s.name = CASE WHEN notes.section = '' THEN '收集箱' ELSE notes.section END
  ORDER BY s.id LIMIT 1
)
WHERE section_id IS NULL;

PRAGMA user_version = 2;

COMMIT;
