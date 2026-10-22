import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { validateCanonicalDocument } from '../../packages/document-engine/src/index.js';
import { exportArchive, verifyArchive } from './archive-v2.mjs';
import { createAudioRepository, createNotesRepository } from './local-notes.js';
import {
  captureSnapshotIsCurrent,
  commitQuickCaptureSnapshot,
  deriveQuickCaptureTitle,
  makeQuickCaptureNote,
  makeQuickVoiceNote,
  normalizeQuickCaptureInput,
  QuickCaptureSaveGate,
} from './quick-capture.mjs';

let sequence = 0;
const repository = () => createNotesRepository(globalThis.indexedDB, `quick-capture-${++sequence}`);

test('Quick Capture creates valid canonical v1 notes and preserves Vietnamese, Japanese, English and interior newlines', () => {
  const text = '   Gặp khách hàng chiều nay\n\n東京でメモを確認する\nExpo SDK 57 + SQLite   ';
  const note = makeQuickCaptureNote(text, { id: 'quick-1', now: 123 });
  assert.equal(note.title, 'Gặp khách hàng chiều nay');
  assert.equal(note.document.schemaVersion, 1);
  assert.equal(note.document.content.map((block) => block.content?.[0]?.text ?? '').join('\n'), normalizeQuickCaptureInput(text));
  assert.equal(validateCanonicalDocument(note.document).status, 'supported');
  assert.equal(note.revision, 0);
});

test('title derivation is conservative and does not destroy the body; blank captures create no note', () => {
  const text = '\n  title  with spacing  \nbody\n  preserved  ';
  assert.equal(deriveQuickCaptureTitle(text), 'title with spacing');
  assert.deepEqual(makeQuickCaptureNote(text, { id: 'quick-2' }).document.content.map((line) => line.content?.[0]?.text ?? ''), ['title  with spacing  ', 'body', '  preserved']);
  assert.equal(makeQuickCaptureNote(' \n\t '), null);
});

test('one capture save gate suppresses double taps while independent captures get separate IDs', async () => {
  const gate = new QuickCaptureSaveGate();
  assert.equal(gate.begin(), true);
  assert.equal(gate.begin(), false);
  gate.finish();
  assert.equal(gate.begin(), true);
  const first = makeQuickCaptureNote('one', { id: 'one' });
  const second = makeQuickCaptureNote('two', { id: 'two' });
  const repo = repository();
  await repo.createIfMissing(first);
  await repo.createIfMissing(second);
  assert.deepEqual((await repo.list()).map((note) => note.id).sort(), ['one', 'two']);
});

test('the same durable capture ID retries idempotently and rejects a different payload', async () => {
  const repo = repository();
  const note = makeQuickCaptureNote('persist once', { id: 'retry-id', now: 456 });
  await repo.createIfMissing(note);
  await repo.createIfMissing(note);
  assert.equal((await repo.list()).length, 1);
  await assert.rejects(repo.createIfMissing(makeQuickCaptureNote('changed', { id: note.id, now: note.createdAt })), /changed in another tab/);
});

test('failed persistence or note commit leaves the capture checkpoint intact for retry', async () => {
  const snapshot = { text: 'keep me', sequence: 4, note: makeQuickCaptureNote('keep me', { id: 'retry' }) };
  const calls = [];
  await assert.rejects(commitQuickCaptureSnapshot({
    snapshot,
    persist: async () => calls.push('persist'),
    commit: async () => { calls.push('commit'); throw new Error('quota'); },
    clear: async () => calls.push('clear'),
    isCurrent: () => true,
  }), /quota/);
  assert.deepEqual(calls, ['persist', 'commit']);
});

test('old async Save completion cannot clear newer input; successful current save clears its checkpoint', async () => {
  const old = { text: 'old', sequence: 1, note: makeQuickCaptureNote('old', { id: 'old' }) };
  const current = { text: 'new', sequence: 2 };
  let cleared = false;
  const outcome = await commitQuickCaptureSnapshot({
    snapshot: old,
    persist: async () => {},
    commit: async () => old.note,
    clear: async () => { cleared = true; },
    isCurrent: (snapshot) => captureSnapshotIsCurrent(current.text, current.sequence, snapshot),
  });
  assert.equal(cleared, false);
  assert.equal(outcome.cleared, false);
  const latest = { ...old, sequence: 3 };
  current.text = old.text; current.sequence = latest.sequence;
  const clearedLatest = await commitQuickCaptureSnapshot({
    snapshot: latest, persist: async () => {}, commit: async () => latest.note, clear: async () => { cleared = true; },
    isCurrent: (snapshot) => captureSnapshotIsCurrent(current.text, current.sequence, snapshot),
  });
  assert.equal(clearedLatest.cleared, true);
});

test('voice capture creates an ordinary canonical note with a safe title and body available for later editing', () => {
  const note = makeQuickVoiceNote({ id: 'voice-note', now: 789 });
  assert.equal(note.title, 'Voice note');
  assert.deepEqual(note.document, { schemaVersion: 1, type: 'doc', content: [] });
  assert.equal(validateCanonicalDocument(note.document).status, 'supported');
});

test('Full Archive V2 includes a captured canonical note and its associated audio', async () => {
  const name = `quick-capture-archive-${++sequence}`;
  const notes = createNotesRepository(indexedDB, name);
  const audio = createAudioRepository(indexedDB, name);
  const note = makeQuickCaptureNote('Ý tưởng cho 東京\nExpo SQLite', { id: 'captured-archive-note', now: 900 });
  await notes.createIfMissing(note);
  const recording = await audio.create(note.id, { mimeType: 'audio/webm;codecs=opus', ownerId: 'synthetic', createdAt: 901 });
  await audio.appendChunk(recording.id, 0, new Blob(['voice'], { type: recording.mimeType }), 902);
  await audio.setStatus(recording.id, 'complete');

  const { blob } = await exportArchive(notes, { exportedAt: '2026-10-22T00:00:00.000Z' });
  const archive = await verifyArchive(blob);
  assert.equal(archive.manifest.version, 2);
  assert.deepEqual(archive.notes.map((item) => item.id), [note.id]);
  assert.equal(archive.notes[0].title, 'Ý tưởng cho 東京');
  assert.equal(archive.recordings[0].noteId, note.id);
  assert.equal(archive.chunks.length, 1);
});
