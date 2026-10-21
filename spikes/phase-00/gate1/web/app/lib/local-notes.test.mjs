import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { validateCanonicalDocument } from '../../packages/document-engine/src/index.js';
import {
  createNotesRepository,
  ImportCollisionError,
  makeEmptyNote,
  NoteConflictError,
  NoteDocumentError,
  NoteNotFoundError,
  NoteStateError,
} from './local-notes.js';

let databaseSequence = 0;
function repository() {
  databaseSequence += 1;
  const name = `noteos-mvp-test-${databaseSequence}`;
  return { name, repo: createNotesRepository(globalThis.indexedDB, name) };
}

function canonical(text = 'saved') {
  return { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function makeNote(id, title = id, document = canonical()) {
  return { ...makeEmptyNote(100, id), title, document };
}

test('revision race rejects stale saves and preserves the newer committed record', async () => {
  const { name, repo: firstTab } = repository();
  const secondTab = createNotesRepository(globalThis.indexedDB, name);
  const created = await firstTab.create(makeNote('race'));
  const newer = await firstTab.save(created.id, { title: 'new tab value', document: canonical('new') }, created.revision);
  await assert.rejects(secondTab.save(created.id, { title: 'stale value', document: canonical('stale') }, created.revision), NoteConflictError);
  assert.equal((await secondTab.get(created.id)).title, 'new tab value');
  assert.equal((await secondTab.get(created.id)).revision, newer.revision);
});

test('canonical documents are validated at create and save boundaries', async () => {
  const { repo } = repository();
  const invalid = { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text' }] }] };
  await assert.rejects(repo.create(makeNote('invalid-create', 'invalid', invalid)), NoteDocumentError);
  const created = await repo.create(makeNote('valid'));
  await assert.rejects(repo.save(created.id, { title: 'invalid', document: invalid }, created.revision), NoteDocumentError);
  assert.equal((await repo.get(created.id)).title, 'valid');
});

test('backup import validates all documents before writing and preserves future schema read-only', async () => {
  const { repo } = repository();
  const future = makeNote('future', 'Future', { schemaVersion: 2, type: 'doc', content: [], futurePayload: { keep: true } });
  const malformed = makeNote('bad', 'Bad', { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text' }] }] });
  await assert.rejects(repo.importNotes([makeNote('valid-first'), malformed]), NoteDocumentError);
  assert.equal(await repo.get('valid-first'), null);
  const result = await repo.importNotes([future]);
  assert.deepEqual(result, { imported: 1, skipped: 0 });
  assert.deepEqual((await repo.get('future')).document, future.document);
  assert.equal(validateCanonicalDocument((await repo.get('future')).document).status, 'unsupported');
});

test('skip import is all-or-nothing on collision; merge never overwrites matching IDs', async () => {
  const { repo } = repository();
  await repo.create(makeNote('existing', 'keep me'));
  await assert.rejects(repo.importNotes([makeNote('new'), makeNote('existing', 'overwrite')], 'skip'), ImportCollisionError);
  assert.equal(await repo.get('new'), null);
  assert.equal((await repo.get('existing')).title, 'keep me');
  const result = await repo.importNotes([makeNote('new'), makeNote('existing', 'overwrite')], 'merge');
  assert.deepEqual(result, { imported: 1, skipped: 1 });
  assert.equal((await repo.get('existing')).title, 'keep me');
  assert.equal((await repo.get('new')).title, 'new');
});

test('permanent deletion requires a trashed note and matching revision; missing notes are explicit', async () => {
  const { name, repo } = repository();
  const otherTab = createNotesRepository(globalThis.indexedDB, name);
  const created = await repo.create(makeNote('delete-race'));
  await assert.rejects(repo.deleteForever(created.id, created.revision), NoteStateError);
  const changed = await otherTab.save(created.id, { title: 'changed in other tab', document: canonical('edited') }, created.revision);
  const trashed = await repo.setLifecycle(created.id, 'trashed', changed.revision);
  await assert.rejects(otherTab.deleteForever(created.id, created.revision), NoteConflictError);
  assert.equal((await repo.get(created.id)).lifecycle, 'trashed');
  await assert.rejects(otherTab.save(created.id, { title: 'edit trashed', document: canonical() }, trashed.revision), NoteStateError);
  await repo.deleteForever(created.id, trashed.revision);
  assert.equal(await repo.get(created.id), null);
  await assert.rejects(repo.deleteForever(created.id, trashed.revision), NoteNotFoundError);
});

test('permanent deletion rejects stale revisions after a restore transition', async () => {
  const { repo } = repository();
  const created = await repo.create(makeNote('restore-race'));
  const trashed = await repo.setLifecycle(created.id, 'trashed', created.revision);
  const restored = await repo.setLifecycle(created.id, 'active', trashed.revision);
  await assert.rejects(repo.deleteForever(created.id, trashed.revision), NoteConflictError);
  assert.equal((await repo.get(created.id)).lifecycle, 'active');
  await assert.rejects(repo.deleteForever(created.id, restored.revision), NoteStateError);
});
