import { assertHistoryContinuity } from './sync-protocol.mjs';

async function request(action, body, fetcher) {
  const response = await fetcher(`/api/v1/sync/${action}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-NoteOS-Sync': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json();
  if (!response.ok) throw Object.assign(new Error(json.error ?? 'Sync request failed.'), { status: response.status, body: json });
  return json;
}

/** @param {{repository:any,fetcher?:typeof fetch,locks?:LockManager,onState?:(state:string)=>void,initialize?:boolean}} options */
export async function synchronize({ repository, fetcher = fetch, locks = globalThis.navigator?.locks, onState = (_state) => {}, initialize = false }) {
  if (!locks?.request) throw new Error('This browser cannot safely coordinate sync workers across tabs.');
  let result = { status: 'waiting', pulled: 0, pushed: 0 };
  await locks.request('noteos-web-sync', { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) { result.status = 'waiting'; return; }
    onState('syncing');
    try {
      if (!initialize && !(await repository.hasExistingDatabase())) { result.status = 'saved-device'; return; }
      const local = await repository.getSyncState();
      if (local.state.recovery) throw new Error('This browser has pending sync recovery review.');
      if (local.state.paired !== true) { result.status = 'saved-device'; return; }
      let server;
      try { server = await request('status', undefined, fetcher); }
      catch (error) { if (error.status === 401) await repository.setSyncPaired(false); if (error.status === 401 || error.status === 503 || !globalThis.navigator?.onLine) { result.status = 'saved-device'; return; } throw error; }
      const previous = local.state.history ?? null;
      try { assertHistoryContinuity(previous, server); }
      catch (error) { await repository.saveSyncRecovery(error.message, server); throw error; }
      let cursor = previous?.serverCursor ?? 0;
      for (let page = 0; page < 100; page++) {
        const pulled = await request('pull', { protocolVersion: 1, cursor, limit: 100 }, fetcher);
        try { assertHistoryContinuity(previous, pulled); }
        catch (error) { await repository.saveSyncRecovery(error.message, pulled); throw error; }
        await repository.commitSyncPull({ serverEpoch: pulled.serverEpoch, serverCursor: pulled.nextCursor, changes: pulled.changes });
        result.pulled += pulled.changes.length; cursor = pulled.nextCursor;
        if (!pulled.hasMore) break;
        if (page === 99) throw new Error('Sync pull reached its bounded page limit.');
      }
      for (const op of await repository.listSyncOutbox(100)) {
        const pendingRecord = JSON.parse(op.recordJson);
        const currentBaseline = await repository.getSyncBaseline?.(op.entityId);
        const payload = { protocolVersion: 1, operations: [{ operationId: op.operationId, entityId: op.entityId, baseServerVersion: currentBaseline?.serverVersion ?? 0, ownerApproved: true, recordingCount: 0, type: 'upsert', recordJson: JSON.stringify(pendingRecord) }] };
        try {
          const pushed = await request('push', payload, fetcher);
          await repository.acknowledgeSyncOperations(pushed.acknowledgements.map(ack => ({ operationId: ack.operationId, baseline: { id: ack.id, serverVersion: ack.serverVersion, localRevision: ack.localRevision, contentHash: ack.contentHash, lifecycle: ack.lifecycle } })));
          result.pushed += pushed.acknowledgements.length;
        } catch (error) {
          if (error.status === 409 && error.body?.conflict) await repository.recordSyncConflict(op.operationId, { ...error.body.conflict, serverEpoch: error.body.serverEpoch });
          else throw error;
        }
      }
      const finalState = await repository.getSyncState();
      result.status = finalState.conflicts.length ? 'needs-review' : 'synced';
      result.serverCursor = finalState.state.history?.serverCursor ?? 0;
    } catch (error) {
      if (error.status === undefined && (error instanceof TypeError || !globalThis.navigator?.onLine)) { result.status = 'waiting'; return; }
      result.status = 'needs-review'; result.error = error.message; throw error;
    } finally { onState(result.status); }
  });
  return result;
}
