import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireNativeRecordingSession, ArchiveOperationGate, canEditNativeNote, canTransitionLifecycle, commitThenClearDraft, discardDraftSafely, LatestDraftWriter, normalizeNoteView, recoveryDecision, RecordingSessionGate } from '../mobile-safety.mjs';
import { normalizeTagList, sortNotes } from '../../web/app/lib/mvp-utils.mjs';

test('recording gate locks double start/stop and navigation until verified persistence finishes', () => {
  const gate = new RecordingSessionGate();
  assert.equal(gate.beginStart(), true);
  assert.equal(gate.beginStart(), false);
  assert.equal(gate.canNavigate(), false);
  assert.equal(gate.move('requesting', 'starting'), true);
  assert.equal(gate.move('starting', 'recording'), true);
  assert.equal(gate.beginStop(), true);
  assert.equal(gate.beginStop(), false);
  assert.equal(gate.canNavigate(), false);
  assert.equal(gate.move('stopping', 'finalizing'), true);
  assert.equal(gate.canNavigate(), false);
  gate.finish();
  assert.equal(gate.canNavigate(), true);
});

test('native recording ownership prevents Home Quick Voice and editor recording at the same time', () => {
  const releaseHome = acquireNativeRecordingSession('quick-voice-home');
  assert.equal(typeof releaseHome, 'function');
  assert.equal(acquireNativeRecordingSession('editor:note-1'), null);
  releaseHome(); releaseHome();
  const releaseEditor = acquireNativeRecordingSession('editor:note-1');
  assert.equal(typeof releaseEditor, 'function');
  releaseEditor();
});

test('Full Archive export and recording finalization cannot overlap', () => {
  const gate = new ArchiveOperationGate(); const releaseFinalize = gate.beginFinalization();
  assert.throws(() => gate.beginExport(), /being finalized/u);
  releaseFinalize(); const releaseExport = gate.beginExport();
  assert.throws(() => gate.beginFinalization(), /Full Archive/u);
  releaseExport(); const releaseAgain = gate.beginExport(); releaseAgain(); releaseAgain();
});

test('background requested while recording is best effort and start lock remains held', () => {
  const gate = new RecordingSessionGate();
  gate.beginStart();
  gate.requestBackgroundStop();
  assert.equal(gate.backgroundRequested, true);
  assert.equal(gate.phase, 'requesting');
  assert.equal(gate.beginStart(), false);
});

test('trashed notes cannot transition directly to archived', () => {
  assert.equal(canTransitionLifecycle('trashed', 'archived'), false);
  assert.equal(canTransitionLifecycle('trashed', 'active'), true);
  assert.equal(canTransitionLifecycle('active', 'trashed'), true);
});

test('legacy Web v1 organization defaults are view-only and pinned items sort first', () => {
  const legacy = { id: 'old', schemaVersion: 1, title: 'Legacy', updatedAt: 8, document: { type: 'doc', content: [] } };
  const raw = JSON.stringify(legacy);
  const view = normalizeNoteView(legacy);
  assert.deepEqual(view.tags, []);
  assert.equal(view.pinned, false);
  assert.equal(JSON.stringify(legacy), raw);
  assert.equal(sortNotes([view, { ...view, id: 'pinned', pinned: true }])[0].id, 'pinned');
});

test('recovery drafts restore only at their exact base revision and known schema', () => {
  const note = { revision: 3, lifecycle: 'active', schemaVersion: 1 };
  const draft = { baseRevision: 3 };
  assert.equal(recoveryDecision(note, draft), 'offer-restore');
  assert.equal(recoveryDecision({ ...note, revision: 4 }, draft), 'preserve-only');
  assert.equal(recoveryDecision({ ...note, schemaVersion: 2 }, draft), 'preserve-only');
});

test('draft writer serializes overlapping edits and leaves the newest snapshot last', async () => {
  const writes = [];
  let release;
  const writer = new LatestDraftWriter(async value => { writes.push(value); if (value === 'first') await new Promise(resolve => { release = resolve; }); });
  writer.enqueue('first');
  const first = writer.flush();
  await new Promise(resolve => setImmediate(resolve));
  writer.enqueue('latest');
  release();
  await first;
  assert.deepEqual(writes, ['first', 'latest']);
});

test('normal edit then explicit discard leaves no journal when the editor is reopened', async () => {
  const journal = new Map();
  const writer = new LatestDraftWriter(async entry => journal.set(entry.noteId, entry));
  await discardDraftSafely({ cancelDebounce() {}, writer, noteId: 'n1', expectedRevision: 2, deleteJournal: async (id, revision) => { if (journal.get(id)?.baseRevision === revision) journal.delete(id); } });
  assert.equal(journal.has('n1'), false);
  assert.equal(journal.get('n1') ?? null, null);
});

test('discard waits for an in-flight journal write, deletes it, and cannot recreate it', async () => {
  const journal = new Map(); const order = [];
  let started; const startedPromise = new Promise(resolve => { started = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const writer = new LatestDraftWriter(async entry => { started(); await gate; journal.set(entry.noteId, entry); order.push('write-settled'); });
  writer.enqueue({ noteId: 'n2', baseRevision: 4 });
  const pendingWrite = writer.flush(); await startedPromise;
  const discard = discardDraftSafely({ cancelDebounce() { order.push('debounce-cancelled'); }, writer, noteId: 'n2', expectedRevision: 4, deleteJournal: async (id, revision) => { order.push('delete'); if (journal.get(id)?.baseRevision === revision) journal.delete(id); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(order.includes('delete'), false);
  release(); await Promise.all([pendingWrite, discard]);
  assert.deepEqual(order, ['debounce-cancelled', 'write-settled', 'delete']);
  await writer.flush();
  assert.equal(journal.has('n2'), false);
});

test('discard does not delete a journal from another revision and reopens the writer on failure', async () => {
  const journal = new Map([['n3', { noteId: 'n3', baseRevision: 8 }]]);
  const writer = new LatestDraftWriter(async entry => journal.set(entry.noteId, entry));
  await assert.rejects(discardDraftSafely({ cancelDebounce() {}, writer, noteId: 'n3', expectedRevision: 9, deleteJournal: async (id, revision) => { if (journal.get(id)?.baseRevision !== revision) throw new Error('revision mismatch'); journal.delete(id); } }), /revision mismatch/);
  assert.equal(journal.get('n3').baseRevision, 8);
  writer.enqueue({ noteId: 'n3', baseRevision: 9 });
  await writer.flush();
  assert.equal(journal.get('n3').baseRevision, 9);
});

test('Keep Editing leaves unsaved text in the journal', async () => {
  const journal = new Map();
  const writer = new LatestDraftWriter(async entry => journal.set(entry.noteId, entry));
  writer.enqueue({ noteId: 'n4', baseRevision: 1, text: 'still editing' });
  await writer.flush();
  assert.equal(journal.get('n4').text, 'still editing');
});

test('journal clear runs only after note commit succeeds', async () => {
  const events = [];
  await assert.rejects(commitThenClearDraft(async () => { events.push('commit'); throw new Error('commit failed'); }, async () => events.push('clear')), /commit failed/);
  assert.deepEqual(events, ['commit']);
  const result = await commitThenClearDraft(async () => { events.push('commit-ok'); return 'saved'; }, async () => { events.push('clear-after-commit'); });
  assert.equal(result.result, 'saved');
  assert.deepEqual(events.slice(1), ['commit-ok', 'clear-after-commit']);
});

test('native editing policy permits only active schema-v1 notes with supported native content', () => {
  assert.equal(canEditNativeNote({ lifecycle: 'active', schemaVersion: 1 }, true), true);
  assert.equal(canEditNativeNote({ lifecycle: 'archived', schemaVersion: 1 }, true), false);
  assert.equal(canEditNativeNote({ lifecycle: 'trashed', schemaVersion: 1 }, true), false);
  assert.equal(canEditNativeNote({ lifecycle: 'active', schemaVersion: 2 }, true), false);
  assert.equal(canEditNativeNote({ lifecycle: 'active', schemaVersion: 1 }, false), false);
});

test('shared tag normalization rejects duplicates instead of silently dropping one', () => {
  assert.throws(() => normalizeTagList(['Work', 'work']), /duplicate tags/);
});
