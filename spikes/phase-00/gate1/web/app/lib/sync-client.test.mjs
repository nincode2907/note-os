import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronize } from './sync-client.mjs';

function queue(size = 150) {
  return Array.from({ length: size }, (_, index) => {
    const localRevision = index + 1;
    const record = { id: 'same-note', title: `Revision ${localRevision}`, revision: localRevision, lifecycle: 'active', schemaVersion: 1, document: { schemaVersion: 1, type: 'doc', content: [] } };
    return { operationId: `operation-${String(index + 1).padStart(16, '0')}`, entityId: record.id, localRevision, recordJson: JSON.stringify(record), createdAt: index };
  });
}

function fixture(size = 150) {
  const rows = queue(size), baselines = new Map(), acked = [], mutations = new Map();
  const repository = {
    hasExistingDatabase: async () => true,
    getSyncState: async () => ({ state: { paired: true, history: { serverEpoch: 'epoch-a', serverCursor: 0 } }, conflicts: [], quarantine: [] }),
    setSyncPaired: async () => {},
    saveSyncRecovery: async () => {},
    commitSyncPull: async ({ serverEpoch, serverCursor }) => { repository.history = { serverEpoch, serverCursor }; },
    listSyncOutbox: async limit => rows.slice(0, limit),
    getSyncBaseline: async id => baselines.get(id) ?? null,
    acknowledgeSyncOperations: async (acks, history) => {
      for (const ack of acks) {
        const index = rows.findIndex(row => row.operationId === ack.operationId);
        if (index >= 0) rows.splice(index, 1);
        acked.push(ack.operationId); baselines.set(ack.baseline.id, ack.baseline);
      }
      repository.history = history;
    },
    recordSyncConflict: async (operationId, conflict) => {
      const operation = rows.find(row => row.operationId === operationId);
      if (!operation) return;
      for (let index = rows.length - 1; index >= 0; index--) if (rows[index].entityId === operation.entityId) rows.splice(index, 1);
      fixture.conflicts = (fixture.conflicts ?? 0) + 1;
    },
    quarantineSyncOperation: async operationId => { const index = rows.findIndex(row => row.operationId === operationId); if (index >= 0) rows.splice(index, 1); },
    getSyncOverview: async () => ({ recovery: null, conflicts: fixture.conflicts ?? 0, quarantined: 0, blockedPending: 0, eligiblePending: rows.length, mediaLocalOnly: 0, recordings: 0, paired: true }),
  };
  repository.getSyncState = async () => ({ state: { paired: true, history: repository.history ?? { serverEpoch: 'epoch-a', serverCursor: 0 } }, conflicts: [], quarantine: [] });
  return { repository, rows, baselines, acked, mutations };
}

function lockManager() { return { request: async (_name, _options, callback) => callback({ name: 'noteos-web-sync' }) }; }
function jsonResponse(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

function serverFor(fixture, { outageAt = Infinity, loseAckAt = Infinity } = {}) {
  let cursor = fixture.serverCursor ?? 0, serverVersion = fixture.serverVersion ?? 0, requestNumber = 0;
  return async (url, init) => {
    const action = String(url).split('/').at(-1);
    if (action === 'status') return jsonResponse({ serverEpoch: 'epoch-a', serverCursor: cursor });
    if (action === 'pull') return jsonResponse({ serverEpoch: 'epoch-a', serverCursor: cursor, nextCursor: cursor, hasMore: false, changes: [] });
    if (action !== 'push') throw new Error(`Unexpected sync action ${action}`);
    const operation = JSON.parse(init.body).operations[0]; requestNumber++;
    const prior = fixture.mutations.get(operation.operationId);
    let ack;
    if (prior) ack = prior;
    else {
      if (operation.baseServerVersion !== serverVersion) return jsonResponse({ error: 'stale_base' }, 409);
      serverVersion++; cursor++; fixture.serverVersion = serverVersion; fixture.serverCursor = cursor;
      ack = { operationId: operation.operationId, id: operation.entityId, serverVersion, localRevision: JSON.parse(operation.recordJson).revision, contentHash: `hash-${serverVersion}`, lifecycle: 'active' };
      fixture.mutations.set(operation.operationId, ack);
    }
    if (requestNumber === loseAckAt) throw new TypeError('ACK connection lost after server commit');
    if (requestNumber === outageAt) throw new TypeError('Server unavailable');
    return jsonResponse({ acknowledgements: [ack], serverEpoch: 'epoch-a', serverCursor: cursor });
  };
}

test('150 same-note revisions drain in bounded cycles and an outage leaves a durable Pending queue', async () => {
  const state = fixture();
  const first = await synchronize({ repository: state.repository, fetcher: serverFor(state, { outageAt: 101 }), locks: lockManager() });
  assert.equal(first.status, 'waiting-connection');
  assert.equal(first.pushed, 100);
  assert.equal(state.rows.length, 50);
  assert.equal(state.acked.length, 100);
  assert.deepEqual(state.acked, queue().slice(0, 100).map(row => row.operationId));

  const reloadedRepository = state.repository;
  const retry = await synchronize({ repository: reloadedRepository, fetcher: serverFor(state), locks: lockManager() });
  assert.equal(retry.status, 'synced');
  assert.equal(state.rows.length, 0);
  assert.equal(state.mutations.size, 150);
  assert.equal(state.acked.length, 150);
  assert.equal(state.baselines.get('same-note').serverVersion, 150);
});

test('lost ACK on a later operation replays the stable ID without duplicating the server mutation', async () => {
  const state = fixture();
  const first = await synchronize({ repository: state.repository, fetcher: serverFor(state, { loseAckAt: 125 }), locks: lockManager() });
  assert.equal(first.status, 'waiting-connection');
  assert.equal(first.pushed, 124);
  assert.equal(state.rows.length, 26);
  const lostId = queue()[124].operationId;
  assert.equal(state.mutations.has(lostId), true);

  const second = await synchronize({ repository: state.repository, fetcher: serverFor(state), locks: lockManager() });
  assert.equal(second.status, 'synced');
  assert.equal(state.mutations.size, 150);
  assert.equal(state.acked.filter(id => id === lostId).length, 1);
  assert.equal(state.baselines.get('same-note').serverVersion, 150);
});

test('a push conflict blocks later same-note revisions while unrelated notes continue', async () => {
  const state = fixture(3), other = state.rows[2];
  other.entityId = 'other-note'; other.recordJson = JSON.stringify({ ...JSON.parse(other.recordJson), id: 'other-note' });
  const attempted = [];
  const fetcher = async (url, init) => {
    const action = String(url).split('/').at(-1);
    if (action === 'status') return jsonResponse({ serverEpoch: 'epoch-a', serverCursor: 0 });
    if (action === 'pull') return jsonResponse({ serverEpoch: 'epoch-a', serverCursor: 0, nextCursor: 0, hasMore: false, changes: [] });
    const operation = JSON.parse(init.body).operations[0]; attempted.push(operation.entityId);
    if (operation.entityId === 'same-note') return jsonResponse({ error: 'conflict', serverEpoch: 'epoch-a', conflict: { operationId: operation.operationId, id: operation.entityId, actualVersion: 1, remote: { record: { ...JSON.parse(operation.recordJson), title: 'Remote version', revision: 9 } } } }, 409);
    return jsonResponse({ acknowledgements: [{ operationId: operation.operationId, id: operation.entityId, serverVersion: 1, localRevision: 3, contentHash: 'hash-other', lifecycle: 'active' }], serverEpoch: 'epoch-a', serverCursor: 1 });
  };
  const result = await synchronize({ repository: state.repository, fetcher, locks: lockManager() });
  assert.equal(result.status, 'needs-review');
  assert.deepEqual(attempted, ['same-note', 'other-note']);
  assert.equal(state.rows.length, 0);
  assert.equal(state.acked.length, 1);
});

test('an unreachable paired server never reports synced, even with an empty outbox', async () => {
  const state = fixture(0);
  const result = await synchronize({
    repository: state.repository,
    fetcher: async () => { throw new TypeError('Tailnet server unreachable'); },
    locks: lockManager(),
  });
  assert.equal(result.status, 'waiting-connection');
  assert.equal(result.retryable, true);
});

test('transient pull failures wait for connection and expired pairing is reported separately', async () => {
  const state = fixture(0);
  let paired = true;
  state.repository.setSyncPaired = async value => { paired = value; };
  const unavailable = await synchronize({ repository: state.repository, locks: lockManager(), fetcher: async url => {
    if (String(url).endsWith('/status')) return jsonResponse({ serverEpoch: 'epoch-a', serverCursor: 0 });
    return jsonResponse({ error: 'temporarily unavailable' }, 503);
  } });
  assert.equal(unavailable.status, 'waiting-connection');
  assert.equal(unavailable.retryable, true);
  const expired = await synchronize({ repository: state.repository, locks: lockManager(), fetcher: async () => jsonResponse({ error: 'authentication_required' }, 401) });
  assert.equal(expired.status, 'needs-pairing');
  assert.equal(expired.retryable, false);
  assert.equal(paired, false);
});
