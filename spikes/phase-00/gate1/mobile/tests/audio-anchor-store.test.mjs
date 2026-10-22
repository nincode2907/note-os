import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEmptyCanonicalDocument } from '../../web/packages/document-engine/src/index.js';
import { createAudioAnchor, emptyAudioAnchorSet } from '../../web/app/lib/audio-anchors.mjs';
import { addSessionAudioAnchor, commitAudioAnchorSession, migrateAudioAnchorSchema, saveAudioAnchorSession } from '../audio-anchor-store.mjs';

const note = () => ({ id: 'note-anchor', title: 'Anchor test', document: createEmptyCanonicalDocument(), schemaVersion: 1, createdAt: 1, updatedAt: 2, lifecycle: 'active', revision: 7, pinned: false, tags: [] });
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE notes(id TEXT PRIMARY KEY,record_json TEXT NOT NULL,revision INTEGER NOT NULL,lifecycle TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE recordings(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,title TEXT NOT NULL,file_uri TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE recording_archive_metadata(recording_id TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,metadata_json TEXT NOT NULL);
    PRAGMA user_version=4;`);
  const txn = { getFirstAsync: async (sql, ...args) => db.prepare(sql).get(...args), runAsync: async (sql, ...args) => ({ changes: Number(db.prepare(sql).run(...args).changes) }), execAsync: async sql => db.exec(sql) };
  const database = { getFirstAsync: async (sql, ...args) => db.prepare(sql).get(...args), withExclusiveTransactionAsync: async fn => { db.exec('BEGIN EXCLUSIVE'); try { const value = await fn(txn); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
  return { db, txn, database };
}
const recording = (noteId = 'note-anchor') => ({ id: 'recording-anchor', note_id: noteId, title: 'Test recording', file_uri: 'file:///recording.m4a', status: 'complete', created_at: 3 });
const metadata = () => ({ mimeType: 'audio/mp4', ownerId: 'ios-local', updatedAt: 4, durationMs: 0, durationKnown: false, sourcePlatform: 'ios', audioAnchors: emptyAudioAnchorSet() });

test('mobile migration is additive and preserves pre-existing records', async () => {
  const { db, database } = fixture(); const value = note();
  db.prepare('INSERT INTO notes VALUES(?,?,?,?,?)').run(value.id, JSON.stringify(value), value.revision, value.lifecycle, value.updatedAt);
  await migrateAudioAnchorSchema(database);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(db.prepare('SELECT record_json FROM notes WHERE id=?').get(value.id).record_json, JSON.stringify(value));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audio_anchor_sessions'").get());
  db.close();
});

test('provisional recording anchors survive until atomic final commit without changing note revision', async () => {
  const { db, database, txn } = fixture(); await migrateAudioAnchorSchema(database); const value = note();
  db.prepare('INSERT INTO notes VALUES(?,?,?,?,?)').run(value.id, JSON.stringify(value), value.revision, value.lifecycle, value.updatedAt);
  const draft = recording(); const archiveMetadata = metadata();
  await database.withExclusiveTransactionAsync(tx => saveAudioAnchorSession(tx, { noteId: value.id, note: null, recording: draft, metadata: archiveMetadata }));
  const anchor = createAudioAnchor(draft.id, 3456, '  Türkçe — Bookmark  ', { id: 'bookmark-1', createdAt: 5 });
  const next = await database.withExclusiveTransactionAsync(tx => addSessionAudioAnchor(tx, draft.id, anchor));
  assert.equal(next.items[0].label, 'Türkçe — Bookmark');
  const finalRecording = { ...draft, status: 'complete' };
  const outcome = await database.withExclusiveTransactionAsync(async tx => {
    await saveAudioAnchorSession(tx, { noteId: value.id, note: null, recording: finalRecording, metadata: { ...archiveMetadata, audioAnchors: next } });
    return commitAudioAnchorSession(tx, draft.id);
  });
  assert.equal(outcome.recording.id, draft.id);
  assert.deepEqual(JSON.parse(db.prepare('SELECT metadata_json FROM recording_archive_metadata WHERE recording_id=?').get(draft.id).metadata_json).audioAnchors, next);
  assert.equal(db.prepare('SELECT revision FROM notes WHERE id=?').get(value.id).revision, value.revision);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audio_anchor_sessions').get().n, 0);
  db.close();
});

test('invalid session anchor metadata is rejected without durable rows', async () => {
  const { db, database } = fixture(); await migrateAudioAnchorSchema(database);
  const invalid = { ...metadata(), audioAnchors: { version: 1, items: [{ id: 'bad', recordingId: 'other-recording', offsetMs: -1, label: '', createdAt: 1 }] } };
  await assert.rejects(database.withExclusiveTransactionAsync(tx => saveAudioAnchorSession(tx, { noteId: 'note-anchor', note: null, recording: recording(), metadata: invalid })), /identity or time/u);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audio_anchor_sessions').get().n, 0);
  db.close();
});

test('Quick Voice keeps its provisional note out of notes until recording commit', async () => {
  const { db, database, txn } = fixture(); await migrateAudioAnchorSchema(database); const value = note();
  const draft = recording(value.id); await database.withExclusiveTransactionAsync(tx => saveAudioAnchorSession(tx, { noteId: null, note: value, recording: draft, metadata: metadata() }));
  assert.equal(db.prepare('SELECT count(*) AS n FROM notes').get().n, 0);
  await database.withExclusiveTransactionAsync(async tx => { await saveAudioAnchorSession(tx, { noteId: null, note: value, recording: { ...draft, status: 'interrupted' }, metadata: metadata() }); await commitAudioAnchorSession(tx, draft.id); });
  assert.equal(db.prepare('SELECT revision FROM notes WHERE id=?').get(value.id).revision, value.revision);
  assert.equal(db.prepare('SELECT count(*) AS n FROM recordings').get().n, 1);
  db.close();
});

test('interrupted finalization retry keeps bookmarks in its session journal until commit succeeds', async () => {
  const { db, database, txn } = fixture(); await migrateAudioAnchorSchema(database); const value = note();
  db.prepare('INSERT INTO notes VALUES(?,?,?,?,?)').run(value.id, JSON.stringify(value), value.revision, value.lifecycle, value.updatedAt);
  const draft = recording(), anchors = { version: 1, items: [createAudioAnchor(draft.id, 760, 'Recovery — 復旧', { id: 'resume-anchor', createdAt: 6 })] };
  await database.withExclusiveTransactionAsync(tx => saveAudioAnchorSession(tx, { noteId: value.id, note: null, recording: draft, metadata: { ...metadata(), audioAnchors: anchors } }));
  const final = { ...draft, status: 'interrupted' };
  db.exec("CREATE TRIGGER fail_recording BEFORE INSERT ON recordings BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;");
  await assert.rejects(database.withExclusiveTransactionAsync(async tx => { await saveAudioAnchorSession(tx, { noteId: value.id, note: null, recording: final, metadata: { ...metadata(), audioAnchors: anchors } }); return commitAudioAnchorSession(tx, draft.id); }), /synthetic write failure/u);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audio_anchor_sessions WHERE recording_id=?').get(draft.id).n, 1);
  assert.equal(JSON.parse(db.prepare('SELECT metadata_json FROM audio_anchor_sessions WHERE recording_id=?').get(draft.id).metadata_json).audioAnchors.items[0].offsetMs, 760);
  db.exec('DROP TRIGGER fail_recording;');
  await database.withExclusiveTransactionAsync(async tx => { await saveAudioAnchorSession(tx, { noteId: value.id, note: null, recording: final, metadata: { ...metadata(), audioAnchors: anchors } }); return commitAudioAnchorSession(tx, draft.id); });
  assert.equal(db.prepare('SELECT status FROM recordings WHERE id=?').get(draft.id).status, 'interrupted');
  assert.equal(JSON.parse(db.prepare('SELECT metadata_json FROM recording_archive_metadata WHERE recording_id=?').get(draft.id).metadata_json).audioAnchors.items[0].label, 'Recovery — 復旧');
  assert.equal(db.prepare('SELECT count(*) AS n FROM audio_anchor_sessions').get().n, 0);
  db.close();
});
