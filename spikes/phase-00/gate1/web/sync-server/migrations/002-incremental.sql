-- Add immutable event payloads so paginated pulls can replay exact committed versions.
ALTER TABLE sync_changelog ADD COLUMN record_json TEXT;
ALTER TABLE sync_server_meta RENAME TO sync_server_meta_v1;
CREATE TABLE sync_server_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  server_epoch TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version=2),
  server_cursor INTEGER NOT NULL DEFAULT 0 CHECK(server_cursor>=0)
);
INSERT INTO sync_server_meta SELECT singleton,server_epoch,2,server_cursor FROM sync_server_meta_v1;
DROP TABLE sync_server_meta_v1;
PRAGMA user_version=2;
