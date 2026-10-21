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

test('organization updates are revision guarded, keep content timestamps, and reject duplicate or invalid tags', async () => {
  const { name, repo: first } = repository();
  const second = createNotesRepository(globalThis.indexedDB, name);
  const note = await first.create(makeNote('organization'));
  const updated = await first.updateOrganization(note.id, { pinned: true, tags: ['Work', 'Công việc', '日本語'] }, note.revision);
  assert.equal(updated.pinned, true); assert.deepEqual(updated.tags, ['Work', 'Công việc', '日本語']);
  assert.equal(updated.updatedAt, note.updatedAt); assert.equal(updated.revision, note.revision + 1);
  await assert.rejects(first.updateOrganization(note.id, { tags: ['same', ' same '] }, updated.revision), /duplicate tags/i);
  await assert.rejects(first.updateOrganization(note.id, { tags: ['  '] }, updated.revision), /tag name/i);
  await assert.rejects(first.updateOrganization(note.id, { tags: ['x'.repeat(33)] }, updated.revision), /up to 32/i);
  await assert.rejects(second.save(note.id, { title: 'stale overwrite', document: note.document }, note.revision), NoteConflictError);
  assert.equal((await second.get(note.id)).title, note.title);
  assert.equal((await second.get(note.id)).pinned, true);
});

test('archive, trash, and restore retain pinned and tag metadata', async () => {
  const { repo } = repository();
  const note = await repo.create({ ...makeNote('organization-lifecycle'), pinned: true, tags: ['Personal', '日本語'] });
  const archived = await repo.setLifecycle(note.id, 'archived', note.revision);
  assert.equal(archived.pinned, true); assert.deepEqual(archived.tags, ['Personal', '日本語']);
  const restored = await repo.setLifecycle(note.id, 'active', archived.revision);
  const trashed = await repo.setLifecycle(note.id, 'trashed', restored.revision);
  assert.equal(trashed.pinned, true); assert.deepEqual(trashed.tags, ['Personal', '日本語']);
  const active = await repo.setLifecycle(note.id, 'active', trashed.revision);
  assert.equal(active.pinned, true); assert.deepEqual(active.tags, ['Personal', '日本語']);
});

test('future note record schemas remain preserved but cannot be edited or organized as schema v1', async () => {
  const { repo } = repository();
  const future = { ...makeEmptyNote(100, 'future-record'), schemaVersion: 2, futureMetadata: { keep: true } };
  await repo.create(future);
  await assert.rejects(repo.save(future.id, { title: 'unsafe', document: future.document }, future.revision), /newer schema/i);
  await assert.rejects(repo.updateOrganization(future.id, { pinned: true }, future.revision), /newer schema/i);
  assert.deepEqual(await repo.get(future.id), future);
});
