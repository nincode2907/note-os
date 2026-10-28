import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, serverMeta, transaction, appendChange } from './storage.mjs';
import { issuePairingCode, redeemPairingCode } from './auth.mjs';
import { handleSync } from './http.mjs';
import { applyAiSchema, claimAiJob } from './ai-foundation.mjs';
import { handleAi } from './ai-http.mjs';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';

const origin = 'http://127.0.0.1:15700';
const enabled = { NODE_ENV: 'test', NOTEOS_SYNC_ENABLED: '1', NOTEOS_AI_ORGANIZE_ENABLED: '1', NOTEOS_AI_INFERENCE_ENABLED: '0', NOTEOS_SYNC_ALLOWED_ORIGINS: origin };
let sequence = 0;

function noteFixture(id = `bridge-note-${++sequence}`, privacy = 'PRIVATE_SERVER') {
  return { id, title: `Synthetic ${id}`, document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic body only.' }] }] }, schemaVersion: 1, createdAt: 1, updatedAt: 2, lifecycle: 'active', revision: 1, privacy, tags: [] };
}

function setup(t, note = null) {
  const root = mkdtempSync(join(tmpdir(), 'noteos-ai-http-'));
  const db = openStore(root, { initialize: true }); applyAiSchema(db);
  writeFileSync(join(root, '.sync-epoch'), serverMeta(db).serverEpoch, { mode: 0o600 });
  const pair = (label = 'synthetic owner') => redeemPairingCode(db, issuePairingCode(db), label);
  const commit = (record, version = 1) => transaction(db, () => {
    const json = canonicalJson(record), content = { ...record }; delete content.revision; delete content.createdAt; delete content.updatedAt;
    const contentHash = createHash('sha256').update(canonicalJson(content)).digest('hex');
    const cursor = appendChange(db, 'note', record.id, version, 'upsert', json);
    if (version === 1) db.prepare("INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES('note',?,?,?,?,?,0,?)").run(record.id, version, json, contentHash, record.lifecycle, cursor);
    else db.prepare("UPDATE sync_entities SET server_version=?,record_json=?,content_hash=?,lifecycle=?,committed_cursor=? WHERE entity_type='note' AND id=?").run(version, json, contentHash, record.lifecycle, cursor, record.id);
    return { serverEpoch: serverMeta(db).serverEpoch, serverVersion: version, contentHash, serverCursor: cursor };
  });
  if (note) commit(note);
  t.after(() => { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, db, env: { ...enabled, NOTEOS_SYNC_STORAGE: root }, pair, commit };
}

function apiRequest(path, { method = 'GET', token, body, originHeader = origin, headers: extra = {} } = {}) {
  const headers = new Headers({ host: '127.0.0.1:15700', origin: originHeader, 'sec-fetch-site': 'same-origin', ...extra });
  if (token) headers.set('cookie', `noteos_ai_local=${token}`);
  if (body !== undefined) { headers.set('content-type', 'application/json'); headers.set('x-noteos-ai', '1'); }
  return new Request(`${origin}/api/v1/ai/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function grantBody(noteId, committed, requestId = crypto.randomUUID()) {
  return { protocolVersion: 1, requestId, scope: 'organize', executionBoundary: 'MOCK', expectedServerEpoch: committed.serverEpoch, expectedServerVersion: committed.serverVersion, expectedContentHash: committed.contentHash };
}

function requestBody(noteId, committed, consentEpoch = 1, requestId = crypto.randomUUID()) {
  return { protocolVersion: 1, requestId, noteId, expectedServerEpoch: committed.serverEpoch, expectedServerVersion: committed.serverVersion, expectedContentHash: committed.contentHash, consentEpoch, scope: 'organize', executionBoundary: 'MOCK' };
}

async function call(host, path, options = {}) { return handleAi(apiRequest(path, { token: options.token ?? host.device.token, ...options }), path, host.env); }

test('AI API is feature-gated before storage access and reports synthetic boundary only', async t => {
  const { env } = setup(t);
  const disabled = await handleAi(apiRequest('status'), 'status', { ...env, NOTEOS_AI_ORGANIZE_ENABLED: '0', NOTEOS_SYNC_STORAGE: '/unavailable' });
  assert.equal(disabled.status, 503); assert.deepEqual(await disabled.json(), { error: 'ai_disabled' });
  const status = await handleAi(apiRequest('status'), 'status', env);
  assert.deepEqual(await status.json(), { enabled: true, scope: 'organize', executionBoundary: 'MOCK', inferenceAvailable: false });
});

test('pairing reuses the paired token for a path-scoped AI cookie without changing device state', async t => {
  const host = setup(t), paired = host.pair(); host.device = paired;
  const before = host.db.prepare('SELECT id,token_hash,revoked_at FROM sync_devices').all();
  const response = await handleSync(new Request(`${origin}/api/v1/sync/ai-session`, { method: 'POST', headers: { host: '127.0.0.1:15700', origin, 'sec-fetch-site': 'same-origin', cookie: `noteos_sync_local=${paired.token}`, 'content-type': 'application/json', 'x-noteos-sync': '1' }, body: '{}' }), 'ai-session', host.env);
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1); assert.match(cookies[0], /noteos_ai_local=.*Path=\/api\/v1\/ai; HttpOnly; SameSite=Strict/);
  assert.deepEqual(host.db.prepare('SELECT id,token_hash,revoked_at FROM sync_devices').all(), before);
});

test('unpaired, revoked, cross-origin and missing-CSRF clients cannot access consent mutations', async t => {
  const note = noteFixture('auth-check'), host = setup(t, note), device = host.pair(); host.device = device;
  const live = host.db.prepare('SELECT server_version serverVersion,content_hash contentHash FROM sync_entities WHERE id=?').get(note.id);
  const body = grantBody(note.id, { ...live, serverEpoch: serverMeta(host.db).serverEpoch });
  assert.equal((await call(host, `consents/${note.id}`, { method: 'PUT', token: 'invalid', body })).status, 401);
  const missingHeader = apiRequest(`consents/${note.id}`, { method: 'PUT', token: device.token, body });
  missingHeader.headers.delete('x-noteos-ai');
  assert.equal((await handleAi(missingHeader, `consents/${note.id}`, host.env)).status, 403);
  assert.equal((await handleAi(apiRequest(`consents/${note.id}`, { method: 'PUT', token: device.token, body, originHeader: 'https://attacker.example' }), `consents/${note.id}`, host.env)).status, 403);
  host.db.prepare('UPDATE sync_devices SET revoked_at=10 WHERE id=?').run(device.id);
  assert.equal((await call(host, `consents/${note.id}`)).status, 401);
});

test('grant and revoke are device-attributed and request-idempotent; revocation is shared by connections', async t => {
  const note = noteFixture('consent-flow'), host = setup(t, note), first = host.pair('browser one'), second = host.pair('browser two');
  host.device = first; const committed = host.db.prepare('SELECT server_version serverVersion,content_hash contentHash FROM sync_entities WHERE id=?').get(note.id);
  const revision = { ...committed, serverEpoch: serverMeta(host.db).serverEpoch };
  const grant = grantBody(note.id, revision);
  const granted = await call(host, `consents/${note.id}`, { method: 'PUT', body: grant });
  assert.equal(granted.status, 200); assert.equal((await granted.json()).consent.consentEpoch, 1);
  const repeatedGrant = await call(host, `consents/${note.id}`, { method: 'PUT', body: grant });
  assert.equal((await repeatedGrant.json()).consent.replayed, true);
  const conflictingGrant = await call(host, `consents/${note.id}`, { method: 'PUT', body: { ...grant, expectedServerVersion: 2 } });
  assert.equal(conflictingGrant.status, 409); assert.equal((await conflictingGrant.json()).error, 'IDEMPOTENCY_CONFLICT');
  const consent = await call(host, `consents/${note.id}`);
  assert.equal((await consent.json()).consent.state, 'APPROVED_LOCAL_ONLY');
  const audit = host.db.prepare("SELECT actor_id actorId,metadata_json metadata FROM ai_audit_log WHERE action='CONSENT_GRANTED'").get();
  assert.equal(audit.actorId, first.id); assert.equal(JSON.parse(audit.metadata).actorDeviceId, first.id);

  host.device = second; const revokeId = crypto.randomUUID(), revokeBody = { protocolVersion: 1, requestId: revokeId };
  const revoked = await call(host, `consents/${note.id}`, { method: 'DELETE', body: revokeBody });
  assert.equal((await revoked.json()).consent.state, 'REVOKED');
  assert.equal(host.db.prepare('SELECT state FROM ai_note_consent WHERE note_id=?').get(note.id).state, 'REVOKED');
  const connectionB = openStore(host.root);
  try { assert.equal(connectionB.prepare('SELECT state FROM ai_note_consent WHERE note_id=?').get(note.id).state, 'REVOKED'); }
  finally { connectionB.close(); }
  const repeatedRevoke = await call(host, `consents/${note.id}`, { method: 'DELETE', body: revokeBody });
  assert.equal((await repeatedRevoke.json()).consent.replayed, true);
});

test('request before Sync ACK is recoverable; accepted request binds the exact revision and never exposes note content', async t => {
  const host = setup(t), device = host.pair(); host.device = device;
  const meta = serverMeta(host.db), before = { serverEpoch: meta.serverEpoch, serverVersion: 1, contentHash: 'a'.repeat(64) };
  const missingAck = await call(host, 'analysis-requests', { method: 'POST', body: requestBody('not-yet-committed', before) });
  assert.equal(missingAck.status, 409); assert.equal((await missingAck.json()).error, 'SYNC_REQUIRED');
  assert.equal(host.db.prepare('SELECT count(*) n FROM ai_jobs').get().n, 0);

  const note = noteFixture('analysis-accepted'), committed = host.commit(note);
  const revision = { serverEpoch: committed.serverEpoch, serverVersion: committed.serverVersion, contentHash: committed.contentHash };
  await call(host, `consents/${note.id}`, { method: 'PUT', body: grantBody(note.id, revision) });
  const body = requestBody(note.id, revision);
  const result = await call(host, 'analysis-requests', { method: 'POST', body });
  assert.equal(result.status, 200);
  const accepted = await result.json(); assert.equal(accepted.status, 'QUEUED'); assert.equal(accepted.inferenceAvailable, false);
  assert.equal(JSON.stringify(accepted).includes(note.title), false);
  assert.equal(host.db.prepare('SELECT server_version serverVersion,content_sha256 contentHash,consent_epoch consentEpoch,actor_device_id actorDeviceId FROM ai_analysis_requests').get().serverVersion, 1);
  assert.equal(host.db.prepare('SELECT count(*) n FROM ai_jobs').get().n, 1);
  assert.equal(host.db.prepare("SELECT count(*) n FROM ai_audit_log WHERE action='JOB_ENQUEUED'").get().n, 1);
  const get = await call(host, `analysis-requests/${body.requestId}`);
  assert.equal((await get.json()).jobId, accepted.jobId);
});

test('request idempotency, dedupe, stale revisions, epochs and consent epochs fail closed', async t => {
  const note = noteFixture('request-identity'), host = setup(t, note), first = host.pair(), second = host.pair(); host.device = first;
  const committed = host.db.prepare('SELECT server_version serverVersion,content_hash contentHash FROM sync_entities WHERE id=?').get(note.id);
  const revision = { ...committed, serverEpoch: serverMeta(host.db).serverEpoch };
  await call(host, `consents/${note.id}`, { method: 'PUT', body: grantBody(note.id, revision) });
  const request = requestBody(note.id, revision), accepted = await call(host, 'analysis-requests', { method: 'POST', body: request });
  const firstResult = await accepted.json();
  const replay = await call(host, 'analysis-requests', { method: 'POST', body: request });
  assert.equal((await replay.json()).replayed, true);
  const duplicate = await call(host, 'analysis-requests', { method: 'POST', body: requestBody(note.id, revision) });
  const duplicateResult = await duplicate.json(); assert.equal(duplicateResult.jobId, firstResult.jobId); assert.equal(duplicateResult.reused, true);
  assert.equal(host.db.prepare('SELECT count(*) n FROM ai_jobs').get().n, 1);
  host.device = second;
  const actorConflict = await call(host, 'analysis-requests', { method: 'POST', body: request });
  assert.equal(actorConflict.status, 409); assert.equal((await actorConflict.json()).error, 'IDEMPOTENCY_CONFLICT');
  host.device = first;
  const changed = await call(host, 'analysis-requests', { method: 'POST', body: { ...request, expectedContentHash: 'b'.repeat(64) } });
  assert.equal(changed.status, 409); assert.equal((await changed.json()).error, 'IDEMPOTENCY_CONFLICT');
  const oldRevision = await call(host, 'analysis-requests', { method: 'POST', body: requestBody(note.id, { ...revision, serverVersion: 0 }, 1) });
  assert.equal(oldRevision.status, 400); // Version zero is structurally invalid.
  const badEpoch = await call(host, 'analysis-requests', { method: 'POST', body: requestBody(note.id, { ...revision, serverEpoch: 'other-server' }) });
  assert.equal((await badEpoch.json()).error, 'SERVER_EPOCH_CHANGED');
  const wrongConsent = await call(host, 'analysis-requests', { method: 'POST', body: requestBody(note.id, revision, 2) });
  assert.equal((await wrongConsent.json()).error, 'CONSENT_CHANGED');
  host.commit({ ...note, title: 'New current revision', revision: 2, updatedAt: 3 }, 2);
  const stale = await call(host, 'analysis-requests', { method: 'POST', body: requestBody(note.id, revision, 1) });
  assert.equal((await stale.json()).error, 'STALE_REVISION');
  assert.equal(host.db.prepare('SELECT count(*) n FROM ai_analysis_requests').get().n, 2); // distinct idempotency key, same deduplicated job
});

test('missing and DEVICE_ONLY privacy are rejected without changing canonical privacy', async t => {
  const host = setup(t), device = host.pair(); host.device = device;
  for (const [id, privacy, expected] of [['private-missing', undefined, 'PRIVACY_REQUIRED'],['private-device-only','DEVICE_ONLY','DEVICE_ONLY']]) {
    const note = { ...noteFixture(id), privacy }; if (privacy === undefined) delete note.privacy; host.commit(note);
    const revision = host.db.prepare('SELECT server_version serverVersion,content_hash contentHash FROM sync_entities WHERE id=?').get(id);
    const result = await call(host, `consents/${id}`, { method: 'PUT', body: grantBody(id, { ...revision, serverEpoch: serverMeta(host.db).serverEpoch }) });
    assert.equal(result.status, 403); assert.equal((await result.json()).error, expected);
    assert.equal(JSON.parse(host.db.prepare('SELECT record_json FROM sync_entities WHERE id=?').get(id).record_json).privacy, privacy);
  }
});

test('normal Text Sync push does not create an AI job; AI request requires a separate explicit call', async t => {
  const host = setup(t), device = host.pair(); host.device = device;
  const note = noteFixture('sync-no-ai');
  const op = { protocolVersion: 1, operations: [{ operationId: crypto.randomUUID(), entityId: note.id, baseServerVersion: 0, ownerApproved: true, recordingCount: 0, type: 'upsert', recordJson: canonicalJson(note) }] };
  const push = new Request(`${origin}/api/v1/sync/push`, { method: 'POST', headers: { host: '127.0.0.1:15700', origin, 'sec-fetch-site': 'same-origin', cookie: `noteos_sync_local=${device.token}`, 'content-type': 'application/json', 'x-noteos-sync': '1' }, body: JSON.stringify(op) });
  assert.equal((await handleSync(push, 'push', host.env)).status, 200);
  assert.equal(host.db.prepare('SELECT count(*) n FROM ai_jobs').get().n, 0);
  assert.equal(host.db.prepare('SELECT count(*) n FROM sync_changelog').get().n, 1);
});

test('authenticated AI requests are rate-limited per paired device', async t => {
  const note = noteFixture('rate-limit'), host = setup(t, note), device = host.pair(); host.device = device;
  for (let index = 0; index < 60; index++) assert.equal((await call(host, `consents/${note.id}`)).status, 200);
  const limited = await call(host, `consents/${note.id}`);
  assert.equal(limited.status, 429); assert.equal((await limited.json()).error, 'RATE_LIMITED');
});

test('concurrent duplicate requests create one logical job and a durable revoke blocks dispatch', async t => {
  const note = noteFixture('concurrent-requests'), host = setup(t, note), device = host.pair(); host.device = device;
  const committed = host.db.prepare('SELECT server_version serverVersion,content_hash contentHash FROM sync_entities WHERE id=?').get(note.id);
  const revision = { ...committed, serverEpoch: serverMeta(host.db).serverEpoch };
  await call(host, `consents/${note.id}`, { method: 'PUT', body: grantBody(note.id, revision) });

  const sameRequest = requestBody(note.id, revision);
  const sameResults = await Promise.all([
    call(host, 'analysis-requests', { method: 'POST', body: sameRequest }),
    call(host, 'analysis-requests', { method: 'POST', body: sameRequest }),
  ]);
  assert.deepEqual(sameResults.map(result => result.status), [200, 200]);
  const independentResults = await Promise.all([
    call(host, 'analysis-requests', { method: 'POST', body: requestBody(note.id, revision) }),
    call(host, 'analysis-requests', { method: 'POST', body: requestBody(note.id, revision) }),
  ]);
  assert.deepEqual(independentResults.map(result => result.status), [200, 200]);
  assert.equal(host.db.prepare('SELECT count(*) n FROM ai_jobs').get().n, 1);

  await call(host, `consents/${note.id}`, { method: 'DELETE', body: { protocolVersion: 1, requestId: crypto.randomUUID() } });
  assert.equal(host.db.prepare('SELECT status FROM ai_jobs').get().status, 'CANCELED');
  assert.equal(claimAiJob(host.db, 'synthetic-worker', { now: Date.now() }), null);
});

test('09B-1A: an unpersisted HTTP revoke returns 503, then grant and analysis request return REVOCATION_PENDING until the retry commits', async t => {
  const note = noteFixture('http-revoke-pending'), host = setup(t, note), device = host.pair(); host.device = device;
  const committed = host.db.prepare('SELECT server_version serverVersion,content_hash contentHash FROM sync_entities WHERE id=?').get(note.id);
  const revision = { ...committed, serverEpoch: serverMeta(host.db).serverEpoch };
  assert.equal((await call(host, `consents/${note.id}`, { method: 'PUT', body: grantBody(note.id, revision) })).status, 200);
  host.db.exec("CREATE TRIGGER ai_test_fail_revoke BEFORE UPDATE ON ai_note_consent BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  const revokeBody = { protocolVersion: 1, requestId: crypto.randomUUID() };
  const failed = await call(host, `consents/${note.id}`, { method: 'DELETE', body: revokeBody });
  assert.equal(failed.status, 503); assert.equal((await failed.json()).error, 'AI_REVOCATION_NOT_PERSISTED');
  host.db.exec('DROP TRIGGER ai_test_fail_revoke');
  const regrant = await call(host, `consents/${note.id}`, { method: 'PUT', body: grantBody(note.id, revision) });
  assert.equal(regrant.status, 409); assert.equal((await regrant.json()).error, 'REVOCATION_PENDING');
  const request = await call(host, 'analysis-requests', { method: 'POST', body: requestBody(note.id, revision) });
  assert.equal(request.status, 409); assert.equal((await request.json()).error, 'REVOCATION_PENDING');
  assert.equal(host.db.prepare('SELECT count(*) n FROM ai_jobs').get().n, 0);
  const retried = await call(host, `consents/${note.id}`, { method: 'DELETE', body: revokeBody });
  assert.equal(retried.status, 200); assert.equal((await retried.json()).consent.state, 'REVOKED');
  const fresh = await call(host, `consents/${note.id}`, { method: 'PUT', body: grantBody(note.id, revision) });
  assert.equal(fresh.status, 200); assert.equal((await fresh.json()).consent.consentEpoch, 3);
});
