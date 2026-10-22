import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeQuickCaptureNote, makeQuickVoiceNote } from '../../web/app/lib/quick-capture.mjs';
import {
  QUICK_CAPTURE_SCHEMA_V4_SQL,
  commitQuickCaptureNote,
  commitQuickVoicePending,
  deleteQuickCaptureDraft,
  migrateQuickCaptureSchema,
  upsertQuickCaptureDraft,
} from '../quick-capture-store.mjs';

function createTestDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE notes(id TEXT PRIMARY KEY,record_json TEXT,revision INTEGER,lifecycle TEXT,updated_at INTEGER);
    CREATE TABLE recordings(id TEXT PRIMARY KEY,note_id TEXT,title TEXT,file_uri TEXT,status TEXT,created_at INTEGER);
    CREATE TABLE recording_archive_metadata(recording_id TEXT PRIMARY KEY,metadata_json TEXT);
    CREATE TABLE recovery_drafts(note_id TEXT PRIMARY KEY,draft_json TEXT);
    CREATE TABLE file_cleanup(file_uri TEXT PRIMARY KEY);
    PRAGMA user_version=3;`);
  const txn = {
    async execAsync(sql) { db.exec(sql); },
    async getFirstAsync(sql, ...params) { return db.prepare(sql).get(...params) ?? null; },
    async getAllAsync(sql, ...params) { return db.prepare(sql).all(...params); },
    async runAsync(sql, ...params) { const result = db.prepare(sql).run(...params); return { changes: Number(result.changes) }; },
  };
  const database = {
    async getFirstAsync(...args) { return txn.getFirstAsync(...args); },
    async withExclusiveTransactionAsync(callback) {
      db.exec('BEGIN EXCLUSIVE');
      try { const result = await callback(txn); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, database, txn };
}

test('v4 migration is additive and keeps existing notes, recordings, editor journals and cleanup rows', async () => {
  const { db, database, txn } = createTestDatabase();
  await txn.runAsync('INSERT INTO notes VALUES(?,?,?,?,?)', 'old', JSON.stringify({ id: 'old' }), 7, 'active', 9);
  await txn.runAsync('INSERT INTO recordings VALUES(?,?,?,?,?,?)', 'audio', 'old', 'old audio', 'file:///old.m4a', 'complete', 10);
  await txn.runAsync('INSERT INTO recovery_drafts VALUES(?,?)', 'old', 'keep draft');
  await txn.runAsync('INSERT INTO file_cleanup VALUES(?)', 'file:///queued');
  await migrateQuickCaptureSchema(database);
  await migrateQuickCaptureSchema(database);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(db.prepare('SELECT record_json FROM notes WHERE id=?').get('old').record_json, JSON.stringify({ id: 'old' }));
  assert.equal(db.prepare('SELECT file_uri FROM recordings WHERE id=?').get('audio').file_uri, 'file:///old.m4a');
  assert.equal(db.prepare('SELECT draft_json FROM recovery_drafts WHERE note_id=?').get('old').draft_json, 'keep draft');
  assert.equal(db.prepare('SELECT file_uri FROM file_cleanup').get().file_uri, 'file:///queued');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='quick_capture_drafts'").get());
  assert.ok(QUICK_CAPTURE_SCHEMA_V4_SQL.includes('quick_voice_pending'));
  db.close();
});

test('native capture draft writes are versioned, retryable, and stale saves cannot clear newer text', async () => {
  const { db, database, txn } = createTestDatabase();
  await migrateQuickCaptureSchema(database);
  await database.withExclusiveTransactionAsync((tx) => upsertQuickCaptureDraft(tx, { body: 'old', sequence: 1, noteJson: '{"id":"n1"}', updatedAt: 1 }));
  await database.withExclusiveTransactionAsync((tx) => upsertQuickCaptureDraft(tx, { body: 'new', sequence: 2, noteJson: null, updatedAt: 2 }));
  await database.withExclusiveTransactionAsync((tx) => upsertQuickCaptureDraft(tx, { body: 'older late write', sequence: 1, noteJson: '{"id":"n1"}', updatedAt: 3 }));
  let draft = db.prepare('SELECT body,sequence,note_json FROM quick_capture_drafts WHERE draft_id=?').get('home');
  assert.deepEqual({ ...draft }, { body: 'new', sequence: 2, note_json: null });
  await database.withExclusiveTransactionAsync((tx) => upsertQuickCaptureDraft(tx, { body: 'new', sequence: 2, noteJson: '{"id":"stable"}', updatedAt: 4 }));
  await database.withExclusiveTransactionAsync((tx) => upsertQuickCaptureDraft(tx, { body: 'new', sequence: 2, noteJson: null, updatedAt: 5 }));
  draft = db.prepare('SELECT body,sequence,note_json FROM quick_capture_drafts WHERE draft_id=?').get('home');
  assert.equal(draft.note_json, '{"id":"stable"}');
  await database.withExclusiveTransactionAsync((tx) => deleteQuickCaptureDraft(tx, { sequence: 1 }));
  assert.ok(db.prepare('SELECT draft_id FROM quick_capture_drafts WHERE draft_id=?').get('home'));
  await database.withExclusiveTransactionAsync((tx) => deleteQuickCaptureDraft(tx, { sequence: 2 }));
  assert.equal(db.prepare('SELECT draft_id FROM quick_capture_drafts').get(), undefined);
  db.close();
});

test('native Quick Text note commit is idempotent and only creates an ordinary revision-zero note', async () => {
  const { db, database } = createTestDatabase();
  const note = makeQuickCaptureNote('Việt 東京\nExpo SQLite', { id: 'quick-note', now: 44 });
  await migrateQuickCaptureSchema(database);
  const first = await database.withExclusiveTransactionAsync((txn) => commitQuickCaptureNote(txn, note));
  const retry = await database.withExclusiveTransactionAsync((txn) => commitQuickCaptureNote(txn, note));
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(db.prepare('SELECT count(*) AS count FROM notes').get().count, 1);
  assert.equal(db.prepare('SELECT revision FROM notes WHERE id=?').get(note.id).revision, 0);
  await assert.rejects(database.withExclusiveTransactionAsync((txn) => commitQuickCaptureNote(txn, makeQuickCaptureNote('different', { id: note.id, now: 44 }))), /different note/);
  db.close();
});

test('voice commit inserts note, audio row and archive metadata together and removes its recovery journal', async () => {
  const { db, database, txn } = createTestDatabase();
  await migrateQuickCaptureSchema(database);
  const note = makeQuickVoiceNote({ id: 'voice-note', now: 50 });
  const recording = { id: 'voice-recording', note_id: note.id, title: 'Voice note', file_uri: 'file:///private/voice.m4a', status: 'complete', created_at: 51 };
  const metadata = { mimeType: 'audio/mp4', ownerId: 'ios-local', updatedAt: 51, durationMs: 0, durationKnown: false, sourcePlatform: 'ios' };
  await txn.runAsync('INSERT INTO quick_voice_pending VALUES(?,?,?,?,?)', recording.id, JSON.stringify(note), JSON.stringify(recording), JSON.stringify(metadata), 52);
  const result = await database.withExclusiveTransactionAsync((txn) => commitQuickVoicePending(txn, recording.id));
  assert.equal(result.recovered, true);
  assert.equal(db.prepare('SELECT note_id,file_uri FROM recordings WHERE id=?').get(recording.id).file_uri, recording.file_uri);
  assert.deepEqual(JSON.parse(db.prepare('SELECT metadata_json FROM recording_archive_metadata WHERE recording_id=?').get(recording.id).metadata_json), metadata);
  assert.equal(db.prepare('SELECT recording_id FROM quick_voice_pending').get(), undefined);
  db.close();
});

test('voice transaction failure rolls back note and audio rows while retaining the pending recovery journal', async () => {
  const { db, database, txn } = createTestDatabase();
  await migrateQuickCaptureSchema(database);
  const note = makeQuickVoiceNote({ id: 'voice-note-fail', now: 60 });
  const recording = { id: 'voice-record-fail', note_id: note.id, title: 'Voice note', file_uri: 'file:///private/voice-fail.m4a', status: 'complete', created_at: 61 };
  const metadata = { mimeType: 'audio/mp4', ownerId: 'ios-local', updatedAt: 61, durationMs: 0, durationKnown: false, sourcePlatform: 'ios' };
  await txn.runAsync('INSERT INTO quick_voice_pending VALUES(?,?,?,?,?)', recording.id, JSON.stringify(note), JSON.stringify(recording), JSON.stringify(metadata), 62);
  db.exec("CREATE TRIGGER fail_voice BEFORE INSERT ON recordings BEGIN SELECT RAISE(ABORT,'disk database error'); END;");
  await assert.rejects(database.withExclusiveTransactionAsync((txn) => commitQuickVoicePending(txn, recording.id)), /disk database error/);
  assert.equal(db.prepare('SELECT id FROM notes WHERE id=?').get(note.id), undefined);
  assert.equal(db.prepare('SELECT id FROM recordings WHERE id=?').get(recording.id), undefined);
  assert.ok(db.prepare('SELECT recording_id FROM quick_voice_pending WHERE recording_id=?').get(recording.id));
  db.exec('DROP TRIGGER fail_voice');
  await database.withExclusiveTransactionAsync((txn) => commitQuickVoicePending(txn, recording.id));
  assert.equal(db.prepare('SELECT id FROM notes WHERE id=?').get(note.id).id, note.id);
  db.close();
});
