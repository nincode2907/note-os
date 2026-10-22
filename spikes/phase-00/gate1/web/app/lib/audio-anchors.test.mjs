import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createAudioRepository, createNotesRepository, makeEmptyNote } from './local-notes.js';
import { createRecoveryJournal, recoveryEntries } from './recovery-journal.mjs';
import {
  ActiveMediaClock,
  addAudioAnchor,
  createAudioAnchor,
  emptyAudioAnchorSet,
  formatAudioTimestamp,
  normalizeAudioAnchorLabel,
  validateAudioAnchorSet,
} from './audio-anchors.mjs';

let serial = 0;
function fixture() {
  const name = `audio-anchor-${++serial}`;
  return { name, notes: createNotesRepository(indexedDB, name), audio: createAudioRepository(indexedDB, name) };
}

test('active media clock uses monotonic elapsed segments and excludes pause time', () => {
  let time = 1000;
  const clock = new ActiveMediaClock(() => time);
  clock.start(); time += 1250; assert.equal(clock.read(), 1250);
  assert.equal(clock.pause(), 1250); time += 90000; assert.equal(clock.read(), 1250);
  clock.resume(); time += 750; assert.equal(clock.stop(), 2000);
  assert.equal(clock.read(), 2000);
  let fractional = 0; const nativeStorageClock = new ActiveMediaClock(() => fractional);
  nativeStorageClock.start(); fractional = 1234.6;
  assert.equal(nativeStorageClock.pause(), 1235);
  assert.equal(Number.isSafeInteger(nativeStorageClock.pause()), true);
});

test('anchors accept duplicate offsets and sort chronologically without changing note revisions', async () => {
  const { name, notes, audio } = fixture();
  const note = makeEmptyNote(1, 'anchor-note'); await notes.create(note);
  const recording = await audio.create(note.id, { mimeType: 'audio/webm;codecs=opus', ownerId: 'test', createdAt: 2 });
  const later = createAudioAnchor(recording.id, 12000, ' 東京  ', { id: 'later', createdAt: 4 });
  const first = createAudioAnchor(recording.id, 5000, 'Điểm mốc', { id: 'first', createdAt: 5 });
  const second = createAudioAnchor(recording.id, 5000, '同じ時間', { id: 'second', createdAt: 6 });
  await audio.addAnchor(recording.id, later); await audio.addAnchor(recording.id, first); await audio.addAnchor(recording.id, second);
  const reopened = createAudioRepository(indexedDB, name);
  assert.deepEqual((await reopened.listAnchors(recording.id)).map(anchor => [anchor.id, anchor.offsetMs]), [['first', 5000], ['second', 5000], ['later', 12000]]);
  assert.equal((await notes.get(note.id)).revision, 0);
});

test('anchor rename/delete persist and deleting the recording cascades its anchor metadata with its chunks', async () => {
  const { notes, audio } = fixture(); const note = makeEmptyNote(1, 'delete-note'); await notes.create(note);
  const recording = await audio.create(note.id, { mimeType: 'audio/webm', ownerId: 'test', createdAt: 2 });
  await audio.appendChunk(recording.id, 0, new Blob(['audio'], { type: 'audio/webm' }), 1000);
  await audio.setStatus(recording.id, 'complete', { durationMs: 1000 });
  await audio.addAnchor(recording.id, createAudioAnchor(recording.id, 10, 'before', { id: 'a', createdAt: 3 }));
  await audio.renameAnchor(recording.id, 'a', '  Đánh dấu 東京  ');
  assert.equal((await audio.listAnchors(recording.id))[0].label, 'Đánh dấu 東京');
  await audio.removeAnchor(recording.id, 'a'); assert.deepEqual(await audio.listAnchors(recording.id), []);
  await audio.addAnchor(recording.id, createAudioAnchor(recording.id, 10, '', { id: 'b', createdAt: 4 }));
  await audio.remove(recording.id);
  assert.equal(await audio.get(recording.id), null); assert.deepEqual(await audio.chunks(recording.id), []); assert.deepEqual(await audio.listAnchors(recording.id), []);
});

test('bookmark changes leave an unsaved editor recovery draft byte-for-byte intact', async () => {
  const { notes, audio } = fixture(); const note = makeEmptyNote(1, 'draft-anchor-note'); await notes.create(note);
  const recording = await audio.create(note.id, { mimeType: 'audio/webm', ownerId: 'test', createdAt: 2 });
  const memory = new Map(); const storage = { get length() { return memory.size; }, key(index) { return [...memory.keys()][index] ?? null; }, getItem(key) { return memory.get(key) ?? null; }, setItem(key, value) { memory.set(key, String(value)); }, removeItem(key) { memory.delete(key); } };
  const journal = createRecoveryJournal(storage, note, 'editor-writer'); const draft = { title: 'Unsaved thought', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this draft' }] }] } };
  journal.write(draft, 1, note.revision); const before = recoveryEntries(storage, note.id)[0].raw;
  const anchor = createAudioAnchor(recording.id, 420, 'draft stays', { id: 'anchor-draft-safe', createdAt: 3 });
  await audio.addAnchor(recording.id, anchor); await audio.renameAnchor(recording.id, anchor.id, 'renamed'); await audio.removeAnchor(recording.id, anchor.id);
  assert.equal(recoveryEntries(storage, note.id)[0].raw, before);
  assert.equal((await notes.get(note.id)).revision, note.revision);
});

test('strict validation rejects unsafe identities, invalid offsets, duplicate IDs, oversized labels and out-of-range known duration', () => {
  const valid = createAudioAnchor('rec-1', 300, '  Café  ', { id: 'one', createdAt: 2 });
  assert.equal(normalizeAudioAnchorLabel('Cafe\u0301'), 'Café');
  assert.equal(formatAudioTimestamp(3_661_999), '1:01:01');
  for (const offset of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createAudioAnchor('rec-1', offset));
  assert.throws(() => createAudioAnchor('rec-1', 0, 'x'.repeat(121)));
  assert.throws(() => createAudioAnchor('bad\u0000id', 0));
  assert.throws(() => addAudioAnchor({ version: 1, items: [valid] }, valid, 'rec-1'));
  assert.throws(() => validateAudioAnchorSet({ version: 1, items: [valid] }, 'rec-1', { durationMs: 299, durationKnown: true }));
  assert.deepEqual(validateAudioAnchorSet(undefined, 'rec-1'), emptyAudioAnchorSet());
});

test('anchor count is bounded and unknown legacy duration does not reject valid anchors', () => {
  const items = Array.from({ length: 101 }, (_, index) => createAudioAnchor('rec-legacy', index, '', { id: `a-${index}`, createdAt: index }));
  assert.throws(() => validateAudioAnchorSet({ version: 1, items }, 'rec-legacy'));
  const anchor = createAudioAnchor('rec-legacy', 18000, '回復', { id: 'known', createdAt: 1 });
  assert.equal(validateAudioAnchorSet({ version: 1, items: [anchor] }, 'rec-legacy', { durationMs: 0, durationKnown: false }).items[0].offsetMs, 18000);
});
