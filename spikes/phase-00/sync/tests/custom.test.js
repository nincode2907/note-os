import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DATASET_ID, FIXTURE_SIZE, ensureFixture, snapshot } from './fixture.js';

const api = process.env.API_URL;

async function push(body) {
  return fetch(`${api}/api/delta/push`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body)
  });
}

test('custom Delta prototype handles lost ACK, idempotency, concurrent edit, delete and privacy boundary', async () => {
  await ensureFixture();
  const initial = await snapshot();
  assert.equal(new Set([...initial.changes.notes.created, ...initial.changes.notes.updated].map(note => note.id).filter(id => id.startsWith('syncbench-v1-'))).size, FIXTURE_SIZE);
  const id = randomUUID().replaceAll('-', '').slice(0, 16);
  const baseRevision = (await snapshot()).timestamp;
  const create = {
    mutationId: randomUUID(), baseRevision,
    note: { id, title: 'offline create', body: 'synthetic delta test', privacy: 'PRIVATE_SERVER', dataset_id: DATASET_ID, deleted: false }
  };

  const committed = await push(create);
  assert.equal(committed.status, 200);
  const firstResult = await committed.json();
  const revisionAfterCommit = (await snapshot()).timestamp;

  // The response is intentionally ignored once, then the same durable mutation is retried.
  const replay = await push(create);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstResult);
  assert.equal((await snapshot()).timestamp, revisionAfterCommit, 'lost ACK retry does not append another server revision');

  const reusedId = await push({ ...create, note: { ...create.note, title: 'different intent' } });
  assert.equal(reusedId.status, 409, 'one mutation ID cannot be reused for another payload');

  const concurrentBase = firstResult.revision;
  const deviceA = await push({ ...create, mutationId: randomUUID(), baseRevision: concurrentBase, note: { ...create.note, title: 'device A' } });
  assert.equal(deviceA.status, 200);
  const deviceAResult = await deviceA.json();
  const deviceB = await push({ ...create, mutationId: randomUUID(), baseRevision: concurrentBase, note: { ...create.note, title: 'device B' } });
  assert.equal(deviceB.status, 409);
  assert.equal((await deviceB.json()).current.title, 'device A', 'conflict returns the server copy');

  const deletion = await push({ ...create, mutationId: randomUUID(), baseRevision: deviceAResult.revision, note: { ...create.note, title: 'device A', deleted: true } });
  assert.equal(deletion.status, 200);
  const resurrection = await push({ ...create, mutationId: randomUUID(), baseRevision, note: create.note });
  assert.equal(resurrection.status, 409, 'a stale create cannot resurrect the tombstone');

  const privateWrite = await push({ ...create, mutationId: randomUUID(), note: { ...create.note, id: randomUUID().slice(0, 16), privacy: 'DEVICE_ONLY' } });
  assert.equal(privateWrite.status, 422, 'server fails closed for DEVICE_ONLY data');
  assert.ok((await snapshot()).changes.notes.deleted.includes(id), 'new clients receive the deletion tombstone');
});
