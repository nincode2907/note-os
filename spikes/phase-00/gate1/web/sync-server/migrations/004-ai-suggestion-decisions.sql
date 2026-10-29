-- AI ledger v4: per-item owner decisions for the Suggestions Inbox.
-- Decisions store keys, states and revisions only; never suggestion or note text.
CREATE TABLE IF NOT EXISTS ai_suggestion_item_state (
  suggestion_id TEXT NOT NULL REFERENCES ai_suggestions(id),
  item_key TEXT NOT NULL CHECK(item_key IN ('category','summary') OR item_key GLOB 'tag:[0-9]' OR item_key GLOB 'tag:[0-9][0-9]' OR item_key GLOB 'task:[0-9]' OR item_key GLOB 'task:[0-9][0-9]' OR item_key GLOB 'related:[0-9]' OR item_key GLOB 'related:[0-9][0-9]'),
  decision TEXT NOT NULL CHECK(decision IN ('APPROVED','EDITED','REJECTED','DEFERRED','UNDONE')),
  version INTEGER NOT NULL CHECK(version > 0),
  applied_local_revision INTEGER CHECK(applied_local_revision IS NULL OR applied_local_revision >= 0),
  actor_device_id TEXT NOT NULL REFERENCES sync_devices(id),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(suggestion_id, item_key)
);

CREATE TABLE IF NOT EXISTS ai_suggestion_decisions (
  request_id TEXT PRIMARY KEY CHECK(length(request_id) = 36),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  suggestion_id TEXT NOT NULL REFERENCES ai_suggestions(id),
  note_id TEXT NOT NULL CHECK(length(note_id) BETWEEN 1 AND 128),
  item_key TEXT NOT NULL CHECK(length(item_key) BETWEEN 1 AND 16),
  decision TEXT NOT NULL CHECK(decision IN ('APPROVED','EDITED','REJECTED','DEFERRED','UNDONE')),
  prior_decision TEXT CHECK(prior_decision IS NULL OR prior_decision IN ('APPROVED','EDITED','REJECTED','DEFERRED','UNDONE')),
  item_version INTEGER NOT NULL CHECK(item_version > 0),
  applied_local_revision INTEGER CHECK(applied_local_revision IS NULL OR applied_local_revision >= 0),
  actor_device_id TEXT NOT NULL REFERENCES sync_devices(id),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) <= 1024),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
);
CREATE INDEX IF NOT EXISTS ai_suggestion_decisions_item ON ai_suggestion_decisions(suggestion_id,item_key,created_at);
CREATE INDEX IF NOT EXISTS ai_suggestion_decisions_note ON ai_suggestion_decisions(note_id,created_at);

INSERT OR IGNORE INTO ai_schema_migrations(version,applied_at) VALUES(4,unixepoch());
