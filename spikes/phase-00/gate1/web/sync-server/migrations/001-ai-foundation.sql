-- Independent additive AI schema. This migration deliberately does not change
-- PRAGMA user_version or sync_server_meta.schema_version: Audio v3 remains valid.
CREATE TABLE IF NOT EXISTS ai_schema_migrations (
  version INTEGER PRIMARY KEY CHECK(version > 0),
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_note_consent (
  note_id TEXT PRIMARY KEY CHECK(length(note_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK(state IN ('APPROVED_LOCAL_ONLY','APPROVED_CLOUD_ALLOWED','REVOKED')),
  scopes_json TEXT NOT NULL CHECK(length(CAST(scopes_json AS BLOB)) <= 512),
  provider_boundary TEXT NOT NULL CHECK(provider_boundary IN ('STRICT_LOCAL','EXTERNAL_CLOUD','MOCK')),
  consent_epoch INTEGER NOT NULL CHECK(consent_epoch > 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
);

CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  note_id TEXT NOT NULL CHECK(length(note_id) BETWEEN 1 AND 128),
  server_epoch TEXT NOT NULL CHECK(length(server_epoch) BETWEEN 1 AND 128),
  source_cursor INTEGER NOT NULL CHECK(source_cursor > 0),
  target_server_version INTEGER NOT NULL CHECK(target_server_version > 0),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  consent_epoch INTEGER NOT NULL CHECK(consent_epoch > 0),
  analysis_policy_version TEXT NOT NULL CHECK(length(analysis_policy_version) BETWEEN 1 AND 64),
  prompt_schema_version INTEGER NOT NULL CHECK(prompt_schema_version > 0),
  model_identity TEXT NOT NULL CHECK(length(model_identity) BETWEEN 1 AND 96),
  execution_boundary TEXT NOT NULL CHECK(execution_boundary IN ('STRICT_LOCAL','EXTERNAL_CLOUD','MOCK')),
  dedupe_key TEXT NOT NULL UNIQUE CHECK(length(dedupe_key) = 64),
  scope TEXT NOT NULL CHECK(scope IN ('organize')),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED_NEEDS_REVIEW','SUPERSEDED','CANCELED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  run_after INTEGER NOT NULL CHECK(run_after >= 0),
  lease_until INTEGER CHECK(lease_until IS NULL OR lease_until >= 0),
  worker_id TEXT CHECK(worker_id IS NULL OR length(worker_id) BETWEEN 1 AND 64),
  claim_token TEXT CHECK(claim_token IS NULL OR length(claim_token) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  CHECK((status = 'RUNNING' AND lease_until IS NOT NULL AND worker_id IS NOT NULL AND claim_token IS NOT NULL) OR status <> 'RUNNING')
);
CREATE INDEX IF NOT EXISTS ai_jobs_ready ON ai_jobs(status,run_after,created_at);
CREATE INDEX IF NOT EXISTS ai_jobs_note ON ai_jobs(note_id,target_server_version,status);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  job_id TEXT NOT NULL REFERENCES ai_jobs(id),
  note_id TEXT NOT NULL CHECK(length(note_id) BETWEEN 1 AND 128),
  target_server_version INTEGER NOT NULL CHECK(target_server_version > 0),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  status TEXT NOT NULL CHECK(status IN ('PENDING_REVIEW','REVOKED','STALE','ACCEPTED','REJECTED')),
  payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB)) <= 8192),
  provider_identity TEXT NOT NULL CHECK(length(provider_identity) BETWEEN 1 AND 96),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  UNIQUE(job_id)
);
CREATE INDEX IF NOT EXISTS ai_suggestions_note ON ai_suggestions(note_id,status,created_at);

CREATE TABLE IF NOT EXISTS ai_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK(action IN ('CONSENT_GRANTED','CONSENT_REVOKED','JOB_ENQUEUED','JOB_CLAIMED','JOB_COMPLETED','JOB_CANCELED','JOB_RETRIED','JOB_FAILED_NEEDS_REVIEW','JOB_SUPERSEDED','SUGGESTION_REVOKED')),
  note_id TEXT CHECK(note_id IS NULL OR length(note_id) BETWEEN 1 AND 128),
  job_id TEXT CHECK(job_id IS NULL OR length(job_id) BETWEEN 1 AND 128),
  actor_id TEXT CHECK(actor_id IS NULL OR length(actor_id) <= 128),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  metadata_json TEXT NOT NULL CHECK(length(CAST(metadata_json AS BLOB)) <= 1024),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
);
CREATE INDEX IF NOT EXISTS ai_audit_created ON ai_audit_log(created_at,id);

INSERT OR IGNORE INTO ai_schema_migrations(version,applied_at) VALUES(1,unixepoch());
