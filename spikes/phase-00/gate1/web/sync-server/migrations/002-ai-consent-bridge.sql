-- Separate AI ledger migration. This does not alter PRAGMA user_version,
-- sync_server_meta, Sync Protocol v1, or Audio schema v3.
CREATE TABLE IF NOT EXISTS ai_consent_operations (
  request_id TEXT PRIMARY KEY CHECK(length(request_id) = 36),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  actor_device_id TEXT NOT NULL REFERENCES sync_devices(id),
  note_id TEXT NOT NULL CHECK(length(note_id) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK(action IN ('GRANT','REVOKE')),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) <= 2048),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
);
CREATE INDEX IF NOT EXISTS ai_consent_operations_note ON ai_consent_operations(note_id,created_at);

CREATE TABLE IF NOT EXISTS ai_analysis_requests (
  request_id TEXT PRIMARY KEY CHECK(length(request_id) = 36),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  actor_device_id TEXT NOT NULL REFERENCES sync_devices(id),
  note_id TEXT NOT NULL CHECK(length(note_id) BETWEEN 1 AND 128),
  server_epoch TEXT NOT NULL CHECK(length(server_epoch) BETWEEN 1 AND 128),
  server_version INTEGER NOT NULL CHECK(server_version > 0),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  consent_epoch INTEGER NOT NULL CHECK(consent_epoch > 0),
  scope TEXT NOT NULL CHECK(scope = 'organize'),
  execution_boundary TEXT NOT NULL CHECK(execution_boundary = 'MOCK'),
  job_id TEXT NOT NULL REFERENCES ai_jobs(id),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) <= 2048),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
);
CREATE INDEX IF NOT EXISTS ai_analysis_requests_note ON ai_analysis_requests(note_id,server_version,created_at);
CREATE INDEX IF NOT EXISTS ai_analysis_requests_actor ON ai_analysis_requests(actor_device_id,created_at);

-- One bounded fixed-window bucket per paired device; old windows overwrite in place.
CREATE TABLE IF NOT EXISTS ai_bridge_rate_limits (
  device_id TEXT PRIMARY KEY REFERENCES sync_devices(id),
  window_started_at INTEGER NOT NULL CHECK(window_started_at >= 0),
  request_count INTEGER NOT NULL CHECK(request_count BETWEEN 1 AND 60)
);

INSERT OR IGNORE INTO ai_schema_migrations(version,applied_at) VALUES(2,unixepoch());
