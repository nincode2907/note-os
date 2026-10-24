import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { validateCanonicalDocument } from '../../packages/document-engine/src/index.js';
import {
  createNotesRepository,
  createAudioRepository,
  ImportCollisionError,
  makeEmptyNote,
  NoteConflictError,
  NoteDocumentError,
  NoteNotFoundError,
  NoteStateError,
} from './local-notes.js';
import { createAudioAnchor } from './audio-anchors.mjs';

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

test('sync enrollment writes each eligible local mutation and outbox entry durably', async () => {
  const { name, repo } = repository();
  await repo.setDefaultSyncEnrollment(true);
  const created = await repo.create(makeNote('outbox-create'));
  let outbox = await repo.listSyncOutbox();
  assert.equal(outbox.length, 1); assert.equal(JSON.parse(outbox[0].recordJson).id, created.id);
  const changed = await repo.save(created.id, { title: 'updated', document: canonical('日本語・tiếng Việt') }, created.revision);
  outbox = await repo.listSyncOutbox(); assert.equal(outbox.length, 2); assert.equal(JSON.parse(outbox[1].recordJson).title, 'updated');
  const reopened = createNotesRepository(globalThis.indexedDB, name);
  assert.equal((await reopened.listSyncOutbox()).length, 2); assert.equal((await reopened.get('outbox-create')).revision, changed.revision);
});

test('v3 IndexedDB migration adds quarantine while preserving notes, history and queued operation IDs', async () => {
  const { name } = repository();
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 3);
    request.onupgradeneeded = () => {
      const database = request.result;
      const notes = database.createObjectStore('notes', { keyPath: 'id' }); notes.createIndex('lifecycle', 'lifecycle'); notes.createIndex('updatedAt', 'updatedAt');
      const recordings = database.createObjectStore('recordings', { keyPath: 'id' }); recordings.createIndex('noteId', 'noteId'); recordings.createIndex('status', 'status'); recordings.createIndex('updatedAt', 'updatedAt');
      const chunks = database.createObjectStore('recordingChunks', { keyPath: 'id' }); chunks.createIndex('recordingId', 'recordingId'); chunks.createIndex('recordingSequence', ['recordingId', 'sequence'], { unique: true });
      database.createObjectStore('syncOutbox', { keyPath: 'operationId' }); database.createObjectStore('syncBaselines', { keyPath: 'id' }); database.createObjectStore('syncState', { keyPath: 'key' }); database.createObjectStore('syncConflicts', { keyPath: 'id' }); database.createObjectStore('syncEnrollment', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const note = makeNote('v3-migration'), operation = { operationId: 'operation-v3-stable-0001', entityId: note.id, localRevision: 0, baseServerVersion: 4, ownerApproved: true, type: 'upsert', recordJson: JSON.stringify(note), createdAt: 1 };
  const tx = db.transaction(['notes', 'syncOutbox', 'syncBaselines', 'syncState', 'syncEnrollment'], 'readwrite');
  tx.objectStore('notes').put(note); tx.objectStore('syncOutbox').put(operation); tx.objectStore('syncBaselines').put({ id: note.id, serverVersion: 4, localRevision: 0 }); tx.objectStore('syncState').put({ key: 'history', serverEpoch: 'epoch-v3', serverCursor: 9 }); tx.objectStore('syncEnrollment').put({ id: note.id, optedIn: true });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); }); db.close();
  const reopenedRepository = createNotesRepository(indexedDB, name);
  assert.deepEqual(await reopenedRepository.get(note.id), note);
  assert.equal((await reopenedRepository.listSyncOutbox())[0].operationId, operation.operationId);
  assert.equal((await reopenedRepository.getSyncState()).state.history.serverCursor, 9);
  const migrated = await new Promise((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  assert.equal(migrated.version, 6); assert.ok(migrated.objectStoreNames.contains('syncQuarantine')); assert.ok(migrated.objectStoreNames.contains('audioSyncApprovals')); assert.ok(migrated.objectStoreNames.contains('audioSyncState')); assert.ok(migrated.objectStoreNames.contains('audioSyncChunks')); assert.ok(migrated.objectStoreNames.contains('aiRequestOutbox')); assert.ok(migrated.objectStoreNames.contains('aiConsentCache')); migrated.close();
});

test('existing notes require explicit owner enrollment and DEVICE_ONLY or recording-bearing notes are excluded', async () => {
  const { name, repo } = repository();
  const privateNote = await repo.create(makeNote('owner-choice'));
  const deviceOnly = await repo.create({ ...makeNote('never-upload'), privacy: 'DEVICE_ONLY' });
  const audioNote = await repo.create(makeNote('audio-local'));
  const db = await new Promise((resolve,reject) => { const request = indexedDB.open(name); request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); });
  const tx=db.transaction('recordings','readwrite');tx.objectStore('recordings').put({id:'recording-a',noteId:audioNote.id,status:'interrupted'});await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});db.close();
  await repo.setSyncEnrollment([privateNote.id,deviceOnly.id,audioNote.id],true);
  assert.equal((await repo.listSyncOutbox()).length,1);
  const state=await repo.getSyncState();assert.equal(state.conflicts.length,0);
});

test('pull applies note and durable cursor in one transaction; failed apply leaves cursor unchanged', async () => {
  const { name, repo } = repository();
  const remote = { ...makeNote('remote'), title: 'Remote 日本語', revision: 3 };
  const change = { id: remote.id, cursor: 7, serverVersion: 2, serverEpoch: 'epoch-a', event: 'upsert', recordJson: JSON.stringify(remote), contentHash: 'hash', lifecycle: 'active' };
  await repo.commitSyncPull({ serverEpoch: 'epoch-a', serverCursor: 7, changes: [change] });
  const state = await repo.getSyncState(); assert.equal(state.state.history.serverCursor, 7); assert.equal(state.state.history.serverEpoch, 'epoch-a');
  assert.equal((await createNotesRepository(globalThis.indexedDB,name).get('remote')).title, 'Remote 日本語');
  await assert.rejects(repo.commitSyncPull({ serverEpoch: 'epoch-a', serverCursor: 8, changes: [{ ...change, id: 'bad', cursor: 8, recordJson: '{' }] }));
  assert.equal((await repo.getSyncState()).state.history.serverCursor, 7); assert.equal(await repo.get('bad'), null);
});

test('remote ID collision preserves local content and retries one deterministic conflict copy', async () => {
  const { repo } = repository();
  const local = await repo.create(makeNote('collision', 'local version'));
  const remote = makeNote('collision', 'remote version');
  const change = { id: remote.id, cursor: 1, serverVersion: 1, serverEpoch: 'epoch-test', event: 'upsert', recordJson: JSON.stringify(remote), contentHash: 'hash', lifecycle: 'active' };
  for (let attempt = 0; attempt < 2; attempt++) await repo.commitSyncPull({ serverEpoch: 'epoch-test', serverCursor: 1, changes: [change] });
  assert.equal((await repo.get(local.id)).title, 'local version');
  const notes = await repo.list(); assert.equal(notes.filter(note => note.title.includes('(Sync conflict)')).length, 1);
  assert.equal((await repo.getSyncState()).conflicts.filter(item => item.kind === 'edit-edit').length, 1);
});

test('remote tombstone colliding with a local edit is held for review and never deletes the note', async () => {
  const { repo } = repository(); const local=await repo.create(makeNote('edit-versus-delete','local offline edit'));
  await repo.commitSyncPull({serverEpoch:'epoch-delete',serverCursor:9,changes:[{id:local.id,cursor:9,serverVersion:2,serverEpoch:'epoch-delete',event:'tombstone',recordJson:null,contentHash:null,lifecycle:'trashed'}]});
  assert.equal((await repo.get(local.id)).title,'local offline edit');
  const state=await repo.getSyncState();assert.ok(state.conflicts.some(row=>row.kind==='edit-delete'&&row.noteId===local.id));
  assert.equal(state.state.history.serverCursor,9);
});

test('150 queued revisions of one note remain ordered, stable and visible as pending', async () => {
  const { name, repo } = repository();
  await repo.setDefaultSyncEnrollment(true);
  let note = await repo.create(makeNote('many-revisions'));
  for (let index = 0; index < 149; index++) note = await repo.save(note.id, { title: `Revision ${index + 1}`, document: canonical(`body ${index + 1}`) }, note.revision);
  const operations = await repo.listSyncOutbox(1000);
  assert.equal(operations.length, 150);
  assert.equal(new Set(operations.map(row => row.operationId)).size, 150);
  assert.deepEqual(operations.map(row => row.localRevision), [...operations.map(row => row.localRevision)].sort((a,b) => a-b));
  assert.equal((await repo.getSyncOverview()).eligiblePending, 150);
  const reopened = createNotesRepository(indexedDB, name);
  assert.deepEqual((await reopened.listSyncOutbox(1000)).map(row => row.operationId), operations.map(row => row.operationId));
});

test('pull reconciles a committed operation with a lost ACK and leaves later same-note revisions sendable', async () => {
  const { repo } = repository();
  await repo.setDefaultSyncEnrollment(true);
  let note = await repo.create(makeNote('lost-ack-pull'));
  note = await repo.save(note.id, { title: 'Revision 1', document: canonical('one') }, note.revision);
  note = await repo.save(note.id, { title: 'Revision 2', document: canonical('two') }, note.revision);
  const operations = await repo.listSyncOutbox(10);
  const firstRecord = JSON.parse(operations[0].recordJson);
  await repo.commitSyncPull({ serverEpoch: 'epoch-lost-ack', serverCursor: 1, changes: [{ id: note.id, cursor: 1, serverVersion: 1, serverEpoch: 'epoch-lost-ack', event: 'upsert', recordJson: operations[0].recordJson, contentHash: 'hash-1', lifecycle: 'active' }] });
  assert.deepEqual((await repo.listSyncOutbox(10)).map(row => row.operationId), operations.slice(1).map(row => row.operationId));
  assert.equal((await repo.getSyncBaseline(note.id)).serverVersion, 1);
  assert.equal((await repo.getSyncState()).conflicts.length, 0);
  await repo.commitSyncPull({ serverEpoch: 'epoch-lost-ack', serverCursor: 2, changes: [{ id: note.id, cursor: 2, serverVersion: 2, serverEpoch: 'epoch-lost-ack', event: 'upsert', recordJson: operations[1].recordJson, contentHash: 'hash-2', lifecycle: 'active' }] });
  assert.deepEqual((await repo.listSyncOutbox(10)).map(row => row.operationId), operations.slice(2).map(row => row.operationId));
  assert.equal((await repo.getSyncBaseline(note.id)).serverVersion, 2);
  assert.equal(firstRecord.revision, 0);
  assert.equal((await repo.get(note.id)).title, 'Revision 2');
});

test('push conflict preserves full local and remote versions and blocks every queued same-note revision', async () => {
  const { name, repo } = repository();
  await repo.setDefaultSyncEnrollment(true);
  const local0 = await repo.create({ ...makeNote('push-conflict', 'Local title', canonical('local body')), pinned: true, tags: ['日本語', 'Personal'], lifecycle: 'active' });
  await repo.save(local0.id, { title: 'Later local title', document: canonical('later local body') }, local0.revision);
  const operations = await repo.listSyncOutbox(100);
  const remote = { ...makeNote(local0.id, 'Remote title', canonical('remote body')), pinned: false, tags: ['Remote'], lifecycle: 'archived', revision: 8 };
  await repo.recordSyncConflict(operations[0].operationId, { serverEpoch: 'epoch-conflict', actualVersion: 9, remote: { record: remote } });
  const state = await repo.getSyncState();
  assert.equal((await repo.get(local0.id)).title, 'Later local title');
  assert.equal((await repo.listSyncOutbox(100)).length, 0);
  assert.equal(state.quarantine.length, 2);
  const conflict = state.conflicts.find(row => row.noteId === local0.id);
  assert.equal(conflict.localOnly, true); assert.equal(conflict.status, 'needs-review');
  assert.deepEqual(conflict.localRecord.tags, ['日本語', 'Personal']);
  assert.equal(conflict.localRecord.pinned, true);
  assert.equal(conflict.localRecord.document.content[0].content[0].text, 'later local body');
  assert.deepEqual(conflict.remoteRecord, remote);
  const copy = await repo.get(conflict.conflictNoteId);
  assert.equal(copy.title, 'Remote title (Sync conflict)');
  assert.equal(copy.lifecycle, 'archived'); assert.deepEqual(copy.tags, ['Remote']); assert.equal(copy.pinned, false);
  assert.deepEqual(copy.document, remote.document);
  assert.equal((await repo.listSyncOutbox(100)).length, 0, 'conflict copies remain local until explicitly approved');
  await repo.setSyncEnrollment([conflict.conflictNoteId], true);
  assert.deepEqual((await repo.listSyncOutbox(100)).map(row => row.entityId), [conflict.conflictNoteId]);
  const reopened = createNotesRepository(indexedDB, name);
  assert.deepEqual((await reopened.getSyncState()).conflicts.find(row => row.id === conflict.id).remoteRecord, remote);
  assert.equal((await reopened.getSyncOverview()).quarantined, 2);
});

test('pull conflicts are idempotent and preserve a concurrent remote version across restart', async () => {
  const { name, repo } = repository();
  await repo.setDefaultSyncEnrollment(true);
  const local = await repo.create({ ...makeNote('pull-conflict', 'Offline local', canonical('offline body')), pinned: true, tags: ['Local'] });
  await repo.save(local.id, { title: 'Offline later', document: canonical('offline later body') }, local.revision);
  const remote = { ...makeNote(local.id, 'Other device', canonical('remote body')), pinned: false, tags: ['Remote'], revision: 4 };
  const change = { id: local.id, cursor: 11, serverVersion: 3, serverEpoch: 'epoch-pull', event: 'upsert', recordJson: JSON.stringify(remote), contentHash: 'hash-remote', lifecycle: 'active' };
  await repo.commitSyncPull({ serverEpoch: 'epoch-pull', serverCursor: 11, changes: [change] });
  await repo.commitSyncPull({ serverEpoch: 'epoch-pull', serverCursor: 11, changes: [change] });
  const state = await repo.getSyncState(), copies = (await repo.list()).filter(row => row.id.startsWith('conflict-'));
  assert.equal((await repo.get(local.id)).title, 'Offline later');
  assert.equal(copies.length, 1);
  assert.equal(state.conflicts.filter(row => row.noteId === local.id).length, 1);
  assert.deepEqual(state.conflicts.find(row => row.noteId === local.id).remoteRecord, remote);
  assert.equal(state.quarantine.length, 2);
  assert.equal(state.state.history.serverCursor, 11);
  const reopened = createNotesRepository(indexedDB, name);
  assert.equal((await reopened.get(copies[0].id)).document.content[0].content[0].text, 'remote body');
  assert.equal((await reopened.getSyncState()).conflicts.filter(row => row.noteId === local.id).length, 1);
});

test('audio attached after text ACK is visible as media-local-only and remote pulls preserve bytes and anchors', async () => {
  const { name, repo } = repository();
  await repo.setDefaultSyncEnrollment(true);
  const note = await repo.create(makeNote('audio-after-sync'));
  const [operation] = await repo.listSyncOutbox();
  await repo.acknowledgeSyncOperations([{ operationId: operation.operationId, baseline: { id: note.id, serverVersion: 1, localRevision: note.revision } }], { serverEpoch: 'epoch-audio', serverCursor: 1 });
  const audio = createAudioRepository(indexedDB, name);
  const recording = await audio.create(note.id, { mimeType: 'audio/webm', ownerId: 'test-tab', createdAt: 10 });
  await audio.appendChunk(recording.id, 0, new Blob(['synthetic audio bytes']), 1000);
  await audio.setStatus(recording.id, 'complete', { durationMs: 1000 });
  await audio.addAnchor(recording.id, createAudioAnchor(recording.id, 500, 'keep this anchor', { id: 'anchor-local', createdAt: 11 }));
  assert.equal((await repo.getSyncOverview()).noteStatuses.find(row => row.id === note.id).status, 'media-local-only');
  const beforeChunks = await audio.chunks(recording.id), beforeRecording = await audio.get(recording.id);
  const remote = { ...note, title: 'Remote text revision', revision: 1 };
  await repo.commitSyncPull({ serverEpoch: 'epoch-audio', serverCursor: 2, changes: [{ id: note.id, cursor: 2, serverVersion: 2, serverEpoch: 'epoch-audio', event: 'upsert', recordJson: JSON.stringify(remote), contentHash: 'remote-hash', lifecycle: 'active' }] });
  assert.equal((await repo.get(note.id)).title, note.title);
  assert.deepEqual(await audio.chunks(recording.id), beforeChunks);
  assert.deepEqual(await audio.get(recording.id), beforeRecording);
  assert.equal((await audio.listAnchors(recording.id))[0].id, 'anchor-local');
  const state = await repo.getSyncState();
  assert.equal(state.conflicts.find(row => row.kind === 'audio-review').localOnly, true);
  assert.deepEqual(state.conflicts.find(row => row.kind === 'audio-review').remoteRecord, remote);
  assert.equal((await repo.getSyncOverview()).noteStatuses.find(row => row.id === note.id).status, 'needs-review');
  assert.equal((await createNotesRepository(indexedDB, name).getSyncOverview()).noteStatuses.find(row => row.id === note.id).status, 'needs-review');
});

test('future note record schemas remain preserved but cannot be edited or organized as schema v1', async () => {
  const { repo } = repository();
  const future = { ...makeEmptyNote(100, 'future-record'), schemaVersion: 2, futureMetadata: { keep: true } };
  await repo.create(future);
  await assert.rejects(repo.save(future.id, { title: 'unsafe', document: future.document }, future.revision), /newer schema/i);
  await assert.rejects(repo.updateOrganization(future.id, { pinned: true }, future.revision), /newer schema/i);
  assert.deepEqual(await repo.get(future.id), future);
});
