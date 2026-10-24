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
import { openStore, transaction, appendChange } from '../../sync-server/storage.mjs';
import { issuePairingCode, redeemPairingCode } from '../../sync-server/auth.mjs';
import { handleAudioSync } from '../../sync-server/media-http.mjs';
import { canonicalJson } from './sync-protocol.mjs';

const origin = 'http://127.0.0.1:15700'; let sequence = 0;
process.chdir(fileURLToPath(new URL('../..', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function localDevice(name, note) {
  const notes = createNotesRepository(indexedDB, name), audio = createAudioRepository(indexedDB, name);
  await notes.create(note);
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const tx = db.transaction('syncBaselines', 'readwrite'); tx.objectStore('syncBaselines').put({ id: note.id, serverVersion: 1, localRevision: note.revision, contentHash: 'synthetic' });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); }); db.close();
  return { notes, audio };
}
async function server(t, note) {
  const root = mkdtempSync(join(tmpdir(), 'noteos-audio-client-')), db = openStore(root, { initialize: true });
  const env = { NOTEOS_SYNC_ENABLED: '1', NOTEOS_AUDIO_SYNC_ENABLED: '1', NOTEOS_SYNC_STORAGE: root, NOTEOS_SYNC_ALLOWED_ORIGINS: origin };
  transaction(db, () => { const cursor = appendChange(db, 'note', note.id, 1, 'upsert', canonicalJson(note)); db.prepare("INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES('note',?,1,?,'synthetic','active',0,?)").run(note.id, canonicalJson(note), cursor); });
  t.after(() => { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  const device = label => redeemPairingCode(db, issuePairingCode(db), label);
  const fetcher = token => async (url, init = {}) => {
    const headers = new Headers(init.headers); headers.set('host', '127.0.0.1:15700'); headers.set('cookie', `noteos_sync_local=${token}`);
    if (init.method !== 'GET') headers.set('origin', origin);
    const request = new Request(new URL(url, origin), { ...init, headers });
    return handleAudioSync(request, new URL(request.url).pathname.split('/api/v1/sync/')[1], env);
  };
  const locks = { request: async (_name, _options, callback) => callback({ name: 'synthetic-lock' }) };
  return { root, db, device, fetcher, locks };
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
  const reloadedTarget = createAudioRepository(indexedDB, targetName);
  const resumedDownload = await synchronizeAudio({ fetcher: baseDownload, locks: host.locks, repository: reloadedTarget }); assert.equal(resumedDownload.status, 'transferred');
  const received = await reloadedTarget.chunks(recording.id); assert.equal(hash(Buffer.from(await new Blob(received.map(row => row.blob)).arrayBuffer())), hash(bytes));
});
