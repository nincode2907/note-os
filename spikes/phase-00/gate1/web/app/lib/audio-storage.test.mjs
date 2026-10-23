import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createAudioRepository, createNotesRepository, makeEmptyNote, NoteStateError } from './local-notes.js';

let sequence = 0;
const name = () => `noteos-mvp02-audio-${++sequence}`;
const fixture = (id) => ({ ...makeEmptyNote(100, id), title: `Note ${id}` });

async function createLegacyV1(databaseName) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const notes = request.result.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('lifecycle', 'lifecycle'); notes.createIndex('updatedAt', 'updatedAt');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result, tx = database.transaction('notes', 'readwrite');
      tx.objectStore('notes').add(fixture('old-v1'));
      tx.oncomplete = () => { database.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

test('v1 note database upgrades additively and preserves existing note bytes', async () => {
  const databaseName = name(); await createLegacyV1(databaseName);
  const notes = createNotesRepository(indexedDB, databaseName), audio = createAudioRepository(indexedDB, databaseName);
  const before = await notes.get('old-v1');
  const created = await audio.create('old-v1', { mimeType: 'audio/webm', ownerId: 'tab-1', createdAt: 123 });
  const database = await new Promise((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  assert.equal(database.version, 3); assert.ok(database.objectStoreNames.contains('notes')); assert.ok(database.objectStoreNames.contains('recordings')); assert.ok(database.objectStoreNames.contains('recordingChunks'));
  for (const store of ['syncOutbox','syncBaselines','syncState','syncConflicts','syncEnrollment']) assert.ok(database.objectStoreNames.contains(store));
  database.close(); assert.deepEqual(await notes.get('old-v1'), before); assert.equal(created.noteId, 'old-v1');
});

test('chunks remain ordered, linked to the right note, and reload as playable blobs', async () => {
  const databaseName = name(), notes = createNotesRepository(indexedDB, databaseName), audio = createAudioRepository(indexedDB, databaseName);
  const first = await notes.create(fixture('first')), second = await notes.create(fixture('second'));
  const recording = await audio.create(first.id, { mimeType: 'audio/webm', ownerId: 'tab-2' });
  await audio.appendChunk(recording.id, 0, new Blob(['hello '], { type: recording.mimeType }), 1000);
  await audio.appendChunk(recording.id, 1, new Blob(['audio'], { type: recording.mimeType }), 2000);
  const loaded = await createAudioRepository(indexedDB, databaseName).get(recording.id);
  const rows = await createAudioRepository(indexedDB, databaseName).chunks(recording.id);
  assert.equal(loaded.chunkCount, 2); assert.equal(loaded.durationMs, 2000); assert.deepEqual(rows.map((row) => row.sequence), [0, 1]);
  assert.equal(await (new Blob(rows.map((row) => row.blob))).text(), 'hello audio');
  assert.equal((await audio.list(first.id)).length, 1); assert.equal((await audio.list(second.id)).length, 0);
  await audio.setStatus(recording.id, 'complete', { durationMs: 2100 });
  assert.equal((await audio.get(recording.id)).status, 'complete');
  await assert.rejects(audio.appendChunk(recording.id, 2, new Blob(['late']), 3000), NoteStateError);
});

test('one active session per note, pause/resume transitions, and reload recovery are explicit', async () => {
  const databaseName = name(), notes = createNotesRepository(indexedDB, databaseName), audio = createAudioRepository(indexedDB, databaseName);
  const note = await notes.create(fixture('active'));
  const recording = await audio.create(note.id, { mimeType: 'audio/webm', ownerId: 'same-tab' });
  await assert.rejects(audio.create(note.id, { mimeType: 'audio/webm', ownerId: 'other-tab' }), NoteStateError);
  await audio.setStatus(recording.id, 'paused'); await audio.setStatus(recording.id, 'recording');
  await audio.appendChunk(recording.id, 0, new Blob(['partial']), 500);
  const recovered = await createAudioRepository(indexedDB, databaseName).recover(recording.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal((await audio.get(recording.id)).status, 'interrupted');
  assert.equal((await audio.chunks(recording.id)).length, 1);
  assert.equal(await audio.recover(recording.id), null);
});

test('timestamps alone never recover recording or paused sessions', async () => {
  const databaseName = name(), notes = createNotesRepository(indexedDB, databaseName), audio = createAudioRepository(indexedDB, databaseName);
  const oldNote = await notes.create(fixture('stale'));
  const stale = await audio.create(oldNote.id, { mimeType: 'audio/webm', ownerId: 'copied-token', createdAt: 100 });
  await audio.setStatus(stale.id, 'paused');
  assert.equal((await audio.get(stale.id)).status, 'paused');
  assert.deepEqual(await audio.listUnfinished().then((rows) => rows.map((row) => row.id)), [stale.id]);
  assert.equal((await audio.chunks(stale.id)).length, 0);
});

test('active recording blocks cross-tab recording and destructive deletion races', async () => {
  const databaseName = name(), notes = createNotesRepository(indexedDB, databaseName), audio = createAudioRepository(indexedDB, databaseName);
  const otherTabNotes = createNotesRepository(indexedDB, databaseName), otherTabAudio = createAudioRepository(indexedDB, databaseName);
  const note = await notes.create(fixture('live-delete'));
  const recording = await audio.create(note.id, { mimeType: 'audio/webm', ownerId: 'same-copied-session-id' });
  await audio.appendChunk(recording.id, 0, new Blob(['committed']), 1000);
  const trashed = await notes.setLifecycle(note.id, 'trashed', note.revision);
  await assert.rejects(otherTabAudio.create(note.id, { mimeType: 'audio/webm', ownerId: 'same-copied-session-id' }), NoteStateError);
  await assert.rejects(otherTabAudio.remove(recording.id), NoteStateError);
  await assert.rejects(otherTabNotes.deleteForever(note.id, trashed.revision), NoteStateError);
  assert.equal((await audio.get(recording.id)).status, 'recording');
  assert.equal(await (await audio.chunks(recording.id))[0].blob.text(), 'committed');
});

test('archive and trash keep media; confirmed permanent note delete cascades atomically to recordings and chunks', async () => {
  const databaseName = name(), notes = createNotesRepository(indexedDB, databaseName), audio = createAudioRepository(indexedDB, databaseName);
  const note = await notes.create(fixture('cascade'));
  const recording = await audio.create(note.id, { mimeType: 'audio/webm', ownerId: 'tab-3' });
  await audio.appendChunk(recording.id, 0, new Blob(['data']), 1000); await audio.setStatus(recording.id, 'complete');
  const archived = await notes.setLifecycle(note.id, 'archived', note.revision);
  assert.equal((await audio.list(note.id)).length, 1);
  const trashed = await notes.setLifecycle(note.id, 'trashed', archived.revision);
  assert.equal((await audio.list(note.id)).length, 1);
  await notes.deleteForever(note.id, trashed.revision);
  assert.deepEqual(await audio.list(note.id), []); assert.equal(await audio.get(recording.id), null); assert.deepEqual(await audio.chunks(recording.id), []);
});

test('chunk transaction failure keeps existing chunks and metadata visible as partial', async () => {
  const databaseName = name(), notes = createNotesRepository(indexedDB, databaseName), audio = createAudioRepository(indexedDB, databaseName);
  const note = await notes.create(fixture('write-fail')), recording = await audio.create(note.id, { mimeType: 'audio/webm', ownerId: 'tab-4' });
  await audio.appendChunk(recording.id, 0, new Blob(['safe']), 1000);
  await assert.rejects(audio.appendChunk(recording.id, 0, new Blob(['duplicate']), 2000));
  await audio.setStatus(recording.id, 'failed');
  assert.equal((await audio.get(recording.id)).status, 'failed');
  const rows = await audio.chunks(recording.id); assert.equal(rows.length, 1); assert.equal(await rows[0].blob.text(), 'safe');
});
