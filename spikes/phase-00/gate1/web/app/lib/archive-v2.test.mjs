import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { createNotesRepository, createAudioRepository, makeEmptyNote } from './local-notes.js';
import { exportArchive, verifyArchive, restoreBackup, sha256Blob } from './archive-v2.mjs';
import { createTar, readTar, ARCHIVE_LIMITS } from './archive-tar.mjs';
import { makeBackup } from './mvp-utils.mjs';
import { validateCanonicalDocument } from '../../packages/document-engine/src/index.js';

let serial = 0;
const repository = () => { const name = `archive-v2-${++serial}`; return { name, notes: createNotesRepository(indexedDB, name), audio: createAudioRepository(indexedDB, name) }; };
const json = (value) => new Blob([JSON.stringify(value)], { type: 'application/json' });
const digest = async (blob) => createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
async function fixture() {
  const result = repository();
  for (const [index, lifecycle] of ['active', 'archived', 'trashed'].entries()) {
    const note = { ...makeEmptyNote(100, `n-${index}`), title: 'Ghi chú — 東京 ☕', tags: ['Tiếng Việt', '日本語'], pinned: true };
    await result.notes.create(note);
    if (lifecycle !== 'active') await result.notes.setLifecycle(note.id, lifecycle, 0);
  }
  for (const [index, status] of ['complete', 'interrupted'].entries()) {
    const recording = await result.audio.create('n-0', { mimeType: 'audio/webm;codecs=opus', ownerId: 'synthetic', createdAt: 100 });
    await result.audio.rename(recording.id, `Âm thanh 日本語 ${index}`);
    await result.audio.appendChunk(recording.id, 0, new Blob([new Uint8Array([0, 1, 255, index])], { type: recording.mimeType }), 1000);
    await result.audio.appendChunk(recording.id, 1, new Blob(['ghi âm 東京'], { type: recording.mimeType }), 2000);
    await result.audio.setStatus(recording.id, status);
  }
  return result;
}
async function archive(source) { return (await exportArchive(source.notes, { exportedAt: '2026-10-22T00:00:00.000Z' })).blob; }
async function rewrite(blob, mutate, repair = true) {
  const entries = await readTar(blob); const manifest = JSON.parse(await entries.get('manifest.json').text());
  await mutate(entries, manifest);
  if (repair) {
    for (const file of manifest.files) if (entries.has(file.path)) { file.byteLength = entries.get(file.path).size; file.sha256 = await sha256Blob(entries.get(file.path)); }
    entries.set('manifest.json', json(manifest)); entries.set('manifest.sha256', new Blob([await sha256Blob(entries.get('manifest.json'))]));
  }
  return createTar([...entries].map(([path, blob]) => ({ path, blob })));
}
async function assertUnchanged(source, before) {
  const after = await source.notes.snapshotArchive();
  assert.deepEqual(after.notes, before.notes); assert.deepEqual(after.recordings, before.recordings);
  assert.deepEqual(await Promise.all(after.chunks.map(async c => [c.id, c.sequence, c.blob.type, await digest(c.blob)])), await Promise.all(before.chunks.map(async c => [c.id, c.sequence, c.blob.type, await digest(c.blob)])));
}

test('notes plus two recordings round trip preserves Unicode, lifecycle, revisions, metadata and exact chunk SHA-256', async () => {
  const source = await fixture(), before = await source.notes.snapshotArchive(), target = repository();
  const result = await restoreBackup(await archive(source), target.notes, 'skip');
  assert.equal(result.importedNotes, 3); assert.equal(result.importedRecordings, 2);
  await assertUnchanged(target, before);
  assert.equal(await sha256Blob(before.chunks[0].blob), await digest(before.chunks[0].blob));
  await assertUnchanged(source, before);
});
test('fixed timestamp exports are deterministic and do not modify revisions, metadata or partial status', async () => {
  const source = await fixture(), before = await source.notes.snapshotArchive();
  assert.equal(await digest(await archive(source)), await digest(await archive(source)));
  await assertUnchanged(source, before);
});
test('one corrupt audio byte rejects verification before opening an import write transaction', async () => {
  const source = await fixture(), target = repository();
  await target.notes.create(makeEmptyNote(100, 'existing'));
  const before = await target.notes.snapshotArchive();
  const corrupted = await rewrite(await archive(source), entries => { const path = [...entries.keys()].find(p => p.startsWith('blobs/')); entries.set(path, new Blob(['X', entries.get(path).slice(1)])); }, false);
  let writes = 0; const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(stores, mode, ...args) { if (mode === 'readwrite') writes++; return transaction.call(this, stores, mode, ...args); };
  try { await assert.rejects(restoreBackup(corrupted, target.notes), /checksum/); assert.equal(writes, 0); } finally { IDBDatabase.prototype.transaction = transaction; }
  await assertUnchanged(target, before);
});
test('missing audio entry is rejected', async () => {
  const source = await fixture();
  const blob = await rewrite(await archive(source), entries => entries.delete([...entries.keys()].find(p => p.startsWith('blobs/'))), false);
  await assert.rejects(verifyArchive(blob), /Missing archive entry/);
});
test('truncated/corrupted manifest and truncated TAR are rejected', async () => {
  const blob = await archive(await fixture());
  await assert.rejects(verifyArchive(blob.slice(0, blob.size - 1)), /Truncated/);
  await assert.rejects(verifyArchive(await rewrite(blob, entries => entries.set('manifest.json', new Blob(['{broken'])), false)), /Manifest checksum/);
});
test('Skip collision aborts all notes and audio; Merge retains existing revisions/audio and imports new groups only', async () => {
  const source = await fixture(), target = repository(), blob = await archive(source);
  await target.notes.create({ ...makeEmptyNote(1, 'n-0'), title: 'Existing must survive', revision: 44 });
  const r = await target.audio.create('n-0', { mimeType: 'audio/webm', ownerId: 'target' });
  await target.audio.appendChunk(r.id, 0, new Blob(['existing audio'], { type: 'audio/webm' }), 4); await target.audio.setStatus(r.id, 'complete');
  const before = await target.notes.snapshotArchive();
  await assert.rejects(restoreBackup(blob, target.notes, 'skip'), /entire import/); await assertUnchanged(target, before);
  const result = await restoreBackup(blob, target.notes, 'merge');
  assert.equal(result.importedNotes, 2); assert.equal(result.skippedNotes, 1); assert.equal(result.importedRecordings, 0); assert.equal(result.skippedRecordings, 2);
  assert.deepEqual(await target.notes.get('n-0'), before.notes[0]); assert.equal(await digest((await target.audio.chunks(r.id))[0].blob), await digest(before.chunks[0].blob));
});
test('repeated merge import creates no duplicate audio; repeated Skip imports nothing', async () => {
  const source = await fixture(), target = repository(), blob = await archive(source);
  await restoreBackup(blob, target.notes); const before = await target.notes.snapshotArchive();
  const result = await restoreBackup(blob, target.notes); assert.equal(result.importedRecordings, 0); assert.equal(result.importedNotes, 0);
  await assert.rejects(restoreBackup(blob, target.notes, 'skip')); await assertUnchanged(target, before);
});
for (const state of ['recording', 'paused']) test(`active ${state} blocks export without recovery or chunk mutations`, async () => {
  const source = repository(); await source.notes.create(makeEmptyNote(1, 'live'));
  const r = await source.audio.create('live', { mimeType: 'audio/webm', ownerId: 'active-owner' });
  await source.audio.appendChunk(r.id, 0, new Blob(['live'], { type: 'audio/webm' }), 1);
  if (state === 'paused') await source.audio.setStatus(r.id, 'paused');
  const before = await source.notes.snapshotArchive(); await assert.rejects(archive(source), /Stop\/finalize/); await assertUnchanged(source, before);
});
test('quota failure after queued note/audio writes aborts atomically and preserves existing data', async () => {
  const source = await fixture(), target = repository(), verified = await verifyArchive(await archive(source));
  await target.notes.create(makeEmptyNote(1, 'existing')); const before = await target.notes.snapshotArchive();
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function(value, ...args) { if (this.name === 'recordingChunks') throw new DOMException('Synthetic quota', 'QuotaExceededError'); return add.call(this, value, ...args); };
  try { await assert.rejects(target.notes.importArchive(verified), { name: 'QuotaExceededError' }); } finally { IDBObjectStore.prototype.add = add; }
  await assertUnchanged(target, before);
});
test('asynchronous transaction abort also rolls back previously queued stores', async () => {
  const source = await fixture(), target = repository(), verified = await verifyArchive(await archive(source));
  await target.notes.create(makeEmptyNote(1, 'existing')); const before = await target.notes.snapshotArchive();
  const add = IDBObjectStore.prototype.add; let injected = false;
  IDBObjectStore.prototype.add = function(value, ...args) { const result = add.call(this, value, ...args); if (this.name === 'recordingChunks' && !injected) { injected = true; add.call(this, value, ...args); } return result; };
  try { await assert.rejects(target.notes.importArchive(verified)); } finally { IDBObjectStore.prototype.add = add; }
  await assertUnchanged(target, before);
});
test('Legacy V1 restore remains notes-only with previous collision semantics', async () => {
  const target = repository(), note = makeEmptyNote(100, 'v1');
  assert.equal((await restoreBackup(json(makeBackup([note])), target.notes)).importedNotes, 1);
  assert.equal((await restoreBackup(json(makeBackup([note])), target.notes)).skippedNotes, 1);
  await assert.rejects(restoreBackup(json(makeBackup([note])), target.notes, 'skip'));
});
test('future canonical schema and additional validated recording metadata survive V2 unchanged', async () => {
  const source = await fixture(), target = repository();
  const future = { ...makeEmptyNote(100, 'future'), schemaVersion: 99, document: { schemaVersion: 99, type: 'doc', content: [], futureData: { preserved: '日本語' } } };
  await source.notes.importNotes([future]);
  const blob = await rewrite(await archive(source), async entries => { const rows = JSON.parse(await entries.get('recordings.json').text()); rows[0].recording.extensions = { futureValidatedMetadata: { label: '東京' } }; entries.set('recordings.json', json(rows)); });
  const snapshot = await verifyArchive(blob);
  const preserved = snapshot.notes.find(n => n.id === 'future'); assert.equal(validateCanonicalDocument(preserved.document).status, 'unsupported');
  await target.notes.importArchive(snapshot); assert.deepEqual(await target.notes.get('future'), future); assert.deepEqual((await target.audio.get(snapshot.recordings[0].id)).extensions, snapshot.recordings[0].extensions);
  await assert.rejects(target.notes.save('future', { title: 'bad', document: future.document }, 0));
});
test('duplicate note/recording IDs, relationships, chunk gaps and MIME/path inconsistencies are rejected after checksums', async () => {
  const original = await archive(await fixture());
  for (const mutation of [
    (notes, rows) => notes.push(notes[0]),
    (notes, rows) => rows.push(rows[0]),
    (notes, rows) => { rows[0].recording.noteId = 'missing'; },
    (notes, rows) => { rows[0].chunks[1].sequence = 3; },
    (notes, rows) => { rows[0].chunks[0].byteLength++; },
    (notes, rows) => { rows[0].recording.mimeType = 'text/html'; },
    (notes, rows) => { rows[0].recording.mimeType = 'audio/mp4'; },
    (notes, rows) => { rows[0].recording.chunkCount++; },
    (notes, rows) => { rows[0].recording.status = 'recording'; },
  ]) {
    const mutated = await rewrite(original, async entries => { const notes = JSON.parse(await entries.get('notes.json').text()), rows = JSON.parse(await entries.get('recordings.json').text()); mutation(notes, rows); entries.set('notes.json', json(notes)); entries.set('recordings.json', json(rows)); });
    await assert.rejects(verifyArchive(mutated));
  }
});
test('failed empty recordings retain metadata and explicit warning; complete empty recordings are rejected', async () => {
  const source = repository(); await source.notes.create(makeEmptyNote(1, 'empty'));
  const r = await source.audio.create('empty', { mimeType: 'audio/webm', ownerId: 'tab' }); await source.audio.setStatus(r.id, 'failed');
  const result = await exportArchive(source.notes); assert.equal(result.manifest.warnings.length, 1);
  const restored = await verifyArchive(result.blob); assert.equal(restored.recordings[0].status, 'failed'); assert.equal(restored.chunks.length, 0);
  const snapshot = await source.notes.snapshotArchive(); snapshot.recordings[0].status = 'complete';
  await assert.rejects(exportArchive({ snapshotArchive: async () => snapshot }), /ordering\/count/);
});
function changeHeader(blob, edit) { return blob.slice(0, 512).arrayBuffer().then(buffer => { const h = new Uint8Array(buffer); edit(h); h.fill(32, 148, 156); const sum = h.reduce((s,b) => s+b,0).toString(8).padStart(6,'0')+'\0 '; h.set(new TextEncoder().encode(sum),148); return new Blob([h, blob.slice(512)]); }); }
test('malicious path, unsupported TAR links, excessive advertised size and duplicate entries reject', async () => {
  const small = createTar([{ path: 'notes.json', blob: json([]) }]);
  await assert.rejects(readTar(await changeHeader(small, h => { h.fill(0,0,100); h.set(new TextEncoder().encode('../evil'),0); })), /Unsafe/);
  await assert.rejects(readTar(await changeHeader(small, h => { h[156] = 50; })), /Unsupported/);
  await assert.rejects(readTar(await changeHeader(small, h => { h.set(new TextEncoder().encode((600*1024**2).toString(8).padStart(11,'0')+'\0'),124); })), /size limit/);
  const body = small.slice(0,small.size-1024);
  await assert.rejects(readTar(new Blob([body,body,new Uint8Array(1024)])), /Duplicate/);
  await assert.rejects(readTar(small, { ...ARCHIVE_LIMITS, maxEntries: 0 }), /too many/);
  await assert.rejects(readTar(small, { ...ARCHIVE_LIMITS, maxArchiveBytes: 1 }), /excessive/);
});
test('recording ID conflict skips the entire incoming note group in Merge and rejects Skip', async () => {
  const source = await fixture(), target = repository(), incoming = await verifyArchive(await archive(source));
  await target.notes.create(makeEmptyNote(1, 'other'));
  const db = await new Promise(resolve => { const r=indexedDB.open(target.name); r.onsuccess=()=>resolve(r.result); });
  await new Promise((resolve,reject) => { const tx=db.transaction('recordings','readwrite'); tx.objectStore('recordings').add({ ...incoming.recordings[0], noteId:'other' }); tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error); }); db.close();
  await assert.rejects(target.notes.importArchive(incoming,'skip'));
  const result = await target.notes.importArchive(incoming,'merge'); assert.equal(result.skippedNotes,1); assert.equal(result.skippedRecordings,2); assert.equal(await target.notes.get('n-0'),null);
});
test('storage snapshot serializes against concurrent mutations and never invokes recovery', async () => {
  const source=await fixture(); const before=await source.notes.snapshotArchive();
  const [snapshot] = await Promise.all([source.notes.snapshotArchive(), source.notes.setLifecycle('n-0','archived',0)]);
  assert.equal(snapshot.notes.find(n=>n.id==='n-0').lifecycle,'active');
  assert.deepEqual(snapshot.recordings,before.recordings);
});
test('unverified import objects cannot open the write transaction', async () => {
  const target=repository(); await assert.rejects(target.notes.importArchive({notes:[],recordings:[],chunks:[]}),/Verify/);
});
test('incremental hash agrees with Node SHA-256 across the 1 MiB read boundary, including empty files', async () => {
  const blob = new Blob([new Uint8Array(2 * 1024 ** 2), 'boundary-東京']);
  assert.equal(await sha256Blob(blob), await digest(blob));
  assert.equal(await sha256Blob(new Blob([])), await digest(new Blob([])));
});
