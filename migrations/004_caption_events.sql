BEGIN;
ALTER TABLE transcripts ADD COLUMN utterance_key TEXT;
CREATE UNIQUE INDEX transcripts_utterance ON transcripts(session_id,utterance_key) WHERE utterance_key IS NOT NULL;
CREATE TABLE caption_issues (
 id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES caption_sessions(id),
 utterance_key TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
 message TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
 UNIQUE(session_id,utterance_key)
);
PRAGMA user_version = 4;
COMMIT;
