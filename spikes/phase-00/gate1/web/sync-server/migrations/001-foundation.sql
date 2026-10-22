CREATE TABLE sync_server_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  server_epoch TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  server_cursor INTEGER NOT NULL DEFAULT 0 CHECK(server_cursor>=0)
);
CREATE TABLE sync_devices (
  id TEXT PRIMARY KEY, label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE sync_operations (
  device_id TEXT NOT NULL REFERENCES sync_devices(id), operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, result_json TEXT NOT NULL, committed_cursor INTEGER NOT NULL,
  PRIMARY KEY(device_id, operation_id)
);
CREATE TABLE sync_changelog (
  server_cursor INTEGER PRIMARY KEY CHECK(server_cursor>0),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('note','recording')),
  entity_id TEXT NOT NULL, server_version INTEGER NOT NULL CHECK(server_version>0),
  event TEXT NOT NULL CHECK(event IN ('upsert','tombstone')),
  UNIQUE(server_cursor,entity_type,entity_id,server_version),
  UNIQUE(entity_type,entity_id,server_version)
);
CREATE TABLE sync_entities (
  entity_type TEXT NOT NULL CHECK(entity_type IN ('note','recording')), id TEXT NOT NULL,
  server_version INTEGER NOT NULL CHECK(server_version>0), record_json TEXT NOT NULL,
  content_hash TEXT NOT NULL, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived','trashed')),
  recording_count INTEGER NOT NULL DEFAULT 0 CHECK(recording_count>=0),
  committed_cursor INTEGER NOT NULL REFERENCES sync_changelog(server_cursor),
  PRIMARY KEY(entity_type,id),
  FOREIGN KEY(committed_cursor,entity_type,id,server_version) REFERENCES sync_changelog(server_cursor,entity_type,entity_id,server_version)
);
CREATE TABLE sync_tombstones (
  entity_type TEXT NOT NULL CHECK(entity_type IN ('note','recording')), id TEXT NOT NULL,
  server_version INTEGER NOT NULL CHECK(server_version>0),
  committed_cursor INTEGER NOT NULL REFERENCES sync_changelog(server_cursor),
  PRIMARY KEY(entity_type,id),
  FOREIGN KEY(committed_cursor,entity_type,id,server_version) REFERENCES sync_changelog(server_cursor,entity_type,entity_id,server_version)
);
CREATE TRIGGER sync_entity_not_deleted BEFORE INSERT ON sync_entities
WHEN EXISTS(SELECT 1 FROM sync_tombstones WHERE entity_type=NEW.entity_type AND id=NEW.id)
BEGIN SELECT RAISE(ABORT,'entity has tombstone'); END;
CREATE TRIGGER sync_entity_update_not_deleted BEFORE UPDATE ON sync_entities
WHEN EXISTS(SELECT 1 FROM sync_tombstones WHERE entity_type=NEW.entity_type AND id=NEW.id)
BEGIN SELECT RAISE(ABORT,'entity has tombstone'); END;
CREATE TRIGGER sync_tombstone_not_live BEFORE INSERT ON sync_tombstones
WHEN EXISTS(SELECT 1 FROM sync_entities WHERE entity_type=NEW.entity_type AND id=NEW.id)
BEGIN SELECT RAISE(ABORT,'entity remains live'); END;
CREATE TRIGGER sync_tombstone_update_not_live BEFORE UPDATE ON sync_tombstones
WHEN EXISTS(SELECT 1 FROM sync_entities WHERE entity_type=NEW.entity_type AND id=NEW.id)
BEGIN SELECT RAISE(ABORT,'entity remains live'); END;
CREATE TABLE sync_pairing (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), code_hash TEXT, expires_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0,
  window_attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sync_pairing(singleton) VALUES(1);
PRAGMA user_version=1;
