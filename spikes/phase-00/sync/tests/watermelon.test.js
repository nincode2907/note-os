import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '@nozbe/watermelondb';
import LokiJSAdapterModule from '@nozbe/watermelondb/adapters/lokijs/index.js';
import { Model } from '@nozbe/watermelondb';
import { appSchema, tableSchema } from '@nozbe/watermelondb/Schema/index.js';
import { synchronize } from '@nozbe/watermelondb/sync/index.js';
import { DATASET_ID, FIXTURE_SIZE, ensureFixture } from './fixture.js';

class Note extends Model {
  static table = 'notes';
  get title() { return this._getRaw('title'); }
  set title(value) { this._setRaw('title', value); }
}
const schema = appSchema({ version: 1, tables: [tableSchema({
  name: 'notes', columns: [
    { name: 'title', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'privacy', type: 'string' }
    ,{ name: 'dataset_id', type: 'string', isOptional: true }
  ]
})] });
const LokiJSAdapter = LokiJSAdapterModule.default;

function client(label) {
  const adapter = new LokiJSAdapter({ schema, dbName: `noteos-wm-${label}-${randomUUID()}`, useWebWorker: false, useIncrementalIndexedDB: false });
  const database = new Database({ adapter, modelClasses: [Note] });
  database.localAdapter = adapter;
  return database;
}

async function syncPass(database, pushHook) {
  let baseRevision = 0;
  await synchronize({
    database,
    pullChanges: async ({ lastPulledAt, schemaVersion, migration }) => {
      baseRevision = lastPulledAt ?? 0;
      const url = `${process.env.API_URL}/api/sync?dataset_id=${DATASET_ID}&last_pulled_at=${lastPulledAt ?? 0}&schema_version=${schemaVersion}&migration=${encodeURIComponent(JSON.stringify(migration))}`;
      const response = await fetch(url);
      assert.equal(response.ok, true, `Watermelon pull ${response.status}`);
      return response.json();
    },
    pushChanges: async ({ changes }) => {
      const serverChanges = {
        ...changes,
        notes: {
          created: (changes.notes?.created ?? []).filter(note => note.privacy !== 'DEVICE_ONLY'),
          updated: (changes.notes?.updated ?? []).filter(note => note.privacy !== 'DEVICE_ONLY'),
          deleted: changes.notes?.deleted ?? []
        }
      };
      const response = await fetch(`${process.env.API_URL}/api/sync`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes: serverChanges, lastPulledAt: baseRevision })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw Object.assign(new Error(body.message ?? `Sync push ${response.status}`), { status: response.status, body });
      }
      if (pushHook) await pushHook();
    }
  });
}

async function sync(database, pushHook) {
  await syncPass(database, pushHook);
  // The server may commit this client's push after pullChanges supplied its cursor.
  // A second pass pulls that commit before the client starts another offline edit.
  await syncPass(database);
}

async function serverChanges() {
  const response = await fetch(`${process.env.API_URL}/api/sync?last_pulled_at=0`);
  assert.equal(response.ok, true);
  return response.json();
}

test('WatermelonDB real synchronize adapter: common full sync and offline scenarios against Laravel', async t => {
  await ensureFixture();
  const id = randomUUID().replaceAll('-', '').slice(0, 16);
  const a = client('a');
  const b = client('b');
  const databases = [a, b];
  t.after(() => databases.forEach(database => database.localAdapter._driver.loki.close()));
  await a.write(async () => a.get('notes').create(note => {
    note._raw.id = id;
    note._raw.title = 'offline title';
    note._raw.body = 'offline body';
    note._raw.privacy = 'PRIVATE_SERVER';
    note._raw.dataset_id = DATASET_ID;
  }));

  let dropAck = true;
  await assert.rejects(sync(a, async () => {
    if (dropAck) { dropAck = false; throw new Error('simulated ACK lost after Laravel commit'); }
  }), /simulated ACK lost/);
  const afterFirstCommit = (await serverChanges()).timestamp;
  await sync(a);
  assert.equal((await a.get('notes').query().fetch()).filter(note => note.id.startsWith('syncbench-v1-')).length, FIXTURE_SIZE, 'initial full pull contains the common 100-note fixture');
  assert.equal((await serverChanges()).timestamp, afterFirstCommit, 'retry after lost ACK is idempotent');
  await sync(b);
  let remote = await b.get('notes').find(id);
  assert.equal(remote._raw.title, 'offline title');

  await a.write(async () => { const n = await a.get('notes').find(id); await n.update(x => { x.title = 'device A'; }); });
  await b.write(async () => { const n = await b.get('notes').find(id); await n.update(x => { x.title = 'device B'; }); });
  await sync(a);
  let conflict;
  try { await sync(b); assert.fail('stale concurrent update must be rejected'); }
  catch (error) { assert.equal(error.status, 409); conflict = error.body; }
  assert.equal(conflict.current.title, 'device A');
  remote = await b.get('notes').find(id);
  assert.equal(remote._raw.title, 'device B', 'unsynced local edit remains available after conflict');

  await a.write(async () => { const n = await a.get('notes').find(id); await n.markAsDeleted(); });
  await sync(a);
  const c = client('after-delete');
  await sync(c);
  await assert.rejects(c.get('notes').find(id));

  const duplicate = await fetch(`${process.env.API_URL}/api/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lastPulledAt: 0, changes: { notes: { created: [{ id, title: 'duplicate replay', body: 'once', privacy: 'PRIVATE_SERVER' }], updated: [], deleted: [] } } })
  });
  assert.equal(duplicate.status, 409, 'a stale create must not resurrect a deleted note');

  const deviceOnlyId = randomUUID().replaceAll('-', '').slice(0, 16);
  databases.push(c);
  await c.write(async () => c.get('notes').create(note => {
    note._raw.id = deviceOnlyId;
    note._raw.title = 'device only';
    note._raw.body = 'must remain on device';
    note._raw.privacy = 'DEVICE_ONLY';
    note._raw.dataset_id = DATASET_ID;
  }));
  await sync(c);
  const remoteRows = await serverChanges();
  assert.equal([...remoteRows.changes.notes.created, ...remoteRows.changes.notes.updated].some(note => note.id === deviceOnlyId), false);

  const forbidden = await fetch(`${process.env.API_URL}/api/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lastPulledAt: 0, changes: { notes: { created: [{ id: deviceOnlyId, title: 'device only', body: 'must remain on device', privacy: 'DEVICE_ONLY' }], updated: [], deleted: [] } } })
  });
  assert.equal(forbidden.status, 422, 'server rejects DEVICE_ONLY writes if a client adapter fails open');
});
