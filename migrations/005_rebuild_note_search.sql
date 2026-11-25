-- The migration runtime supplies sn_segment_fts to preserve Chinese search.
BEGIN;
DELETE FROM notes_fts;
INSERT INTO notes_fts(rowid, title, summary, ocr_text, seg)
SELECT id, title, summary, body, sn_segment_fts(title || ' ' || summary || ' ' || body)
FROM (
  SELECT id, title, summary,
    CASE WHEN kind = 'transcript' THEN COALESCE(transcript_text, '')
         ELSE COALESCE(ocr_text, '') END AS body
  FROM notes
);
PRAGMA user_version = 5;
COMMIT;
