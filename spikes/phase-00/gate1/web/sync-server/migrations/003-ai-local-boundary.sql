-- AI ledger v3: allow an attested STRICT_LOCAL analysis request in addition to MOCK.
-- EXTERNAL_CLOUD stays impossible at the schema level. Rebuild is required because
-- SQLite cannot alter a CHECK constraint; rows and indexes are preserved.
CREATE TABLE ai_analysis_requests_v3 (
  request_id TEXT PRIMARY KEY CHECK(length(request_id) = 36),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  actor_device_id TEXT NOT NULL REFERENCES sync_devices(id),
  note_id TEXT NOT NULL CHECK(length(note_id) BETWEEN 1 AND 128),
  server_epoch TEXT NOT NULL CHECK(length(server_epoch) BETWEEN 1 AND 128),
  server_version INTEGER NOT NULL CHECK(server_version > 0),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  consent_epoch INTEGER NOT NULL CHECK(consent_epoch > 0),
  scope TEXT NOT NULL CHECK(scope = 'organize'),
  execution_boundary TEXT NOT NULL CHECK(execution_boundary IN ('MOCK','STRICT_LOCAL')),
  job_id TEXT NOT NULL REFERENCES ai_jobs(id),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) <= 2048),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
);
INSERT INTO ai_analysis_requests_v3 SELECT request_id,request_hash,actor_device_id,note_id,server_epoch,server_version,content_sha256,
  consent_epoch,scope,execution_boundary,job_id,result_json,created_at FROM ai_analysis_requests;
DROP TABLE ai_analysis_requests;
ALTER TABLE ai_analysis_requests_v3 RENAME TO ai_analysis_requests;
CREATE INDEX IF NOT EXISTS ai_analysis_requests_note ON ai_analysis_requests(note_id,server_version,created_at);
CREATE INDEX IF NOT EXISTS ai_analysis_requests_actor ON ai_analysis_requests(actor_device_id,created_at);

INSERT OR IGNORE INTO ai_schema_migrations(version,applied_at) VALUES(3,unixepoch());
