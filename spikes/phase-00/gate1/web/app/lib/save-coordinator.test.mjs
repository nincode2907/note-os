import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaveCoordinator } from './save-coordinator.mjs';
import { NoteConflictError } from './local-notes.js';

const doc = text => ({ schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const draft = text => ({ title: text, document: doc(text) });
const note = () => ({ id: 'one', ...draft('Old body'), revision: 0, lifecycle: 'active', createdAt: 1, updatedAt: 1 });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const calls = [], states = [];
  const journal = { current: true, value: null, isCurrent() { return this.current; }, write(value, generation, revision, pending) { this.value = structuredClone({ ...value, generation, revision, pending }); }, clear() { this.value = null; } };
  const repository = { save(id, value, revision) { const gate = deferred(); calls.push({ id, value, revision, gate }); return gate.promise; }, async setLifecycle(id, lifecycle, revision) { return { ...note(), ...draft('C'), lifecycle, revision: revision + 1 }; } };
  const coordinator = createSaveCoordinator({ note: note(), repository, journal, onChange: s => states.push(structuredClone(s)) });
  const finish = (index) => calls[index].gate.resolve({ ...note(), ...calls[index].value, revision: calls[index].revision + 1, updatedAt: index + 2 });
  return { calls, states, journal, repository, coordinator, finish };
}

test('serializes delayed A then newest B/C, preserves latest journal and does not show Saved early', async () => {
  const f = fixture(); f.coordinator.edit(draft('A'));
  const first = f.coordinator.flush();
  f.coordinator.edit(draft('B')); f.coordinator.edit(draft('C'));
  assert.equal(f.coordinator.flush(), first);
  assert.equal(f.calls.length, 1);
  assert.equal(f.journal.value.title, 'C');
  f.finish(0); await Promise.resolve();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].value.title, 'C');
  assert.equal(f.calls[1].revision, 1);
  assert.equal(f.journal.value.title, 'C');
  assert.equal(f.coordinator.snapshot().dirty, true);
  assert.equal(f.coordinator.snapshot().inFlight, true);
  f.finish(1); assert.equal((await first).ok, true);
  assert.equal(f.coordinator.snapshot().note.title, 'C');
  assert.equal(f.coordinator.snapshot().note.revision, 2);
  assert.equal(f.journal.value, null);
});

test('C arriving while B saves is drained with the next expected revision', async () => {
  const f = fixture(); f.coordinator.edit(draft('A')); const flushing = f.coordinator.flush();
  f.coordinator.edit(draft('B')); f.finish(0); await Promise.resolve();
  f.coordinator.edit(draft('C')); f.finish(1); await Promise.resolve();
  assert.equal(f.calls[2].revision, 2); assert.equal(f.calls[2].value.title, 'C');
  f.finish(2); assert.equal((await flushing).ok, true); assert.equal(f.journal.value, null);
});

test('autosave and lifecycle share a flush and lifecycle uses the committed revision', async () => {
  const f = fixture(); let transition;
  f.repository.setLifecycle = async (id, lifecycle, revision) => { transition = { id, lifecycle, revision }; return { ...note(), ...draft('C'), lifecycle, revision: revision + 1 }; };
  f.coordinator.edit(draft('C')); const saving = f.coordinator.flush(); const changing = f.coordinator.transition('archived');
  assert.equal(f.calls.length, 1); assert.equal(transition, undefined);
  f.finish(0); await saving; assert.equal((await changing).ok, true);
  assert.equal(transition.revision, 1); assert.equal(f.calls.length, 1);
});

test('failed in-flight save retains newest draft and journal and blocks lifecycle without retry', async () => {
  const f = fixture(); let transitioned = false; f.repository.setLifecycle = async () => { transitioned = true; };
  f.coordinator.edit(draft('A')); const saving = f.coordinator.flush(); const changing = f.coordinator.transition('trashed');
  f.coordinator.edit(draft('B')); f.calls[0].gate.reject(new Error('disk full'));
  assert.equal((await saving).ok, false); assert.equal((await changing).ok, false);
  assert.equal(transitioned, false); assert.equal(f.calls.length, 1); assert.equal(f.journal.value.title, 'B'); assert.equal(f.coordinator.snapshot().dirty, true);
});

test('cross-tab stale revision stays rejected; no adoption of another tab revision', async () => {
  const f = fixture(); f.coordinator.edit(draft('A')); const result = f.coordinator.transition('archived');
  f.calls[0].gate.reject(new NoteConflictError()); assert.equal((await result).ok, false);
  assert.equal(f.coordinator.snapshot().note.revision, 0); assert.equal(f.journal.value.title, 'A');
});

test('unchanged draft does not save or increment revision; unsupported/trashed record can restore', async () => {
  const f = fixture(); assert.equal((await f.coordinator.flush()).ok, true); assert.equal(f.calls.length, 0);
  const calls = [];
  const coordinator = createSaveCoordinator({ note: { ...note(), lifecycle: 'trashed', schemaVersion: 99, document: { schemaVersion: 99, type: 'doc', content: [] } }, journal: f.journal, repository: { save() { throw Error('unnecessary save'); }, async setLifecycle(id, lifecycle, revision) { calls.push(revision); return { ...note(), lifecycle, revision: revision + 1 }; } } });
  assert.equal((await coordinator.transition('active')).ok, true); assert.deepEqual(calls, [0]);
});

test('deletion epoch prevents stale-tab save after same-ID reimport', async () => {
  const f = fixture(); f.coordinator.edit(draft('A')); f.journal.current = false;
  assert.equal((await f.coordinator.flush()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.coordinator.snapshot().dirty, true);
});
