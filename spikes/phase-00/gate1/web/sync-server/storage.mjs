import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function transaction(db, fn, mode = 'IMMEDIATE') {
  db.exec(mode === 'DEFERRED' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function openStore(root, { initialize = false } = {}) {
  if (!root || !statSync(root).isDirectory()) throw new Error('Storage volume unavailable');
  const file = join(root, 'sync.sqlite'), marker = join(root, '.sync-epoch');
  if (!existsSync(file) && (!initialize || existsSync(marker))) throw new Error('Database missing; recovery review required');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2 || (version === 0 && !initialize)) throw new Error('Migration review required');
    if (version === 0) transaction(db, () => {
      // Recheck under the writer lock: concurrent first-time initialization is safe.
      if (db.prepare('PRAGMA user_version').get().user_version !== 0) return;
      db.exec(readFileSync(join(process.cwd(), 'sync-server/migrations/001-foundation.sql'), 'utf8'));
      db.prepare('INSERT INTO sync_server_meta VALUES(1,?,1,0)').run(randomUUID());
    });
    if (db.prepare('PRAGMA user_version').get().user_version === 1) transaction(db, () => {
      db.exec(readFileSync(join(process.cwd(), 'sync-server/migrations/002-incremental.sql'), 'utf8'));
    });
    const meta = serverMeta(db);
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim() !== meta.serverEpoch) throw new Error('Epoch mismatch; recovery review required');
    if (!existsSync(marker)) {
      if (!initialize) throw new Error('Epoch marker missing; recovery review required');
      writeFileSync(marker, meta.serverEpoch, { flag: 'wx', mode: 0o600 });
    }
    chmodSync(file, 0o600);
    return db;
  } catch (error) { db.close(); throw error; }
}

export function serverMeta(db) {
  const row = db.prepare('SELECT server_epoch, schema_version, server_cursor FROM sync_server_meta WHERE singleton=1').get();
  if (!row || !Number.isSafeInteger(row.server_cursor)) throw new Error('Invalid server history');
  return { serverEpoch: row.server_epoch, schemaVersion: row.schema_version, serverCursor: row.server_cursor };
}

// Reserved storage primitive, used only by isolated fixtures in 08.1. No HTTP caller.
// Must run inside the same transaction as the entity/tombstone and operation writes.
export function appendChange(db, type, id, version, event = 'upsert', record = null) {
  if (!db.isTransaction) throw new Error('Change allocation requires a transaction');
  const cursor = db.prepare('UPDATE sync_server_meta SET server_cursor=server_cursor+1 WHERE singleton=1 RETURNING server_cursor').get().server_cursor;
  if (!Number.isSafeInteger(cursor)) throw new Error('Cursor exhausted');
  db.prepare('INSERT INTO sync_changelog(server_cursor,entity_type,entity_id,server_version,event,record_json) VALUES(?,?,?,?,?,?)').run(cursor, type, id, version, event, record);
  return cursor;
}
