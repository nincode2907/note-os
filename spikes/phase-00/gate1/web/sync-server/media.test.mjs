import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, appendChange, transaction, serverMeta } from './storage.mjs';
import { issuePairingCode, redeemPairingCode } from './auth.mjs';
import { handleAudioSync } from './media-http.mjs';
import { handleSync } from './http.mjs';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';

const origin = 'http://127.0.0.1:15700';
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'noteos-media-test-'));
  const db = openStore(root, { initialize: true });
  const paired = redeemPairingCode(db, issuePairingCode(db), 'Synthetic media fixture');
  transaction(db, () => {
    const record = { id: 'note-synthetic', privacy: 'PRIVATE_SERVER', lifecycle: 'active', title: 'Synthetic fixture' };
    const cursor = appendChange(db, 'note', record.id, 1, 'upsert', canonicalJson(record));
    db.prepare("INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES('note',?,1,?,'synthetic','active',0,?)").run(record.id, canonicalJson(record), cursor);
  });
  const env = { NOTEOS_SYNC_ENABLED: '1', NOTEOS_AUDIO_SYNC_ENABLED: '1', NOTEOS_SYNC_STORAGE: root, NOTEOS_SYNC_ALLOWED_ORIGINS: origin };
  const cookie = `noteos_sync_local=${paired.token}`;
  t.after(() => { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  const call = (action, { method = 'GET', body, raw, headers = {}, feature = true } = {}) => {
    const post = method !== 'GET';
    const req = new Request(`${origin}/api/v1/sync/${action}`, { method, headers: { host: '127.0.0.1:15700', ...(post ? { origin, 'x-noteos-sync': '1' } : {}), ...(raw ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}), cookie, ...headers }, ...(raw ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return handleAudioSync(req, action, { ...env, ...(feature ? {} : { NOTEOS_AUDIO_SYNC_ENABLED: '0' }) });
  };
  return { root, db, env, paired, cookie, call };
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function audioManifest(bytes, overrides = {}) {
  const recordingId = overrides.recordingId ?? 'recording-synthetic';
  return { protocolVersion: 1, transferId: randomUUID(), baseServerVersion: 0,
    recording: { id: recordingId, noteId: 'note-synthetic', title: 'Voice memo — 测试', mimeType: 'audio/webm;codecs=opus', status: 'complete', createdAt: 100, updatedAt: 101, durationMs: 1000 },
    anchors: { version: 1, items: [{ id: 'anchor-a', recordingId, offsetMs: 500, label: 'Điểm chính 🎧', createdAt: 102 }] },
    sha256: digest(bytes), totalBytes: bytes.length, chunkSize: 1024 * 1024,
    chunks: [{ index: 0, byteLength: bytes.length, sha256: digest(bytes) }] };
}
async function uploadFixture(call, manifest, bytes) {
  const approved = await call('media/approve', { method: 'POST', body: { noteId: 'note-synthetic', approved: true } });
  assert.equal(approved.status, 200);
  const started = await call('media/uploads', { method: 'POST', body: { manifest } });
  assert.equal(started.status, 200);
  if (!started.headers.get('content-type')?.includes('json')) return started.json();
  const startData = await started.json();
  if (!startData.alreadyCommitted && !(startData.received ?? []).includes(0)) {
    const chunk = await call(`media/uploads/${manifest.transferId}/chunks/0`, { method: 'PUT', raw: bytes });
    assert.equal(chunk.status, 204);
  }
  return { startData, completed: await call(`media/uploads/${manifest.transferId}/complete`, { method: 'POST', body: {} }) };
}

test('feature flag is off by default and does not migrate v2 or touch the media filesystem', async t => {
  const { db, call, root } = setup(t);
  const before = serverMeta(db);
  const response = await call('media/status', { feature: false });
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'audio_sync_disabled' });
  assert.deepEqual(serverMeta(db), before); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(existsSync(join(root, 'media')), false);
});

test('authenticated content-addressed upload, unicode anchors, download and per-device verification survive reopen', async t => {
  const { call, root, db } = setup(t), bytes = Buffer.from('synthetic-audio-bytes-🎵');
  const manifest = audioManifest(bytes);
  const upload = await uploadFixture(call, manifest, bytes);
  assert.equal(upload.completed.status, 200);
  const complete = await upload.completed.json(); assert.equal(complete.verifiedBytes, bytes.length);
  db.close();
  const reopened = openStore(root); assert.equal(serverMeta(reopened).serverCursor, 2); reopened.close();
  const changesResponse = await call('media/changes', { method: 'POST', body: { protocolVersion: 1, cursor: 0, limit: 100 } });
  const page = await changesResponse.json(); assert.equal(page.changes.length, 1);
  assert.equal(page.changes[0].anchors.items[0].label, 'Điểm chính 🎧');
  const download = await call('media/downloads/recording-synthetic/chunks/0');
  assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal(download.headers.get('x-noteos-chunk-sha256'), digest(bytes));
  const verified = await call('media/verify', { method: 'POST', body: { recordingId: 'recording-synthetic', sha256: digest(bytes) } });
  assert.equal((await verified.json()).verifiedBytes, bytes.length);
  const duplicate = await uploadFixture(call, manifest, bytes); assert.equal(duplicate.completed.status, 200);
  const afterDuplicate = openStore(root); assert.equal(afterDuplicate.prepare('SELECT count(*) n FROM sync_recording_media').get().n, 1); afterDuplicate.close();
});

test('v2 migration preserves epoch, cursor, devices and notes; unauthenticated audio request cannot migrate', async t => {
  const { db, call, paired, env, root } = setup(t), before = serverMeta(db);
  const unauthorized = new Request(`${origin}/api/v1/sync/media/status`, { headers: { host: '127.0.0.1:15700' } });
  assert.equal((await handleAudioSync(unauthorized, 'media/status', { ...env, NOTEOS_SYNC_STORAGE: root })).status, 401);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  const response = await call('media/status'); assert.equal(response.status, 200);
  const after = serverMeta(db); assert.equal(after.serverEpoch, before.serverEpoch); assert.equal(after.serverCursor, before.serverCursor); assert.equal(after.schemaVersion, 3);
  assert.equal(db.prepare('SELECT count(*) n FROM sync_devices WHERE id=?').get(paired.id).n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM sync_entities WHERE entity_type='note' AND id='note-synthetic'").get().n, 1);
});

test('DEVICE_ONLY note, cross-origin requests and unpaired clients cannot approve or upload', async t => {
  const { db, env, call, paired } = setup(t);
  db.prepare("UPDATE sync_entities SET record_json=? WHERE entity_type='note' AND id='note-synthetic'").run('{"id":"note-synthetic","privacy":"DEVICE_ONLY","lifecycle":"active"}');
  const denied = await call('media/approve', { method: 'POST', body: { noteId: 'note-synthetic', approved: true } }); assert.equal(denied.status, 403);
  const wrong = new Request(`${origin}/api/v1/sync/media/status`, { headers: { host: '127.0.0.1:15700', origin: 'http://evil.example' } });
  assert.equal((await handleAudioSync(wrong, 'media/status', env)).status, 403);
  const anonymous = new Request(`${origin}/api/v1/sync/media/status`, { headers: { host: '127.0.0.1:15700' } });
  assert.equal((await handleAudioSync(anonymous, 'media/status', env)).status, 401);
  db.prepare('UPDATE sync_devices SET revoked_at=? WHERE id=?').run(Date.now(), paired.id);
  const revoked = await call('media/status'); assert.equal(revoked.status, 401);
});

test('stale anchor metadata is preserved as a conflict instead of overwriting remote state', async t => {
  const { call } = setup(t), bytes = Buffer.from('anchors-conflict-fixture'), manifest = audioManifest(bytes);
  const uploaded = await uploadFixture(call, manifest, bytes); assert.equal(uploaded.completed.status, 200);
  const first = await call('media/metadata', { method: 'POST', body: { recordingId: 'recording-synthetic', baseServerVersion: 1, recordingMetadata: { title: 'Remote version', updatedAt: 200 }, anchors: manifest.anchors } });
  assert.equal(first.status, 200);
  const stale = await call('media/metadata', { method: 'POST', body: { recordingId: 'recording-synthetic', baseServerVersion: 1, recordingMetadata: { title: 'Local version', updatedAt: 201 }, anchors: { version: 1, items: [] } } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'audio_metadata_conflict');
});

test('durable staged chunk is recovered when the process stopped before its SQLite receipt', async t => {
  const { call, db } = setup(t), bytes = Buffer.from('recovery-fixture'), manifest = audioManifest(bytes);
  await call('media/approve', { method: 'POST', body: { noteId: 'note-synthetic', approved: true } });
  const start = await call('media/uploads', { method: 'POST', body: { manifest } }); assert.equal(start.status, 200);
  assert.equal((await call(`media/uploads/${manifest.transferId}/chunks/0`, { method: 'PUT', raw: bytes })).status, 204);
  db.prepare('DELETE FROM sync_media_upload_chunks WHERE transfer_id=?').run(manifest.transferId);
  const status = await call('media/status'); assert.equal(status.status, 200);
  assert.equal(db.prepare('SELECT count(*) n FROM sync_media_upload_chunks WHERE transfer_id=?').get(manifest.transferId).n, 1);
  const completed = await call(`media/uploads/${manifest.transferId}/complete`, { method: 'POST', body: {} }); assert.equal(completed.status, 200);
});

test('corrupted upload chunk is rejected and never enters the committed chunk manifest', async t => {
  const { call, db } = setup(t), bytes = Buffer.from('expected-bytes'), manifest = audioManifest(bytes);
  await call('media/approve', { method: 'POST', body: { noteId: 'note-synthetic', approved: true } });
  assert.equal((await call('media/uploads', { method: 'POST', body: { manifest } })).status, 200);
  const rejected = await call(`media/uploads/${manifest.transferId}/chunks/0`, { method: 'PUT', raw: Buffer.alloc(bytes.length, 0x7f) });
  assert.equal(rejected.status, 422); assert.equal((await rejected.json()).error, 'audio_chunk_digest_mismatch');
  assert.equal(db.prepare('SELECT count(*) n FROM sync_media_upload_chunks').get().n, 0);
  assert.equal((await call(`media/uploads/${manifest.transferId}/chunks/0`, { method: 'PUT', raw: bytes })).status, 204);
});

test('assembled bytes with a wrong full recording digest are never published or device-verified', async t => {
  const { call, db } = setup(t), first = Buffer.alloc(1024 * 1024, 0x31), tail = Buffer.from('synthetic-tail'), bytes = Buffer.concat([first, tail]), manifest = audioManifest(bytes);
  manifest.transferId = randomUUID(); manifest.sha256 = 'f'.repeat(64); manifest.chunks = [{ index: 0, byteLength: first.length, sha256: digest(first) }, { index: 1, byteLength: tail.length, sha256: digest(tail) }];
  await call('media/approve', { method: 'POST', body: { noteId: 'note-synthetic', approved: true } });
  assert.equal((await call('media/uploads', { method: 'POST', body: { manifest } })).status, 200);
  assert.equal((await call(`media/uploads/${manifest.transferId}/chunks/0`, { method: 'PUT', raw: first })).status, 204);
  assert.equal((await call(`media/uploads/${manifest.transferId}/chunks/1`, { method: 'PUT', raw: tail })).status, 204);
  const response = await call(`media/uploads/${manifest.transferId}/complete`, { method: 'POST', body: {} });
  assert.equal(response.status, 422); assert.equal((await response.json()).error, 'audio_object_digest_mismatch');
  assert.equal(db.prepare('SELECT count(*) n FROM sync_recording_media').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM sync_media_device_state').get().n, 0);
});

test('concurrent retries of the same transfer publish one recording object and one metadata event', async t => {
  const { call, db } = setup(t), bytes = Buffer.from('concurrent-idempotent-fixture'), manifest = audioManifest(bytes);
  await call('media/approve', { method: 'POST', body: { noteId: 'note-synthetic', approved: true } });
  const first = await call('media/uploads', { method: 'POST', body: { manifest } }), second = await call('media/uploads', { method: 'POST', body: { manifest } });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  await Promise.all([0, 1].map(() => call(`media/uploads/${manifest.transferId}/chunks/0`, { method: 'PUT', raw: bytes })));
  const completions = await Promise.all([0, 1].map(() => call(`media/uploads/${manifest.transferId}/complete`, { method: 'POST', body: {} })));
  assert.ok(completions.every(response => response.status === 200));
  assert.equal(db.prepare('SELECT count(*) n FROM sync_recording_media').get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM sync_changelog WHERE entity_type='recording'").get().n, 1);
});

test('upload reservation enforces a configured disk quota before accepting payload bytes', async t => {
  const { call, db, env, cookie } = setup(t), one = Buffer.from('x'), base = audioManifest(one);
  await call('media/approve', { method: 'POST', body: { noteId: 'note-synthetic', approved: true } });
  const count = 65, chunks = Array.from({ length: count }, (_, index) => ({ index, byteLength: index === count - 1 ? 1 : 1024 * 1024, sha256: 'a'.repeat(64) }));
  const manifest = { ...base, transferId: randomUUID(), totalBytes: 64 * 1024 * 1024 + 1, chunks, sha256: 'b'.repeat(64) };
  const response = await handleAudioSync(new Request(`${origin}/api/v1/sync/media/uploads`, { method: 'POST', headers: { host: '127.0.0.1:15700', origin, cookie, 'content-type': 'application/json', 'x-noteos-sync': '1' }, body: JSON.stringify({ manifest }) }), 'media/uploads', { ...env, NOTEOS_AUDIO_SYNC_MAX_BYTES: String(64 * 1024 * 1024) });
  assert.equal(response.status, 507); assert.equal((await response.json()).error, 'audio_storage_quota_exceeded');
  assert.equal(db.prepare('SELECT count(*) n FROM sync_media_uploads').get().n, 0);
});

test('unfinished recording metadata is rejected and parent trash preserves committed audio', async t => {
  const { call, db } = setup(t), bytes = Buffer.from('preserve-trashed-audio'), base = audioManifest(bytes);
  const partial = { ...base, recording: { ...base.recording, status: 'interrupted' } };
  const denied = await call('media/uploads', { method: 'POST', body: { manifest: partial } }); assert.equal(denied.status, 400);
  const manifest = audioManifest(bytes);
  await uploadFixture(call, manifest, bytes);
  db.prepare("UPDATE sync_entities SET lifecycle='trashed' WHERE entity_type='note' AND id='note-synthetic'").run();
  const downloaded = await call('media/downloads/recording-synthetic/chunks/0'); assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal(db.prepare("SELECT count(*) n FROM sync_recording_media WHERE recording_id='recording-synthetic'").get().n, 1);
});

test('text pull advances across recording events without exposing media metadata as a note change', async t => {
  const { call, env, cookie } = setup(t), bytes = Buffer.from('text-cursor-regression'), manifest = audioManifest(bytes);
  await uploadFixture(call, manifest, bytes);
  const response = await handleSync(new Request(`${origin}/api/v1/sync/pull`, { method: 'POST', headers: { host: '127.0.0.1:15700', origin, cookie, 'content-type': 'application/json', 'x-noteos-sync': '1' }, body: JSON.stringify({ protocolVersion: 1, cursor: 1, limit: 100 }) }), 'pull', env);
  const page = await response.json(); assert.equal(response.status, 200); assert.equal(page.nextCursor, 2); assert.equal(page.changes.length, 0);
});

test('invalid Host and missing CSRF marker are rejected for media routes', async t => {
  const { env, cookie } = setup(t);
  const badHost = new Request(`${origin}/api/v1/sync/media/status`, { headers: { host: 'evil.example', cookie } });
  assert.equal((await handleAudioSync(badHost, 'media/status', env)).status, 403);
  const missingMarker = new Request(`${origin}/api/v1/sync/media/approve`, { method: 'POST', headers: { host: '127.0.0.1:15700', origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ noteId: 'note-synthetic', approved: true }) });
  assert.equal((await handleAudioSync(missingMarker, 'media/approve', env)).status, 403);
});
