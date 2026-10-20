import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { DATASET_ID, FIXTURE_SIZE, ensureFixture, snapshot } from './fixture.js';

test('minimal custom SQLite outbox: full pull, pending mutation survives restart, replay and schema migration', async t => {
  await ensureFixture();
  const full = await snapshot();
  assert.equal(new Set([...full.changes.notes.created, ...full.changes.notes.updated].map(note => note.id).filter(id => id.startsWith('syncbench-v1-'))).size, FIXTURE_SIZE);
  const file = `/tmp/noteos-custom-${randomUUID()}.sqlite`;
  t.after(() => rm(file, { force: true }));
  let db = new DatabaseSync(file);
  db.exec(`CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, privacy TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE outbox(mutation_id TEXT PRIMARY KEY, base_revision INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const id = `custom-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const mutationId = `custom-retry-${randomUUID()}`;
  const payload = { id, title: 'offline persisted edit', body: 'synthetic local body', privacy: 'PRIVATE_SERVER', dataset_id: DATASET_ID, deleted: false };
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO notes(id,title,body,privacy,revision) VALUES (?,?,?,?,?)').run(id, payload.title, payload.body, payload.privacy, full.timestamp);
  db.prepare('INSERT INTO outbox(mutation_id,base_revision,payload) VALUES (?,?,?)').run(mutationId, full.timestamp, JSON.stringify(payload));
  db.exec('COMMIT');

  const postMutation = async () => {
    const pending = db.prepare('SELECT * FROM outbox WHERE mutation_id=?').get(mutationId);
    return fetch(`${process.env.API_URL}/api/delta/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mutationId: pending.mutation_id, baseRevision: pending.base_revision, note: JSON.parse(pending.payload) }) });
  };
  const committed = await postMutation();
  assert.equal(committed.status, 200);
  const firstReply = await committed.json();
  // Simulate process loss after server commit but before local ACK/outbox deletion.
  db.close();
  db = new DatabaseSync(file);
  const replay = await postMutation();
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstReply);
  db.prepare('DELETE FROM outbox WHERE mutation_id=?').run(mutationId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  assert.equal(db.prepare('SELECT title FROM notes WHERE id=?').get(id).title, payload.title, 'local row survives process restart');

  // Schema v1 -> v2 with a pending local row; additive migration preserves outbox and note data.
  db.prepare('INSERT INTO outbox(mutation_id,base_revision,payload) VALUES (?,?,?)').run(`pending-${mutationId}`, full.timestamp, JSON.stringify({ ...payload, title: 'pending across migration' }));
  db.exec('ALTER TABLE notes ADD COLUMN color TEXT NOT NULL DEFAULT ""');
  db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run('schema_version', '2');
  assert.equal(db.prepare('SELECT color FROM notes WHERE id=?').get(id).color, '');
  assert.equal(db.prepare('SELECT value FROM metadata WHERE key=?').get('schema_version').value, '2');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1, 'pending mutation survives additive schema migration');

  const localOnlyId = `device-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  db.prepare('INSERT INTO notes(id,title,body,privacy,revision,color) VALUES (?,?,?,?,?,?)').run(localOnlyId, 'private', 'stay local', 'DEVICE_ONLY', 0, '');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE payload LIKE ?').get(`%${localOnlyId}%`).n, 0, 'DEVICE_ONLY never enters the upload queue');
  const after = await snapshot();
  assert.ok(![...after.changes.notes.created, ...after.changes.notes.updated].some(note => note.id === localOnlyId));
  db.close();
});
