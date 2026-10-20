import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { PowerSyncDatabase, Schema, Table, column } from '@powersync/node';
import { DATASET_ID, FIXTURE_SIZE, ensureFixture } from './fixture.js';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () => {
  const header = encode({ alg: 'HS256', typ: 'JWT', kid: 'noteos-phase00' });
  const payload = encode({ aud: 'powersync', sub: 'phase00-client', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', Buffer.from('secret-noteos-phase-00-local')).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('PowerSync experimental Node SQLite client: full sync, upload, lost ACK replay and restart persistence', async t => {
  await ensureFixture();
  const apiUrl = process.env.API_URL;
  const powersyncUrl = process.env.POWERSYNC_URL;
  const id = `ps-${randomUUID()}`;
  let uploadInvocations = 0;
  let simulateLostAck = true;
  const files = [`/tmp/${id}-a.sqlite`, `/tmp/${id}-b.sqlite`];
  const schema = new Schema({
    notes: new Table({
      title: column.text,
      body: column.text,
      privacy: column.text,
      updated_at: column.text,
      dataset_id: column.text,
      revision: column.integer,
      deleted: column.integer
    })
  });
  const connector = {
    async fetchCredentials() { return { endpoint: powersyncUrl, token: token() }; },
    async uploadData(database) {
      uploadInvocations++;
      while (true) {
        const transaction = await database.getNextCrudTransaction();
        if (!transaction) return;
        const latestByNote = new Map();
        for (const change of transaction.crud) if (change.table === 'notes') latestByNote.set(change.id, change);
        for (const change of latestByNote.values()) {
          const row = await database.get('SELECT id, title, body, privacy, dataset_id, revision, deleted FROM notes WHERE id = ?', [change.id]);
          if ((row?.privacy ?? change.previousValues?.privacy) === 'DEVICE_ONLY') continue;
          const response = await fetch(`${apiUrl}/api/delta/push`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              // A durable client outbox should persist this ID with the mutation. This
              // single-mutation fixture uses the stable note ID to model that contract.
              mutationId: `powersync-${change.id}`,
              baseRevision: row?.revision ?? change.previousValues?.revision ?? 0,
              note: {
                id: row?.id ?? change.id,
                title: row?.title ?? change.previousValues?.title ?? '',
                body: row?.body ?? change.previousValues?.body ?? '',
                privacy: row?.privacy ?? change.previousValues?.privacy ?? 'PRIVATE_SERVER',
                dataset_id: row?.dataset_id ?? change.previousValues?.dataset_id ?? DATASET_ID,
                deleted: change.op === 'DELETE' || !row || Boolean(row.deleted)
              }
            })
          });
          assert.equal(response.ok, true, `Laravel upload status ${response.status}: ${await response.text()}`);
          if (simulateLostAck) {
            simulateLostAck = false;
            throw new Error('simulated lost ACK after Laravel committed the mutation');
          }
        }
        await transaction.complete();
      }
    }
  };

  const open = file => new PowerSyncDatabase({
    schema,
    database: { dbFilename: file, implementation: { type: 'node:sqlite' } }
  });
  let first;
  let second;
  t.after(async () => {
    await Promise.allSettled([first?.close(), second?.close()]);
    await Promise.all(files.map(file => rm(file, { force: true })));
  });

  first = open(files[0]);
  await first.waitForReady();
  await first.execute(
    'INSERT INTO notes (id, title, body, privacy, updated_at, dataset_id, revision, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, 'PowerSync offline create', 'client SQLite payload', 'PRIVATE_SERVER', new Date().toISOString(), DATASET_ID, 0, 0]
  );
  assert.equal((await first.get('SELECT title FROM notes WHERE id = ?', [id])).title, 'PowerSync offline create');

  await first.connect(connector);
  await first.waitForFirstSync(AbortSignal.timeout(25000));

  let serverNote;
  let committedRevision;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const snapshot = await fetch(`${apiUrl}/api/sync?dataset_id=${DATASET_ID}&last_pulled_at=0`).then(response => response.json());
    serverNote = snapshot.changes.notes.created.find(note => note.id === id);
    if (serverNote) committedRevision = snapshot.timestamp;
    if (serverNote) break;
    await delay(100);
  }
  assert.equal(serverNote?.title, 'PowerSync offline create',
    `offline SQLite edit reaches Laravel/MySQL (uploads=${uploadInvocations}, status=${JSON.stringify(first.currentStatus)}, queued=${Boolean(await first.getNextCrudTransaction())})`);
  const retryDeadline = Date.now() + 20000;
  while (Date.now() < retryDeadline && (uploadInvocations < 2 || await first.getNextCrudTransaction())) await delay(100);
  assert.ok(uploadInvocations >= 2, 'PowerSync connector retries the pending transaction after a simulated lost ACK');
  assert.equal((await fetch(`${apiUrl}/api/sync?dataset_id=${DATASET_ID}&last_pulled_at=0`).then(response => response.json())).timestamp, committedRevision,
    'idempotent lost-ACK replay creates only one server revision');

  second = open(files[1]);
  await second.waitForReady();
  await second.connect({ fetchCredentials: connector.fetchCredentials, uploadData: async () => {} });
  await second.waitForFirstSync(AbortSignal.timeout(8000));
  const initialRows = await second.get("SELECT COUNT(*) AS count FROM notes WHERE dataset_id = ? AND id LIKE 'syncbench-v1-%'", [DATASET_ID]);
  assert.equal(initialRows.count, FIXTURE_SIZE, 'PowerSync initial download contains the shared 100-row fixture');
  const replicated = await second.get('SELECT title, body FROM notes WHERE id = ?', [id]);
  assert.deepEqual(replicated, { title: 'PowerSync offline create', body: 'client SQLite payload' });

  await first.disconnect();
  await first.close();
  first = open(files[0]);
  await first.waitForReady();
  const reopened = await first.get('SELECT title, body FROM notes WHERE id = ?', [id]);
  assert.deepEqual(reopened, { title: 'PowerSync offline create', body: 'client SQLite payload' },
    'SQLite client data survives close and reopening a new PowerSync database instance');
});
