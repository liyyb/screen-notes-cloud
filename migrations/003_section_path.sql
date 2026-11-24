-- 003_section_path.sql
-- 屏幕笔记 · sections 增加磁盘路径字段。
-- 用户可为分区指定一个磁盘文件夹，该分区笔记的截图/文件直接写入该文件夹；
-- 未指定（NULL/空串）时回退到 data/assets/ 内部存储。
-- 将版本推进到 3。

BEGIN;

ALTER TABLE sections ADD COLUMN path TEXT NOT NULL DEFAULT '';

PRAGMA user_version = 3;

COMMIT;
