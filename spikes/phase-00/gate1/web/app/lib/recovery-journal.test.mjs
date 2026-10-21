import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createNotesRepository, makeEmptyNote } from './local-notes.js';
import { createRecoveryJournal, recoveryCandidates, recoveryEntries, finishDeletedNote } from './recovery-journal.mjs';
import { makeBackup, parseBackup } from './mvp-utils.mjs';

function memoryStorage() { const data = new Map(); return { get length() { return data.size; }, key: index => [...data.keys()][index] ?? null, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }
const doc = text => ({ schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const note = () => ({ ...makeEmptyNote(100, 'one'), title: 'Old', document: doc('Old body') });

test('reopen keeps journal with equal timestamps and own earlier in-flight commit', () => {
  const storage = memoryStorage(), saved = note(), journal = createRecoveryJournal(storage, saved, 'tab-a');
  journal.write({ title: 'Newest', document: doc('C') }, 3, 0, { title: 'A', document: doc('A'), expectedRevision: 0 });
  const reopened = { ...saved, title: 'A', document: doc('A'), revision: 1 };
  const entry = recoveryEntries(storage, saved.id)[0];
  storage.setItem(entry.key, JSON.stringify({ ...entry.value, updatedAt: reopened.updatedAt }));
  const candidates = recoveryCandidates(storage, reopened);
  assert.equal(candidates.length, 1); assert.equal(candidates[0].sameRevision, true); assert.equal(candidates[0].title, 'Newest');
});

test('one tab cannot clear a different tab journal; concurrent DB change recovers as copy', () => {
  const storage = memoryStorage(), saved = note();
  const first = createRecoveryJournal(storage, saved, 'tab-a'), second = createRecoveryJournal(storage, saved, 'tab-b');
  first.write({ title: 'A', document: doc('A') }, 1, 0); second.write({ title: 'B', document: doc('B') }, 1, 0); first.clear();
  const candidates = recoveryCandidates(storage, { ...saved, revision: 1 });
  assert.equal(candidates.length, 1); assert.equal(candidates[0].title, 'B'); assert.equal(candidates[0].sameRevision, false);
});

test('confirmed delete cleans only unchanged committed journals; same-ID import cannot apply retained draft in place', async () => {
  const storage = memoryStorage(), repo = createNotesRepository(indexedDB, `journal-delete-${crypto.randomUUID()}`);
  const created = await repo.create(note()), trashed = await repo.setLifecycle(created.id, 'trashed', 0);
  const unrelated = createRecoveryJournal(storage, { ...note(), id: 'unrelated' }, 'other'); unrelated.write({ title: 'Unrelated', document: doc('other') }, 1, 0);
  const stale = createRecoveryJournal(storage, trashed, 'stale'), newer = createRecoveryJournal(storage, trashed, 'newer'), changed = createRecoveryJournal(storage, trashed, 'changed');
  stale.write(trashed, 1, trashed.revision); newer.write({ title: 'Unsaved', document: doc('unsaved') }, 2, trashed.revision); changed.write(trashed, 1, trashed.revision);
  const captured = recoveryEntries(storage, created.id);
  changed.write({ title: 'Arrived during deletion', document: doc('latest') }, 2, trashed.revision);
  const deleted = await repo.deleteForever(created.id, trashed.revision); finishDeletedNote(storage, deleted, captured);
  await repo.importNotes(parseBackup(makeBackup([created])).notes);
  const remaining = recoveryCandidates(storage, await repo.get(created.id));
  assert.deepEqual(remaining.map(x => x.title).sort(), ['Arrived during deletion', 'Unsaved']);
  assert.equal(remaining.every(x => !x.sameRevision), true); assert.equal(newer.isCurrent(), false);
  assert.equal(recoveryEntries(storage, 'unrelated')[0].value.title, 'Unrelated');
});

test('parser and repository share validation; future content is preserved without rewriting', async () => {
  const repo = createNotesRepository(indexedDB, `validation-${crypto.randomUUID()}`);
  const future = { ...note(), schemaVersion: 1, document: { schemaVersion: 7, type: 'doc', content: [], unknown: { retained: true } } };
  const parsed = parseBackup(JSON.stringify(makeBackup([future]))); await repo.importNotes(parsed.notes);
  assert.deepEqual((await repo.get('one')).document, future.document);
  for (const invalid of [ { ...note(), updatedAt: -1 }, { ...future, schemaVersion: 0 }, { ...future, document: { schemaVersion: 7, type: 'doc' } }, { ...note(), document: { schemaVersion: 1, type: 'doc', content: [{ type: 'text' }] } } ]) {
    assert.throws(() => parseBackup(makeBackup([invalid]))); await assert.rejects(repo.importNotes([invalid]));
  }
});
