import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { indexedDB } from 'fake-indexeddb';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNotesRepository, createAudioRepository, makeEmptyNote } from './local-notes.js';
import { synchronizeAudio } from './audio-sync-client.mjs';
import { synchronize } from './sync-client.mjs';
import { openStore, transaction, appendChange } from '../../sync-server/storage.mjs';
import { issuePairingCode, redeemPairingCode } from '../../sync-server/auth.mjs';
import { handleAudioSync } from '../../sync-server/media-http.mjs';
import { handleSync } from '../../sync-server/http.mjs';
import { canonicalJson } from './sync-protocol.mjs';

const origin = 'http://127.0.0.1:15700'; let sequence = 0;
process.chdir(fileURLToPath(new URL('../..', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function localDevice(name, note) {
  const notes = createNotesRepository(indexedDB, name), audio = createAudioRepository(indexedDB, name);
  await notes.create(note);
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const tx = db.transaction(['syncBaselines', 'syncEnrollment'], 'readwrite'); tx.objectStore('syncBaselines').put({ id: note.id, serverVersion: 1, localRevision: note.revision, contentHash: 'synthetic', privacy: note.privacy }); tx.objectStore('syncEnrollment').put({ id: note.id, optedIn: true });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); }); db.close();
  return { notes, audio };
}
async function server(t, note, { seedNote = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'noteos-audio-client-')), db = openStore(root, { initialize: true });
  const env = { NOTEOS_SYNC_ENABLED: '1', NOTEOS_AUDIO_SYNC_ENABLED: '1', NOTEOS_SYNC_STORAGE: root, NOTEOS_SYNC_ALLOWED_ORIGINS: origin };
  if (seedNote) transaction(db, () => { const cursor = appendChange(db, 'note', note.id, 1, 'upsert', canonicalJson(note)); db.prepare("INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES('note',?,1,?,'synthetic','active',0,?)").run(note.id, canonicalJson(note), cursor); });
  t.after(() => { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  const device = label => redeemPairingCode(db, issuePairingCode(db), label);
  const fetcher = token => async (url, init = {}) => {
    const headers = new Headers(init.headers); headers.set('host', '127.0.0.1:15700'); headers.set('cookie', `noteos_sync_local=${token}`);
    if (init.method !== 'GET') headers.set('origin', origin);
    const request = new Request(new URL(url, origin), { ...init, headers });
    const action = new URL(request.url).pathname.split('/api/v1/sync/')[1];
    return action.startsWith('media/') ? handleAudioSync(request, action, env) : handleSync(request, action, env);
  };
  const locks = { request: async (_name, _options, callback) => callback({ name: 'synthetic-lock' }) };
  return { root, db, device, fetcher, locks };
}

async function putRecording(name, recording, chunks) {
  const db = await new Promise((resolve, reject) => { const req = indexedDB.open(name); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const tx = db.transaction(['recordings', 'recordingChunks'], 'readwrite');
  tx.objectStore('recordings').put(recording);
  for (const chunk of chunks) tx.objectStore('recordingChunks').put(chunk);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); }); db.close();
}

async function removeLocalChunks(name, recordingId, { sequence: onlySequence, corrupt = false } = {}) {
  const db = await new Promise((resolve, reject) => { const req = indexedDB.open(name); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const tx = db.transaction('recordingChunks', 'readwrite'), store = tx.objectStore('recordingChunks'), request = store.index('recordingId').getAll(recordingId);
  request.onsuccess = () => { for (const row of request.result) {
    if (onlySequence !== undefined && row.sequence !== onlySequence) continue;
    if (corrupt) store.put({ ...row, blob: new Blob(['corrupt bytes']) }); else store.delete(row.id);
  } };
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); }); db.close();
}

async function downloadedFixture(t, suffix = `recovery-${++sequence}`) {
  const note = { ...makeEmptyNote(100, `note-${suffix}`), privacy: 'PRIVATE_SERVER' };
  const sourceName = `audio-source-${suffix}`, targetName = `audio-target-${suffix}`;
  const source = await localDevice(sourceName, note), target = await localDevice(targetName, note), host = await server(t, note);
  const sourceDevice = host.device(`source ${suffix}`), targetDevice = host.device(`target ${suffix}`), bytes = Buffer.alloc(1024 * 1024 + 31, 37);
  const recording = await source.audio.create(note.id, { mimeType: 'audio/webm', ownerId: 'synthetic-tab', createdAt: 101 });
  await source.audio.appendChunk(recording.id, 0, new Blob([bytes.subarray(0, 1024 * 1024)]), 500);
  await source.audio.appendChunk(recording.id, 1, new Blob([bytes.subarray(1024 * 1024)]), 1000);
  await source.audio.setStatus(recording.id, 'complete', { durationMs: 1000 }); await source.audio.setSyncApproval(note.id, true);
  assert.equal((await synchronizeAudio({ fetcher: host.fetcher(sourceDevice.token), locks: host.locks, repository: source.audio })).status, 'transferred');
  assert.equal(JSON.parse(host.db.prepare('SELECT manifest_json FROM sync_recording_media WHERE recording_id=?').get(recording.id).manifest_json).chunks.length, 2);
  await target.audio.setSyncApproval(note.id, true);
  assert.equal((await synchronizeAudio({ fetcher: host.fetcher(targetDevice.token), locks: host.locks, repository: target.audio })).status, 'transferred');
  assert.equal(JSON.parse(host.db.prepare('SELECT manifest_json FROM sync_recording_media WHERE recording_id=?').get(recording.id).manifest_json).chunks.length, 2);
  return { note, source, target, host, sourceDevice, targetDevice, recording, bytes, targetName };
}

test('synthetic paired clients upload and download ordered multi-chunk audio with independent verified-here status', async t => {
  const note = { ...makeEmptyNote(100, `note-${++sequence}`), privacy: 'PRIVATE_SERVER' };
  const sourceName = `audio-client-source-${sequence}`, targetName = `audio-client-target-${sequence}`;
  const source = await localDevice(sourceName, note), target = await localDevice(targetName, note), host = await server(t, note);
  const firstDevice = host.device('source browser'), secondDevice = host.device('target browser');
  const bytes = Buffer.alloc(1024 * 1024 + 73); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const recording = await source.audio.create(note.id, { mimeType: 'audio/webm;codecs=opus', ownerId: 'synthetic-tab', createdAt: 101 });
  await source.audio.appendChunk(recording.id, 0, new Blob([bytes.subarray(0, 300001)], { type: recording.mimeType }), 600);
  await source.audio.appendChunk(recording.id, 1, new Blob([bytes.subarray(300001)], { type: recording.mimeType }), 1200);
  await source.audio.setStatus(recording.id, 'complete', { durationMs: 1200 });
  await source.audio.setSyncApproval(note.id, true);
  assert.equal((await source.audio.listSyncCandidates()).length, 1);
  const upload = await synchronizeAudio({ fetcher: host.fetcher(firstDevice.token), locks: host.locks, repository: source.audio });
  assert.equal(upload.status, 'transferred', JSON.stringify(upload));
  assert.equal((await source.audio.getSyncStateForRecording(recording.id)).status, 'verified-here');
  const cursorAdvance = await synchronizeAudio({ fetcher: host.fetcher(secondDevice.token), locks: host.locks, repository: target.audio });
  assert.equal(cursorAdvance.status, 'idle');
  await target.audio.setSyncApproval(note.id, true);
  const download = await synchronizeAudio({ fetcher: host.fetcher(secondDevice.token), locks: host.locks, repository: target.audio });
  assert.equal(download.status, 'transferred');
  const received = await target.audio.get(recording.id), chunks = await target.audio.chunks(recording.id);
  assert.equal(received.syncState, 'verified-here'); assert.equal(received.status, 'complete');
  const receivedBlob = new Blob(chunks.map(row => row.blob));
  assert.equal(receivedBlob.size, bytes.length); assert.equal(hash(Buffer.from(await receivedBlob.arrayBuffer())), hash(bytes));
  assert.equal((await target.audio.getSyncStateForRecording(recording.id)).status, 'verified-here');
});

test('local audio approval fails closed for unknown privacy, DEVICE_ONLY and notes not yet text-synced', async () => {
  for (const [suffix, privacy, baseline] of [['unknown', undefined, true], ['device', 'DEVICE_ONLY', true], ['unsynced', 'PRIVATE_SERVER', false]]) {
    const name = `audio-approval-${suffix}-${++sequence}`, note = { ...makeEmptyNote(100, `note-${suffix}-${sequence}`), ...(privacy ? { privacy } : {}) };
    const repo = createNotesRepository(indexedDB, name), audio = createAudioRepository(indexedDB, name); await repo.create(note);
    if (baseline) {
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open(name); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const tx = db.transaction('syncBaselines', 'readwrite'); tx.objectStore('syncBaselines').put({ id: note.id, serverVersion: 1, localRevision: 0 });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); }); db.close();
    }
    await assert.rejects(audio.setSyncApproval(note.id, true));
    assert.equal(await audio.getSyncApproval(note.id), null);
  }
});

test('upload retry resumes after chunk N and download retry reuses verified IndexedDB chunks', async t => {
  const note = { ...makeEmptyNote(100, `note-retry-${++sequence}`), privacy: 'PRIVATE_SERVER' };
  const sourceName = `audio-retry-source-${sequence}`, targetName = `audio-retry-target-${sequence}`;
  const source = await localDevice(sourceName, note), target = await localDevice(targetName, note), host = await server(t, note);
  const first = host.device('retry source'), second = host.device('retry target');
  const bytes = Buffer.alloc(1024 * 1024 + 13, 91), recording = await source.audio.create(note.id, { mimeType: 'audio/webm', ownerId: 'synthetic-tab', createdAt: 101 });
  await source.audio.appendChunk(recording.id, 0, new Blob([bytes.subarray(0, 1024 * 1024)], { type: recording.mimeType }), 500);
  await source.audio.appendChunk(recording.id, 1, new Blob([bytes.subarray(1024 * 1024)], { type: recording.mimeType }), 1000);
  await source.audio.setStatus(recording.id, 'complete', { durationMs: 1000 }); await source.audio.setSyncApproval(note.id, true);
  const baseUpload = host.fetcher(first.token); let failedUpload = false;
  const interruptedUpload = async (url, init) => {
    if (!failedUpload && init.method === 'PUT' && String(url).endsWith('/chunks/1')) { failedUpload = true; throw new TypeError('synthetic network loss after chunk 0'); }
    return baseUpload(url, init);
  };
  const partial = await synchronizeAudio({ fetcher: interruptedUpload, locks: host.locks, repository: source.audio });
  assert.equal(partial.status, 'waiting-connection');
  const pending = await source.audio.getSyncStateForRecording(recording.id); assert.equal(pending.status, 'uploading'); assert.equal(pending.verifiedBytes, 1024 * 1024);
  const resumed = await synchronizeAudio({ fetcher: baseUpload, locks: host.locks, repository: createAudioRepository(indexedDB, sourceName) }); assert.equal(resumed.status, 'transferred');

  await target.audio.setSyncApproval(note.id, true);
  const baseDownload = host.fetcher(second.token); let failedDownload = false;
  const interruptedDownload = async (url, init) => {
    if (!failedDownload && String(url).endsWith('/chunks/1')) { failedDownload = true; throw new TypeError('synthetic network loss after downloaded chunk 0'); }
    return baseDownload(url, init);
  };
  const partialDownload = await synchronizeAudio({ fetcher: interruptedDownload, locks: host.locks, repository: target.audio });
  assert.equal(partialDownload.status, 'waiting-connection');
  const transferState = await target.audio.getSyncStateForRecording(recording.id); assert.equal(transferState.status, 'downloading');
  assert.equal((await target.audio.listDownloadedChunks(transferState.transferId)).length, 1);
  assert.equal(await target.audio.getSyncStateForRecording('__cursor__'), null, 'the cursor must not advance past an interrupted page');
  const reloadedTarget = createAudioRepository(indexedDB, targetName);
  const resumedDownload = await synchronizeAudio({ fetcher: baseDownload, locks: host.locks, repository: reloadedTarget }); assert.equal(resumedDownload.status, 'transferred');
  const received = await reloadedTarget.chunks(recording.id); assert.equal(hash(Buffer.from(await new Blob(received.map(row => row.blob)).arrayBuffer())), hash(bytes));
});

test('Quick Capture note can explicitly authorize private-server text before separate audio upload and download', async t => {
  const note = makeEmptyNote(400, `quick-audio-${++sequence}`), sourceName = `quick-audio-source-${sequence}`, targetName = `quick-audio-target-${sequence}`;
  const sourceNotes = createNotesRepository(indexedDB, sourceName), sourceAudio = createAudioRepository(indexedDB, sourceName);
  await sourceNotes.create(note); await sourceNotes.setSyncPaired(true);
  const host = await server(t, note, { seedNote: false }), sourceDevice = host.device('quick capture owner'), targetDevice = host.device('quick capture second device');
  const authorized = await sourceNotes.authorizePrivateServerAudio(note.id);
  assert.equal(authorized.note.privacy, 'PRIVATE_SERVER'); assert.equal(authorized.textAcknowledged, false);
  const outbox = await sourceNotes.listSyncOutbox(); assert.equal(outbox.length, 1); assert.equal(outbox[0].purpose, 'audio-privacy');
  const textResult = await synchronize({ repository: sourceNotes, fetcher: host.fetcher(sourceDevice.token), locks: host.locks });
  assert.equal(textResult.status, 'synced');
  assert.equal((await sourceNotes.getAudioSyncReadiness(note.id)).textAcknowledged, true);
  const recording = await sourceAudio.create(note.id, { mimeType: 'audio/webm', ownerId: 'synthetic-tab', createdAt: 401 });
  await sourceAudio.appendChunk(recording.id, 0, new Blob(['synthetic quick capture audio']), 900);
  await sourceAudio.setStatus(recording.id, 'complete', { durationMs: 900 });
  await sourceAudio.setSyncApproval(note.id, true);
  assert.equal((await synchronizeAudio({ fetcher: host.fetcher(sourceDevice.token), locks: host.locks, repository: sourceAudio })).status, 'transferred');

  const targetNotes = createNotesRepository(indexedDB, targetName), targetAudio = createAudioRepository(indexedDB, targetName);
  await targetNotes.setSyncPaired(true);
  const pulled = await synchronize({ repository: targetNotes, fetcher: host.fetcher(targetDevice.token), locks: host.locks });
  assert.equal(pulled.pulled, 1); assert.equal((await targetNotes.get(note.id)).privacy, 'PRIVATE_SERVER');
  assert.equal((await targetNotes.getAudioSyncReadiness(note.id)).textAcknowledged, true);
  await targetAudio.setSyncApproval(note.id, true);
  const downloaded = await synchronizeAudio({ fetcher: host.fetcher(targetDevice.token), locks: host.locks, repository: targetAudio });
  assert.equal(downloaded.status, 'transferred');
  const received = await targetAudio.get(recording.id);
  assert.equal(received.noteId, note.id); assert.equal(received.ownerId, 'audio-sync');
  assert.equal((await targetAudio.list(note.id)).length, 1);
});

test('a note with existing local audio can authorize only its text privacy operation without enrolling neighboring notes', async t => {
  const name = `existing-audio-privacy-${++sequence}`, note = makeEmptyNote(450, `existing-audio-${sequence}`), neighbor = makeEmptyNote(451, `neighbor-${sequence}`);
  const notes = createNotesRepository(indexedDB, name), audio = createAudioRepository(indexedDB, name);
  await notes.create(note); await notes.create(neighbor);
  const recording = await audio.create(note.id, { mimeType: 'audio/webm', ownerId: 'synthetic-tab', createdAt: 452 });
  await audio.appendChunk(recording.id, 0, new Blob(['local only']), 100); await audio.setStatus(recording.id, 'complete', { durationMs: 100 });
  await notes.setSyncPaired(true);
  const host = await server(t, note, { seedNote: false }), device = host.device('explicit note privacy');
  const result = await notes.authorizePrivateServerAudio(note.id);
  assert.equal(result.note.id, note.id); assert.deepEqual(result.note.document, note.document); assert.deepEqual(result.note.tags, note.tags); assert.equal(result.note.lifecycle, note.lifecycle);
  const operations = await notes.listSyncOutbox(); assert.equal(operations.length, 1); assert.equal(operations[0].purpose, 'audio-privacy');
  assert.equal((await notes.getAudioSyncReadiness(neighbor.id)).enrolled, false);
  const textSync = await synchronize({ repository: notes, fetcher: host.fetcher(device.token), locks: host.locks });
  assert.equal(textSync.pushed, 1); assert.equal((await notes.getAudioSyncReadiness(note.id)).textAcknowledged, true);
  assert.equal((await audio.list(note.id)).length, 1); assert.equal((await audio.listSyncCandidates()).length, 0);
});

test('audio approval requires an acknowledged matching privacy value and never changes DEVICE_ONLY implicitly', async () => {
  const name = `audio-private-ack-${++sequence}`, note = { ...makeEmptyNote(500, `ack-${sequence}`), privacy: 'DEVICE_ONLY' }, notes = createNotesRepository(indexedDB, name), audio = createAudioRepository(indexedDB, name);
  await notes.create(note);
  await assert.rejects(audio.setSyncApproval(note.id, true), /PRIVATE_SERVER/);
  await assert.rejects(notes.authorizePrivateServerAudio(note.id), /DEVICE_ONLY/);
  assert.equal((await notes.get(note.id)).privacy, 'DEVICE_ONLY');
  await notes.authorizePrivateServerAudio(note.id, { confirmDeviceOnlyChange: true });
  assert.equal((await notes.get(note.id)).privacy, 'PRIVATE_SERVER');
  assert.equal((await notes.listSyncOutbox())[0].purpose, 'audio-privacy');
});

test('server deviceVerified is rechecked against local bytes and restores missing, incomplete, or corrupted recordings', async t => {
  for (const damage of ['all-missing', 'one-missing', 'corrupt']) {
    const fixture = await downloadedFixture(t, `${damage}-${++sequence}`);
    assert.equal((await fixture.target.audio.getSyncStateForRecording(fixture.recording.id)).status, 'verified-here');
    if (damage === 'all-missing') await removeLocalChunks(fixture.targetName, fixture.recording.id);
    else if (damage === 'one-missing') await removeLocalChunks(fixture.targetName, fixture.recording.id, { sequence: 1 });
    else await removeLocalChunks(fixture.targetName, fixture.recording.id, { sequence: 0, corrupt: true });
    const reloaded = createAudioRepository(indexedDB, fixture.targetName);
    const failures = [], baseFetcher = fixture.host.fetcher(fixture.targetDevice.token), recoveryFetcher = async (url, init) => { const response = await baseFetcher(url, init); if (!response.ok) failures.push({ url: String(url), status: response.status, body: await response.clone().text() }); return response; };
    const recovery = await synchronizeAudio({ fetcher: recoveryFetcher, locks: fixture.host.locks, repository: reloaded });
    const storedManifest = fixture.host.db.prepare('SELECT manifest_json FROM sync_recording_media WHERE recording_id=?').get(fixture.recording.id);
    assert.equal(recovery.status, 'transferred', `${damage}: ${JSON.stringify(recovery)} ${JSON.stringify(failures)} serverChunks=${JSON.parse(storedManifest.manifest_json).chunks.length}`);
    const chunks = await reloaded.chunks(fixture.recording.id), restored = new Blob(chunks.map(row => row.blob));
    assert.equal(chunks.length, 2); assert.equal(hash(Buffer.from(await restored.arrayBuffer())), hash(fixture.bytes));
    assert.equal((await reloaded.list(fixture.note.id)).length, 1);
    assert.equal((await reloaded.getSyncStateForRecording(fixture.recording.id)).status, 'verified-here');
  }
});

test('a user-created recording ID collision is preserved for review without overwrite', async t => {
  const fixture = await downloadedFixture(t, `collision-${++sequence}`), id = fixture.recording.id, collisionName = `audio-collision-target-${sequence}`;
  const collision = await localDevice(collisionName, fixture.note), userRecording = { ...(await fixture.recording), ownerId: 'user-created', status: 'complete', chunkCount: 1 };
  const userBytes = new Blob(['different user recording']);
  await putRecording(collisionName, userRecording, [{ id: `${id}:0`, recordingId: id, sequence: 0, blob: userBytes }]);
  await collision.audio.setSyncApproval(fixture.note.id, true);
  const result = await synchronizeAudio({ fetcher: fixture.host.fetcher(fixture.targetDevice.token), locks: fixture.host.locks, repository: collision.audio });
  assert.equal(result.status, 'transferred');
  assert.equal((await collision.audio.get(id)).ownerId, 'user-created');
  assert.equal((await collision.audio.chunks(id))[0].blob.size, userBytes.size);
  assert.equal((await collision.audio.getSyncStateForRecording(id)).status, 'needs-review');
});

test('a verified recording with metadata changes requires review and keeps local bookmarks', async t => {
  const fixture = await downloadedFixture(t, `metadata-change-${++sequence}`), id = fixture.recording.id;
  await fixture.target.audio.addAnchor(id, { id: `local-anchor-${sequence}`, recordingId: id, offsetMs: 250, label: 'Local bookmark', createdAt: 510 });
  const metadataRequest = new Request(new URL('/api/v1/sync/media/metadata', origin), { method: 'POST', headers: { host: '127.0.0.1:15700', cookie: `noteos_sync_local=${fixture.sourceDevice.token}`, origin, 'content-type': 'application/json', 'x-noteos-sync': '1' }, body: JSON.stringify({ recordingId: id, baseServerVersion: 1, anchors: { version: 1, items: [] }, recordingMetadata: { title: 'Remote renamed audio', updatedAt: 500 } }) });
  const updated = await handleAudioSync(metadataRequest, 'media/metadata', { NOTEOS_SYNC_ENABLED: '1', NOTEOS_AUDIO_SYNC_ENABLED: '1', NOTEOS_SYNC_STORAGE: fixture.host.root, NOTEOS_SYNC_ALLOWED_ORIGINS: origin });
  assert.equal(updated.status, 200);
  const before = await fixture.target.audio.get(id), result = await synchronizeAudio({ fetcher: fixture.host.fetcher(fixture.targetDevice.token), locks: fixture.host.locks, repository: fixture.target.audio });
  assert.equal(result.status, 'transferred');
  assert.equal((await fixture.target.audio.get(id)).title, before.title);
  assert.equal((await fixture.target.audio.get(id)).audioAnchors.items[0].label, 'Local bookmark');
  let state = await fixture.target.audio.getSyncStateForRecording(id); assert.equal(state.status, 'needs-review');
  await fixture.target.audio.applyRemoteAudioMetadata(id, state.conflict.remote);
  await fixture.target.audio.putSyncState({ ...state, status: 'saved-local', conflict: null, serverVersion: state.conflict.serverVersion, transferId: randomUUID(), lastMetadataHash: undefined });
  const resolved = await synchronizeAudio({ fetcher: fixture.host.fetcher(fixture.targetDevice.token), locks: fixture.host.locks, repository: fixture.target.audio });
  assert.equal(resolved.status, 'transferred');
  const serverManifest = JSON.parse(fixture.host.db.prepare('SELECT manifest_json FROM sync_recording_media WHERE recording_id=?').get(id).manifest_json);
  assert.ok(serverManifest.anchors.items.some(anchor => anchor.label === 'Local bookmark'));
  state = await fixture.target.audio.getSyncStateForRecording(id); assert.equal(state.status, 'verified-here');
});

test('applying remote metadata keeps local bookmarks and retains conflicting remote bookmarks as separate entries', async t => {
  const fixture = await downloadedFixture(t, `anchor-merge-${++sequence}`), id = fixture.recording.id;
  await fixture.target.audio.addAnchor(id, { id: 'shared-anchor', recordingId: id, offsetMs: 100, label: 'Local bookmark', createdAt: 610 });
  const current = await fixture.target.audio.get(id);
  const updated = await fixture.target.audio.applyRemoteAudioMetadata(id, { recording: { ...current, title: 'Remote title', updatedAt: 611 }, anchors: { version: 1, items: [{ id: 'shared-anchor', recordingId: id, offsetMs: 200, label: 'Remote bookmark', createdAt: 612 }] } });
  assert.equal(updated.title, 'Remote title'); assert.equal(updated.audioAnchors.items.length, 2);
  assert.ok(updated.audioAnchors.items.some(anchor => anchor.label === 'Local bookmark' && anchor.offsetMs === 100));
  assert.ok(updated.audioAnchors.items.some(anchor => anchor.label === 'Remote bookmark' && anchor.offsetMs === 200));
});

test('audio change pages advance only after complete processing and cover more than 100 changes', async () => {
  const saved = new Map(), cursors = [];
  const repository = { listSyncApprovals: async () => [], listSyncCandidates: async () => [], getSyncStateForRecording: async id => saved.get(id) ?? null, putSyncState: async state => saved.set(state.recordingId, state), getSyncApproval: async () => null };
  const fetcher = async (url, init) => {
    if (String(url).endsWith('/media/status')) return Response.json({ serverEpoch: 'epoch-a' });
    const { cursor } = JSON.parse(init.body); cursors.push(cursor);
    const nextCursor = Math.min(cursor + 100, 205);
    return Response.json({ serverEpoch: 'epoch-a', changes: [], nextCursor, hasMore: nextCursor < 205 });
  };
  const result = await synchronizeAudio({ fetcher, locks: { request: async (_name, _options, callback) => callback({}) }, repository });
  assert.equal(result.status, 'idle'); assert.deepEqual(cursors, [0, 100, 200]);
  assert.equal(saved.get('__cursor__').audioCursor, 205);
});

test('unexpected audio server epoch restarts paging at zero without advancing the stale cursor', async () => {
  const saved = new Map([['__cursor__', { recordingId: '__cursor__', audioEpoch: 'epoch-a', audioCursor: 48 }]]), cursors = [];
  const repository = { listSyncApprovals: async () => [], listSyncCandidates: async () => [], getSyncStateForRecording: async id => saved.get(id) ?? null, putSyncState: async state => saved.set(state.recordingId, state), getSyncApproval: async () => null };
  let requested = 0;
  const fetcher = async (url, init) => {
    if (String(url).endsWith('/media/status')) return Response.json({ serverEpoch: 'epoch-a' });
    const { cursor } = JSON.parse(init.body); cursors.push(cursor);
    requested++;
    if (requested === 1) return Response.json({ error: 'cursor_ahead', serverEpoch: 'epoch-b', serverCursor: 3 }, { status: 409 });
    return Response.json({ serverEpoch: 'epoch-b', changes: [], nextCursor: 3, hasMore: false });
  };
  const result = await synchronizeAudio({ fetcher, locks: { request: async (_name, _options, callback) => callback({}) }, repository });
  assert.deepEqual(cursors, [48, 0], JSON.stringify(result)); assert.equal(saved.get('__cursor__').audioCursor, 3); assert.equal(saved.get('__cursor__').audioEpoch, 'epoch-b');
});

test('a verified intact recording is rehashed after repository reload and does not duplicate media', async t => {
  const fixture = await downloadedFixture(t, `intact-reload-${++sequence}`), repository = createAudioRepository(indexedDB, fixture.targetName);
  let verifyCalls = 0; const baseFetcher = fixture.host.fetcher(fixture.targetDevice.token);
  const fetcher = async (url, init) => { if (String(url).endsWith('/media/verify')) verifyCalls++; return baseFetcher(url, init); };
  const result = await synchronizeAudio({ fetcher, locks: fixture.host.locks, repository });
  assert.equal(result.status, 'transferred'); assert.equal(verifyCalls, 1);
  assert.equal((await repository.list(fixture.note.id)).length, 1);
  assert.equal(hash(Buffer.from(await new Blob((await repository.chunks(fixture.recording.id)).map(row => row.blob)).arrayBuffer())), hash(fixture.bytes));
});

test('a disconnect midway through verified-device recovery resumes without replacing good server bytes', async t => {
  const fixture = await downloadedFixture(t, `recovery-interrupt-${++sequence}`), id = fixture.recording.id;
  await removeLocalChunks(fixture.targetName, id);
  const baseFetcher = fixture.host.fetcher(fixture.targetDevice.token); let interrupted = false;
  const fetcher = async (url, init) => {
    if (!interrupted && String(url).endsWith('/chunks/1') && String(url).includes('/downloads/')) { interrupted = true; throw new TypeError('synthetic disconnect during recovery'); }
    return baseFetcher(url, init);
  };
  const partial = await synchronizeAudio({ fetcher, locks: fixture.host.locks, repository: createAudioRepository(indexedDB, fixture.targetName) });
  assert.equal(partial.status, 'waiting-connection');
  const pending = await fixture.target.audio.getSyncStateForRecording(id); assert.equal(pending.status, 'downloading'); assert.equal(pending.verifiedBytes, 1024 * 1024);
  const manifestBefore = JSON.parse(fixture.host.db.prepare('SELECT manifest_json FROM sync_recording_media WHERE recording_id=?').get(id).manifest_json);
  assert.equal(manifestBefore.totalBytes, fixture.bytes.length); assert.equal(manifestBefore.chunks.length, 2);
  const resumed = await synchronizeAudio({ fetcher: baseFetcher, locks: fixture.host.locks, repository: createAudioRepository(indexedDB, fixture.targetName) });
  assert.equal(resumed.status, 'transferred');
  const chunks = await fixture.target.audio.chunks(id); assert.equal(chunks.length, 2);
  assert.equal(hash(Buffer.from(await new Blob(chunks.map(row => row.blob)).arrayBuffer())), hash(fixture.bytes));
});
