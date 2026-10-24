import { assertHistoryContinuity } from './sync-protocol.mjs';
import { synchronizeAudio } from './audio-sync-client.mjs';
import { deliverAiOutbox } from './ai-sync-client.mjs';

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
  if (!locks?.request) return { status: 'needs-review', error: 'This browser cannot safely coordinate sync workers across tabs.', pulled: 0, pushed: 0, retryable: false };
  let result = { status: 'waiting', pulled: 0, pushed: 0, retryable: false };
  await locks.request('noteos-web-sync', { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) { result.status = 'waiting'; result.retryable = false; return; }
    onState('syncing');
    const finalStatus = async fallback => {
      const overview = await repository.getSyncOverview?.();
      if (!overview) return fallback;
      if (overview.recovery || overview.conflicts || overview.quarantined || overview.blockedPending) return 'needs-review';
      if (overview.eligiblePending) return 'pending';
      if (overview.mediaLocalOnly || overview.recordings) return 'media-local-only';
      return overview.paired ? 'synced' : 'saved-device';
    };
    try {
      if (!initialize && !(await repository.hasExistingDatabase())) { result.status = 'saved-device'; return; }
      const local = await repository.getSyncState();
      if (local.state.recovery) { result.status = 'needs-review'; return; }
      if (local.state.paired !== true) { result.status = await finalStatus('saved-device'); return; }
      let server;
      try { server = await request('status', undefined, fetcher); }
      catch (error) {
        if (error.status === 401) await repository.setSyncPaired(false, { notify: false });
        if (error.status === 401) { result.status = 'needs-pairing'; return; }
        if (error.status === 408 || error.status === 429 || error.status >= 500 || error instanceof TypeError || !globalThis.navigator?.onLine) {
          result.status = 'waiting-connection'; result.retryable = true; result.error = error.message; return;
        }
        throw error;
      }
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
      // Keep each request small and refresh the baseline after every ACK. This preserves
      // the ordered serverVersion chain for multiple local revisions of one note.
      // The hard cap and task yields keep a large offline queue from monopolizing a tab.
      const blockedEntities = new Set();
      const committedAcks = [];
      for (let batch = 0; batch < 5; batch++) {
        const operations = await repository.listSyncOutbox(100);
        if (!operations.length) break;
        for (const op of operations) {
          if (blockedEntities.has(op.entityId)) continue;
          const pendingRecord = JSON.parse(op.recordJson);
          const currentBaseline = await repository.getSyncBaseline?.(op.entityId);
          const payload = { protocolVersion: 1, operations: [{ operationId: op.operationId, entityId: op.entityId, baseServerVersion: currentBaseline?.serverVersion ?? 0, ownerApproved: true, recordingCount: 0, type: 'upsert', recordJson: op.recordJson }] };
          try {
            const pushed = await request('push', payload, fetcher);
            await repository.acknowledgeSyncOperations(pushed.acknowledgements.map(ack => ({ operationId: ack.operationId, baseline: { id: ack.id, serverVersion: ack.serverVersion, localRevision: ack.localRevision, contentHash: ack.contentHash, lifecycle: ack.lifecycle, privacy: pendingRecord.privacy } })), { serverEpoch: pushed.serverEpoch, serverCursor: pushed.serverCursor });
            committedAcks.push(...pushed.acknowledgements.map(ack => ({ ...ack, serverEpoch: pushed.serverEpoch })));
            result.pushed += pushed.acknowledgements.length;
          } catch (error) {
            if (error.status === 409 && error.body?.conflict) {
              await repository.recordSyncConflict(op.operationId, { ...error.body.conflict, serverEpoch: error.body.serverEpoch });
              blockedEntities.add(op.entityId);
            }
            else if ((error.status === 400 || error.status === 413) && repository.quarantineSyncOperation) await repository.quarantineSyncOperation(op.operationId, error.message);
            else {
              if (error.status === 401) {
                await repository.setSyncPaired(false, { notify: false });
                result.status = 'needs-pairing';
              } else if (error.status === 408 || error.status === 429 || error.status >= 500 || error instanceof TypeError || !globalThis.navigator?.onLine) {
                result.status = 'waiting-connection'; result.retryable = true;
              } else result.status = 'needs-review';
              result.error = error.message;
              result.serverCursor = (await repository.getSyncState()).state.history?.serverCursor ?? 0;
              return;
            }
          }
          // Yield to rendering and input handling while draining large queues.
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (repository.listPendingAiIntents) result.aiRequests = await deliverAiOutbox({ repository, fetcher, acknowledged: committedAcks });
      result.status = await finalStatus('pending');
      result.retryable = result.status === 'pending';
      result.serverCursor = (await repository.getSyncState()).state.history?.serverCursor ?? 0;
      // Audio is an independent, default-off transfer plane. Failures never change text Sync status.
      result.audioSync = await synchronizeAudio({ fetcher, locks });
    } catch (error) {
      if (error.status === 401) {
        await repository.setSyncPaired(false, { notify: false });
        result.status = 'needs-pairing'; result.error = error.message; return;
      }
      if (error.status === 408 || error.status === 429 || error.status >= 500 || error.status === undefined && (error instanceof TypeError || !globalThis.navigator?.onLine)) {
        result.status = 'waiting-connection'; result.retryable = true; result.error = error.message; return;
      }
      result.status = 'needs-review'; result.error = error.message; throw error;
    } finally { onState(result.status); }
  });
  return result;
}
