const REQUEST_PATH = '/api/v1/ai/analysis-requests';

function makeError(code, status = 0) { return Object.assign(new Error(code || 'AI request failed'), { code, status }); }

async function jsonResponse(response) {
  let body;
  try { body = await response.json(); } catch { throw makeError('invalid_server_response', response.status); }
  if (!response.ok) throw makeError(typeof body?.error === 'string' ? body.error : 'ai_request_failed', response.status);
  return body;
}

async function requestAi(path, { method = 'GET', body, fetcher = fetch } = {}) {
  return jsonResponse(await fetcher(`/api/v1/ai/${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-NoteOS-AI': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

export async function discoverAi({ fetcher = fetch } = {}) {
  return requestAi('status', { fetcher });
}

export async function ensureAiSession({ fetcher = fetch } = {}) {
  return jsonResponse(await fetcher('/api/v1/sync/ai-session', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-NoteOS-Sync': '1' }, body: '{}',
  }));
}

export async function getAiConsent(noteId, { fetcher = fetch } = {}) {
  await ensureAiSession({ fetcher });
  return (await requestAi(`consents/${encodeURIComponent(noteId)}`, { fetcher })).consent;
}

export async function grantAiConsent(noteId, revision, { fetcher = fetch, requestId = crypto.randomUUID() } = {}) {
  await ensureAiSession({ fetcher });
  if (!revision || typeof revision.serverEpoch !== 'string' || !Number.isSafeInteger(revision.serverVersion) || revision.serverVersion < 1 || !/^[a-f0-9]{64}$/.test(revision.contentHash ?? '')) throw makeError('SYNC_REQUIRED', 409);
  const result = await requestAi(`consents/${encodeURIComponent(noteId)}`, {
    method: 'PUT', fetcher, body: { protocolVersion: 1, requestId, scope: 'organize', executionBoundary: 'MOCK', expectedServerEpoch: revision.serverEpoch, expectedServerVersion: revision.serverVersion, expectedContentHash: revision.contentHash },
  });
  return result.consent;
}

export async function revokeAiConsentServer(noteId, requestId, { fetcher = fetch } = {}) {
  await ensureAiSession({ fetcher });
  const result = await requestAi(`consents/${encodeURIComponent(noteId)}`, { method: 'DELETE', fetcher, body: { protocolVersion: 1, requestId } });
  return result.consent;
}

export async function getAiAnalysisRequest(requestId, { fetcher = fetch } = {}) {
  await ensureAiSession({ fetcher });
  return requestAi(`analysis-requests/${encodeURIComponent(requestId)}`, { fetcher });
}

/** @param {{repository: any, noteId: string, localRevision: number, fetcher?: typeof fetch, requestId?: string}} options */
export async function createAiAnalysisIntent({ repository, noteId, localRevision, fetcher = fetch, requestId = crypto.randomUUID() } = {}) {
  const consent = await repository.getAiConsentCache(noteId);
  const intent = await repository.createAiAnalysisIntent({ requestId, noteId, localRevision, consentEpoch: consent?.consentEpoch });
  await deliverAiOutbox({ repository, fetcher });
  return (await repository.listAiIntents(noteId)).find(row => row.requestId === intent.requestId) ?? intent;
}

/** @param {{repository: any, noteId: string, fetcher?: typeof fetch, requestId?: string}} options */
export async function revokeAiConsent({ repository, noteId, fetcher = fetch, requestId = crypto.randomUUID() } = {}) {
  const intent = await repository.queueAiConsentRevoke({ requestId, noteId });
  await deliverAiOutbox({ repository, fetcher });
  return (await repository.listAiIntents(noteId)).find(row => row.requestId === intent.requestId) ?? intent;
}

function isTransient(error) { return !error.status || error.status === 408 || error.status === 429 || error.status >= 500; }

/** Delivers only explicit metadata intents, never note bodies. */
export async function deliverAiOutbox({ repository, fetcher = fetch, acknowledged = [] } = {}) {
  if (typeof repository?.listPendingAiIntents !== 'function') return { delivered: 0, waiting: 0, failed: 0 };
  const intents = await repository.listPendingAiIntents();
  if (!intents.length) return { delivered: 0, waiting: 0, failed: 0 };
  try { await ensureAiSession({ fetcher }); }
  catch (error) {
    if (error.status === 401) { await repository.setSyncPaired?.(false, { notify: false }); }
    return { delivered: 0, waiting: intents.length, failed: 0, error: error.code };
  }
  const ackByNoteRevision = new Map(acknowledged.map(ack => [`${ack.id}:${ack.localRevision}`, ack]));
  let delivered = 0, waiting = 0, failed = 0;
  for (const intent of intents) {
    try {
      if (intent.kind === 'revoke') {
        const result = await requestAi(`consents/${encodeURIComponent(intent.noteId)}`, { method: 'DELETE', fetcher, body: { protocolVersion: 1, requestId: intent.requestId } });
        const consent = result.consent;
        await repository.cacheAiConsent(consent);
        await repository.updateAiIntent(intent.requestId, 'REVOKED');
        delivered++;
        continue;
      }
      const note = await repository.get(intent.noteId);
      if (!note || note.revision !== intent.localRevision || note.lifecycle !== 'active') {
        await repository.updateAiIntent(intent.requestId, 'STALE'); failed++; continue;
      }
      if (note.privacy === 'DEVICE_ONLY' || !['PRIVATE_SERVER','CLOUD_ALLOWED'].includes(note.privacy)) {
        await repository.updateAiIntent(intent.requestId, 'CANCELED'); failed++; continue;
      }
      const ack = ackByNoteRevision.get(`${intent.noteId}:${intent.localRevision}`);
      const baseline = ack ?? await repository.getSyncBaseline(intent.noteId);
      const sync = await repository.getSyncState();
      if (!baseline || baseline.localRevision !== intent.localRevision || !Number.isSafeInteger(baseline.serverVersion) || baseline.serverVersion < 1 || typeof baseline.contentHash !== 'string' || !sync.state.history?.serverEpoch) {
        waiting++; continue;
      }
      if (ack && ack.serverEpoch !== sync.state.history.serverEpoch) { await repository.updateAiIntent(intent.requestId, 'STALE'); failed++; continue; }
      const consent = (await requestAi(`consents/${encodeURIComponent(intent.noteId)}`, { fetcher })).consent;
      await repository.cacheAiConsent(consent);
      if (consent.state === 'REVOKED' || consent.state === 'NONE') { await repository.updateAiIntent(intent.requestId, 'CANCELED'); failed++; continue; }
      if (consent.state !== 'APPROVED_LOCAL_ONLY' || consent.providerBoundary !== 'MOCK' || consent.consentEpoch !== intent.consentEpoch || !consent.scopes.includes('organize')) {
        await repository.updateAiIntent(intent.requestId, 'NEEDS_CONSENT'); failed++; continue;
      }
      const result = await requestAi(REQUEST_PATH.slice('/api/v1/ai/'.length), {
        method: 'POST', fetcher, body: {
          protocolVersion: 1, requestId: intent.requestId, noteId: intent.noteId,
          expectedServerEpoch: ack?.serverEpoch ?? sync.state.history.serverEpoch,
          expectedServerVersion: baseline.serverVersion, expectedContentHash: baseline.contentHash,
          consentEpoch: intent.consentEpoch, scope: intent.scope, executionBoundary: intent.executionBoundary,
        },
      });
      await repository.updateAiIntent(intent.requestId, 'QUEUED', { jobId: result.jobId, serverStatus: result.status }); delivered++;
    } catch (error) {
      if (error.code === 'STALE_REVISION' || error.code === 'SERVER_EPOCH_CHANGED') { await repository.updateAiIntent(intent.requestId, 'STALE'); failed++; }
      else if (error.code === 'CONSENT_REQUIRED' || error.code === 'CONSENT_CHANGED' || error.code === 'DEVICE_ONLY' || error.code === 'PRIVACY_REQUIRED') { await repository.updateAiIntent(intent.requestId, 'NEEDS_CONSENT'); failed++; }
      else if (error.code === 'SYNC_REQUIRED' || isTransient(error)) { waiting++; }
      else { await repository.updateAiIntent(intent.requestId, 'ERROR'); failed++; }
    }
  }
  return { delivered, waiting, failed };
}
