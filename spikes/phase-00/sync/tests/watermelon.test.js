import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '@nozbe/watermelondb';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import { Model } from '@nozbe/watermelondb';
import { appSchema, tableSchema } from '@nozbe/watermelondb/Schema';
import { synchronize } from '@nozbe/watermelondb/sync';

class Note extends Model { static table = 'notes'; }
const schema = appSchema({ version: 1, tables: [tableSchema({
  name: 'notes', columns: [
    { name: 'title', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'privacy', type: 'string' }
  ]
})] });

function client(label) {
  const adapter = new LokiJSAdapter({ schema, dbName: `noteos-wm-${label}-${randomUUID()}`, useWebWorker: false });
  return new Database({ adapter, modelClasses: [Note] });
}

async function sync(database, pushHook) {
  await synchronize({
    database,
    pullChanges: async ({ lastPulledAt, schemaVersion, migration }) => {
      const url = `${process.env.API_URL}/api/sync?last_pulled_at=${lastPulledAt ?? 0}&schema_version=${schemaVersion}&migration=${encodeURIComponent(JSON.stringify(migration))}`;
      const response = await fetch(url);
      assert.equal(response.ok, true, `Watermelon pull ${response.status}`);
      return response.json();
    },
    pushChanges: async ({ changes, lastPulledAt }) => {
      const response = await fetch(`${process.env.API_URL}/api/sync`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes, lastPulledAt })
      });
      if (!response.ok) throw new Error(await response.text());
      if (pushHook) await pushHook();
    },
    migrationsEnabledAtVersion: 1
  });
}

test('WatermelonDB synchronize executes offline create, lost ACK recovery, conflict, deletion and duplicate create against Laravel', async () => {
  const id = randomUUID().replaceAll('-', '').slice(0, 16);
  const a = client('a');
  const b = client('b');
  await a.write(async () => a.get('notes').create(note => {
    note._raw.id = id;
    note._raw.title = 'offline title';
    note._raw.body = 'offline body';
    note._raw.privacy = 'PRIVATE_SERVER';
  }));

  let dropAck = true;
  await assert.rejects(sync(a, async () => {
    if (dropAck) { dropAck = false; throw new Error('simulated ACK lost after Laravel commit'); }
  }), /simulated ACK lost/);
  await sync(a);
  await sync(b);
  let remote = await b.get('notes').find(id);
  assert.equal(remote._raw.title, 'offline title');

  await a.write(async () => { const n = await a.get('notes').find(id); await n.update(x => { x._raw.title = 'device A'; }); });
  await b.write(async () => { const n = await b.get('notes').find(id); await n.update(x => { x._raw.title = 'device B'; }); });
  await sync(a);
  await assert.rejects(sync(b), /409|Conflict/);
  await sync(b);
  remote = await b.get('notes').find(id);
  assert.ok(['device A', 'device B'].includes(remote._raw.title));

  await a.write(async () => { const n = await a.get('notes').find(id); await n.markAsDeleted(); });
  await sync(a);
  await sync(b);
  await assert.rejects(b.get('notes').find(id));

  const duplicate = await fetch(`${process.env.API_URL}/api/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lastPulledAt: 0, changes: { notes: { created: [{ id, title: 'duplicate replay', body: 'once', privacy: 'PRIVATE_SERVER' }], updated: [], deleted: [] } } })
  });
  assert.equal(duplicate.status, 204);
  const duplicate2 = await fetch(`${process.env.API_URL}/api/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lastPulledAt: 0, changes: { notes: { created: [{ id, title: 'duplicate replay', body: 'once', privacy: 'PRIVATE_SERVER' }], updated: [], deleted: [] } } })
  });
  assert.equal(duplicate2.status, 204);
});
