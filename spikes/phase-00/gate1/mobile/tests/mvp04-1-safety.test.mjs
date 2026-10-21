import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionLifecycle, LatestDraftWriter, normalizeNoteView, recoveryDecision, RecordingSessionGate } from '../mobile-safety.mjs';
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

test('shared tag normalization rejects duplicates instead of silently dropping one', () => {
  assert.throws(() => normalizeTagList(['Work', 'work']), /duplicate tags/);
});
