-- Additive Phase 08.4A media schema. Existing v2 epoch, cursor, devices, notes,
-- operations, and text changelog are retained. The migration runs only when the
-- separately gated audio API is called.
ALTER TABLE sync_server_meta RENAME TO sync_server_meta_v2;
CREATE TABLE sync_server_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  server_epoch TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version=3),
  server_cursor INTEGER NOT NULL DEFAULT 0 CHECK(server_cursor>=0)
);
INSERT INTO sync_server_meta SELECT singleton,server_epoch,3,server_cursor FROM sync_server_meta_v2;
DROP TABLE sync_server_meta_v2;

CREATE TABLE sync_media_approvals (
  device_id TEXT NOT NULL REFERENCES sync_devices(id),
  note_id TEXT NOT NULL,
  approved INTEGER NOT NULL CHECK(approved IN (0,1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(device_id,note_id)
);

CREATE TABLE sync_media_objects (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>0),
  mime_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sync_media_uploads (
  transfer_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES sync_devices(id),
  recording_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  base_server_version INTEGER NOT NULL CHECK(base_server_version>=0),
  reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>0),
  state TEXT NOT NULL CHECK(state IN ('receiving','publishing','published','expired','conflict')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sync_media_uploads_device_state ON sync_media_uploads(device_id,state,expires_at);

CREATE TABLE sync_media_upload_chunks (
  transfer_id TEXT NOT NULL REFERENCES sync_media_uploads(transfer_id),
  chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>0),
  PRIMARY KEY(transfer_id,chunk_index)
);

CREATE TABLE sync_recording_media (
  recording_id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  object_sha256 TEXT NOT NULL REFERENCES sync_media_objects(sha256),
  mime_type TEXT NOT NULL,
  total_bytes INTEGER NOT NULL CHECK(total_bytes>0),
  chunk_size INTEGER NOT NULL CHECK(chunk_size>0),
  chunk_count INTEGER NOT NULL CHECK(chunk_count>0),
  server_version INTEGER NOT NULL CHECK(server_version>0),
  manifest_json TEXT NOT NULL,
  metadata_hash TEXT NOT NULL CHECK(length(metadata_hash)=64),
  updated_at INTEGER NOT NULL
);
CREATE INDEX sync_recording_media_note ON sync_recording_media(note_id,recording_id);

CREATE TABLE sync_recording_versions (
  recording_id TEXT NOT NULL,
  server_version INTEGER NOT NULL CHECK(server_version>0),
  device_id TEXT NOT NULL REFERENCES sync_devices(id),
  metadata_json TEXT NOT NULL,
  metadata_hash TEXT NOT NULL CHECK(length(metadata_hash)=64),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(recording_id,server_version)
);

CREATE TABLE sync_media_device_state (
  device_id TEXT NOT NULL REFERENCES sync_devices(id),
  recording_id TEXT NOT NULL,
  object_sha256 TEXT NOT NULL CHECK(length(object_sha256)=64),
  verified_bytes INTEGER NOT NULL CHECK(verified_bytes>0),
  verified_at INTEGER NOT NULL,
  PRIMARY KEY(device_id,recording_id)
);

CREATE TABLE sync_audio_conflicts (
  conflict_id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES sync_devices(id),
  base_server_version INTEGER NOT NULL CHECK(base_server_version>=0),
  local_metadata_json TEXT NOT NULL,
  remote_metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX sync_audio_conflicts_recording ON sync_audio_conflicts(recording_id,created_at);

PRAGMA user_version=3;
