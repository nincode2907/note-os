import { assertNoteRecord, validateNoteDocument } from './note-validation.mjs';
import { normalizeTagList } from './note-organization.mjs';
import { requireVerifiedArchive } from './archive-v2.mjs';
export { NoteDocumentError } from './note-validation.mjs';

const DATABASE_NAME = 'noteos-mvp-01';
const DATABASE_VERSION = 2;
const STORE_NAME = 'notes';
const RECORDINGS_STORE = 'recordings';
const RECORDING_CHUNKS_STORE = 'recordingChunks';

export class NoteNotFoundError extends Error {
  constructor(id) {
    super(`Note ${id} was not found.`);
    this.name = 'NoteNotFoundError';
  }
}

export class NoteConflictError extends Error {
  constructor() {
    super('This note changed in another tab. The current version was kept.');
    this.name = 'NoteConflictError';
  }
}

export class ImportCollisionError extends Error {
  constructor(count) {
    super(`${count} note ID${count === 1 ? '' : 's'} already exist. No notes were imported.`);
    this.name = 'ImportCollisionError';
    this.count = count;
  }
}

export class NoteStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoteStateError';
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}

function abort(transaction, error) {
  try { transaction.abort(); } catch { /* The transaction may already be finished. */ }
  return error;
}

export function makeEmptyNote(now = Date.now(), id = crypto.randomUUID()) {
  return {
    id,
    title: 'Untitled note',
    document: { schemaVersion: 1, type: 'doc', content: [] },
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    lifecycle: 'active',
    revision: 0,
    pinned: false,
    tags: [],
  };
}

function assertExpectedRevision(revision) {
  if (!Number.isInteger(revision) || revision < 0) throw new TypeError('An expected note revision is required.');
}

export function createNotesRepository(indexedDBFactory = globalThis.indexedDB, databaseName = DATABASE_NAME) {
  let databasePromise;

  function openDatabase() {
    if (!indexedDBFactory) return Promise.reject(new Error('This browser does not provide IndexedDB.'));
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDBFactory.open(databaseName, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('lifecycle', 'lifecycle', { unique: false });
            store.createIndex('updatedAt', 'updatedAt', { unique: false });
          }
          if (!database.objectStoreNames.contains(RECORDINGS_STORE)) {
            const recordings = database.createObjectStore(RECORDINGS_STORE, { keyPath: 'id' });
            recordings.createIndex('noteId', 'noteId', { unique: false });
            recordings.createIndex('status', 'status', { unique: false });
            recordings.createIndex('updatedAt', 'updatedAt', { unique: false });
          }
          if (!database.objectStoreNames.contains(RECORDING_CHUNKS_STORE)) {
            const chunks = database.createObjectStore(RECORDING_CHUNKS_STORE, { keyPath: 'id' });
            chunks.createIndex('recordingId', 'recordingId', { unique: false });
            chunks.createIndex('recordingSequence', ['recordingId', 'sequence'], { unique: true });
          }
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
        request.onerror = () => reject(request.error ?? new Error('Could not open local note storage.'));
        request.onblocked = () => reject(new Error('Local note storage is open in another tab. Close older noteOS tabs and retry.'));
      }).catch((error) => {
        databasePromise = undefined;
        throw error;
      });
    }
    return databasePromise;
  }

  async function list() {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const done = transactionResult(transaction);
    const rows = await requestResult(transaction.objectStore(STORE_NAME).getAll());
    await done;
    return rows.sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
  }

  async function get(id) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const done = transactionResult(transaction);
    const row = await requestResult(transaction.objectStore(STORE_NAME).get(id));
    await done;
    return row ?? null;
  }

  async function create(note = makeEmptyNote()) {
    assertNoteRecord(note);
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionResult(transaction);
    transaction.objectStore(STORE_NAME).add(note);
    await done;
    return note;
  }

  async function createIfMissing(note) {
    assertNoteRecord(note);
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionResult(transaction);
    const store = transaction.objectStore(STORE_NAME);
    try {
      const existing = await requestResult(store.get(note.id));
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(note)) throw abort(transaction, new NoteConflictError());
        await done;
        return existing;
      }
      store.add(note);
      await done;
      return note;
    } catch (error) {
      try { await done; } catch { /* Consume the transaction abort before returning the original error. */ }
      throw error;
    }
  }

  async function save(id, changes, expectedRevision) {
    assertExpectedRevision(expectedRevision);
    if (!changes || typeof changes.title !== 'string') throw new TypeError('A note title must be a string.');
    const validation = validateNoteDocument(changes.document, false);
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionResult(transaction);
    const store = transaction.objectStore(STORE_NAME);

    try {
      const current = await requestResult(store.get(id));
      if (!current) throw abort(transaction, new NoteNotFoundError(id));
      if (current.revision !== expectedRevision) throw abort(transaction, new NoteConflictError());
      if (current.schemaVersion !== 1) throw abort(transaction, new NoteStateError('This note record uses a newer schema and is read-only in this version.'));
      if (current.lifecycle === 'trashed') throw abort(transaction, new NoteStateError('Restore a trashed note before editing it.'));
      const updated = {
        ...current,
        title: changes.title,
        document: validation.document,
        updatedAt: Date.now(),
        revision: current.revision + 1,
      };
      store.put(updated);
      await done;
      return updated;
    } catch (error) {
      try { await done; } catch { /* Consume the abort before returning the original error. */ }
      throw error;
    }
  }

  async function updateOrganization(id, changes, expectedRevision) {
    assertExpectedRevision(expectedRevision);
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Organization changes must be an object.');
    const hasPinned = Object.hasOwn(changes, 'pinned'), hasTags = Object.hasOwn(changes, 'tags');
    if (!hasPinned && !hasTags) throw new TypeError('Choose a pin or tag change.');
    if (hasPinned && typeof changes.pinned !== 'boolean') throw new TypeError('Pin state must be true or false.');
    const tags = hasTags ? normalizeTagList(changes.tags) : undefined;
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionResult(transaction), store = transaction.objectStore(STORE_NAME);
    try {
      const current = await requestResult(store.get(id));
      if (!current) throw abort(transaction, new NoteNotFoundError(id));
      if (current.revision !== expectedRevision) throw abort(transaction, new NoteConflictError());
      if (current.schemaVersion !== 1) throw abort(transaction, new NoteStateError('This note record uses a newer schema and is read-only in this version.'));
      if (current.lifecycle !== 'active') throw abort(transaction, new NoteStateError('Restore this note before changing its organization.'));
      const updated = {
        ...current,
        ...(hasPinned ? { pinned: changes.pinned } : {}),
        ...(hasTags ? { tags } : {}),
        revision: current.revision + 1,
      };
      assertNoteRecord(updated);
      store.put(updated);
      await done;
      return updated;
    } catch (error) { try { await done; } catch { /* Consume the transaction abort. */ } throw error; }
  }

  async function setLifecycle(id, lifecycle, expectedRevision) {
    if (!['active', 'archived', 'trashed'].includes(lifecycle)) throw new TypeError('Invalid note lifecycle.');
    assertExpectedRevision(expectedRevision);
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionResult(transaction);
    const store = transaction.objectStore(STORE_NAME);

    try {
      const current = await requestResult(store.get(id));
      if (!current) throw abort(transaction, new NoteNotFoundError(id));
      if (current.revision !== expectedRevision) throw abort(transaction, new NoteConflictError());
      if (current.lifecycle === 'trashed' && lifecycle === 'archived') {
        throw abort(transaction, new NoteStateError('Restore a trashed note before archiving it.'));
      }
      const updated = { ...current, lifecycle, updatedAt: Date.now(), revision: current.revision + 1 };
      store.put(updated);
      await done;
      return updated;
    } catch (error) {
      try { await done; } catch { /* Consume the abort before returning the original error. */ }
      throw error;
    }
  }

  async function deleteForever(id, expectedRevision) {
    assertExpectedRevision(expectedRevision);
    const database = await openDatabase();
    const transaction = database.transaction([STORE_NAME, RECORDINGS_STORE, RECORDING_CHUNKS_STORE], 'readwrite');
    const done = transactionResult(transaction);
    const store = transaction.objectStore(STORE_NAME);
    try {
      const current = await requestResult(store.get(id));
      if (!current) throw abort(transaction, new NoteNotFoundError(id));
      if (current.revision !== expectedRevision) throw abort(transaction, new NoteConflictError());
      if (current.lifecycle !== 'trashed') throw abort(transaction, new NoteStateError('Only trashed notes can be permanently deleted.'));
      const recordings = transaction.objectStore(RECORDINGS_STORE);
      const chunks = transaction.objectStore(RECORDING_CHUNKS_STORE);
      const linked = await requestResult(recordings.index('noteId').getAll(id));
      if (linked.some((recording) => ['recording', 'paused'].includes(recording.status))) {
        throw abort(transaction, new NoteStateError('Stop the active recording before permanently deleting this note.'));
      }
      for (const recording of linked) {
        const keys = await requestResult(chunks.index('recordingId').getAllKeys(recording.id));
        for (const key of keys) chunks.delete(key);
        recordings.delete(recording.id);
      }
      store.delete(id);
      await done;
      return current;
    } catch (error) {
      try { await done; } catch { /* Consume the abort before returning the original error. */ }
      throw error;
    }
  }

  async function importNotes(notes, mode = 'merge') {
    if (!['merge', 'skip'].includes(mode)) throw new TypeError('Choose merge or skip.');
    if (!Array.isArray(notes)) throw new TypeError('Backup notes must be an array.');
    const ids = new Set();
    for (const note of notes) {
      if (!note || typeof note.id !== 'string' || !note.id || ids.has(note.id)) {
        throw new TypeError('The backup contains a missing or duplicate note ID.');
      }
      assertNoteRecord(note, { allowUnsupported: true });
      ids.add(note.id);
    }

    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionResult(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const existing = await requestResult(store.getAll());
    const existingIds = new Set(existing.map((note) => note.id));
    const collisions = notes.filter((note) => existingIds.has(note.id)).length;
    if (mode === 'skip' && collisions > 0) {
      abort(transaction, new ImportCollisionError(collisions));
      try { await done; } catch { /* Expected: the all-or-nothing import was aborted. */ }
      throw new ImportCollisionError(collisions);
    }

    const additions = notes.filter((note) => !existingIds.has(note.id));
    for (const note of additions) store.add(note);
    await done;
    return { imported: additions.length, skipped: collisions };
  }

  async function snapshotArchive() {
    const database = await openDatabase();
    const transaction = database.transaction([STORE_NAME, RECORDINGS_STORE, RECORDING_CHUNKS_STORE], 'readonly');
    const done = transactionResult(transaction);
    // Queue every request synchronously in the same storage-level snapshot.
    const requests = [STORE_NAME, RECORDINGS_STORE, RECORDING_CHUNKS_STORE].map((name) => requestResult(transaction.objectStore(name).getAll()));
    const [notes, recordings, chunks] = await Promise.all(requests);
    await done;
    return { notes, recordings, chunks };
  }

  async function importArchive(snapshot, mode = 'merge') {
    requireVerifiedArchive(snapshot);
    if (!['merge', 'skip'].includes(mode)) throw new TypeError('Choose merge or skip.');
    const database = await openDatabase();
    const transaction = database.transaction([STORE_NAME, RECORDINGS_STORE, RECORDING_CHUNKS_STORE], 'readwrite');
    const done = transactionResult(transaction);
    try {
      // Only IndexedDB requests are awaited inside this transaction. Parsing,
      // hashing, Blob slicing, and record validation finished before it opened.
      const stores = [STORE_NAME, RECORDINGS_STORE, RECORDING_CHUNKS_STORE].map((name) => transaction.objectStore(name));
      const keys = await Promise.all(stores.map((store) => requestResult(store.getAllKeys())));
      const [noteIds, recordingIds, chunkIds] = keys.map((ids) => new Set(ids));
      const skippedNoteIds = new Set(snapshot.notes.filter((note) => noteIds.has(note.id)).map((note) => note.id));
      const recordingNotes = new Map(snapshot.recordings.map((recording) => [recording.id, recording.noteId]));
      for (const recording of snapshot.recordings) if (recordingIds.has(recording.id)) skippedNoteIds.add(recording.noteId);
      for (const chunk of snapshot.chunks) if (chunkIds.has(chunk.id)) skippedNoteIds.add(recordingNotes.get(chunk.recordingId));
      if (mode === 'skip' && skippedNoteIds.size) throw new Error('An incoming note, recording or chunk ID already exists. The entire import was aborted.');
      const notes = snapshot.notes.filter((note) => !skippedNoteIds.has(note.id));
      const recordings = snapshot.recordings.filter((recording) => !skippedNoteIds.has(recording.noteId));
      const importedRecordingIds = new Set(recordings.map((recording) => recording.id));
      for (const note of notes) stores[0].add(note);
      for (const recording of recordings) stores[1].add(recording);
      for (const chunk of snapshot.chunks) if (importedRecordingIds.has(chunk.recordingId)) stores[2].add(chunk);
      await done;
      return { importedNotes: notes.length, skippedNotes: snapshot.notes.length - notes.length, importedRecordings: recordings.length, skippedRecordings: snapshot.recordings.length - recordings.length };
    } catch (error) {
      abort(transaction, error);
      try { await done; } catch { /* Consume the abort; retain quota or collision cause. */ }
      throw error;
    }
  }

  return { list, get, create, createIfMissing, save, updateOrganization, setLifecycle, deleteForever, importNotes, snapshotArchive, importArchive };
}

function assertAudioTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative timestamp.`);
}

function assertRecordingState(state) {
  if (!['recording', 'paused', 'complete', 'interrupted', 'failed'].includes(state)) throw new TypeError('Invalid recording state.');
}

export function createAudioRepository(indexedDBFactory = globalThis.indexedDB, databaseName = DATABASE_NAME) {
  let databasePromise;
  function openDatabase() {
    if (!indexedDBFactory) return Promise.reject(new Error('This browser does not provide IndexedDB.'));
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDBFactory.open(databaseName, DATABASE_VERSION);
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
        request.onerror = () => reject(request.error ?? new Error('Could not open local audio storage.'));
        request.onblocked = () => reject(new Error('Local audio storage is open in another tab. Close older noteOS tabs and retry.'));
      }).catch((error) => { databasePromise = undefined; throw error; });
    }
    return databasePromise;
  }
  async function run(tx, request) {
    const done = transactionResult(tx);
    const result = await requestResult(request);
    await done;
    return result;
  }
  async function list(noteId) {
    const database = await openDatabase();
    const tx = database.transaction(RECORDINGS_STORE, 'readonly');
    const rows = await run(tx, tx.objectStore(RECORDINGS_STORE).index('noteId').getAll(noteId));
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }
  async function listUnfinished() {
    const database = await openDatabase();
    const tx = database.transaction(RECORDINGS_STORE, 'readonly');
    const rows = await run(tx, tx.objectStore(RECORDINGS_STORE).getAll());
    return rows.filter((recording) => ['recording', 'paused'].includes(recording.status));
  }
  async function get(recordingId) {
    const database = await openDatabase();
    const tx = database.transaction(RECORDINGS_STORE, 'readonly');
    return (await run(tx, tx.objectStore(RECORDINGS_STORE).get(recordingId))) ?? null;
  }
  async function create(noteId, { mimeType, ownerId, createdAt = Date.now() }) {
    if (typeof noteId !== 'string' || !noteId) throw new TypeError('A note ID is required.');
    if (typeof mimeType !== 'string' || !mimeType) throw new TypeError('An audio MIME type is required.');
    if (typeof ownerId !== 'string' || !ownerId) throw new TypeError('A recording owner ID is required.');
    assertAudioTimestamp(createdAt, 'createdAt');
    const database = await openDatabase();
    const tx = database.transaction([STORE_NAME, RECORDINGS_STORE], 'readwrite');
    const done = transactionResult(tx);
    try {
      const note = await requestResult(tx.objectStore(STORE_NAME).get(noteId));
      if (!note) throw abort(tx, new NoteNotFoundError(noteId));
      if (note.lifecycle !== 'active') throw abort(tx, new NoteStateError('Restore this note before recording audio.'));
      const store = tx.objectStore(RECORDINGS_STORE);
      const current = await requestResult(store.index('noteId').getAll(noteId));
      if (current.some((entry) => ['recording', 'paused'].includes(entry.status))) throw abort(tx, new NoteStateError('A recording is already active for this note.'));
      const recording = { id: crypto.randomUUID(), noteId, title: 'Audio recording', mimeType, status: 'recording', ownerId, createdAt, updatedAt: createdAt, durationMs: 0, chunkCount: 0 };
      store.add(recording);
      await done;
      return recording;
    } catch (error) { try { await done; } catch { /* Consume transaction abort before returning the original error. */ } throw error; }
  }
  async function appendChunk(recordingId, sequence, blob, durationMs) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('Chunk sequence must be non-negative.');
    if (!(blob instanceof Blob) || blob.size === 0) return get(recordingId);
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw new TypeError('Recording duration must be non-negative.');
    const database = await openDatabase();
    const tx = database.transaction([RECORDINGS_STORE, RECORDING_CHUNKS_STORE], 'readwrite');
    const done = transactionResult(tx);
    const recordings = tx.objectStore(RECORDINGS_STORE), chunks = tx.objectStore(RECORDING_CHUNKS_STORE);
    try {
      const recording = await requestResult(recordings.get(recordingId));
      if (!recording || !['recording', 'paused'].includes(recording.status)) throw abort(tx, new NoteStateError('This recording is no longer writable.'));
      chunks.add({ id: `${recordingId}:${sequence}`, recordingId, sequence, blob });
      recordings.put({ ...recording, chunkCount: Math.max(recording.chunkCount, sequence + 1), durationMs: Math.max(recording.durationMs, durationMs), updatedAt: Date.now() });
      await done;
      return { ...recording, chunkCount: Math.max(recording.chunkCount, sequence + 1), durationMs: Math.max(recording.durationMs, durationMs), updatedAt: Date.now() };
    } catch (error) { try { await done; } catch { /* Return the original failed transaction. */ } throw error; }
  }
  async function setStatus(recordingId, status, { durationMs } = {}) {
    assertRecordingState(status);
    const database = await openDatabase();
    const tx = database.transaction(RECORDINGS_STORE, 'readwrite');
    const done = transactionResult(tx), store = tx.objectStore(RECORDINGS_STORE);
    try {
      const recording = await requestResult(store.get(recordingId));
      if (!recording) throw abort(tx, new NoteNotFoundError(recordingId));
      const allowed = { recording: ['paused', 'complete', 'interrupted', 'failed'], paused: ['recording', 'complete', 'interrupted', 'failed'], complete: [], interrupted: [], failed: [] };
      if (recording.status !== status && !allowed[recording.status].includes(status)) throw abort(tx, new NoteStateError(`Cannot change recording from ${recording.status} to ${status}.`));
      const updated = { ...recording, status, updatedAt: Date.now(), ...(durationMs === undefined ? {} : { durationMs }) };
      if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs < 0)) throw abort(tx, new TypeError('Recording duration must be non-negative.'));
      store.put(updated); await done; return updated;
    } catch (error) { try { await done; } catch { /* Consume the abort. */ } throw error; }
  }
  async function rename(recordingId, title) {
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new TypeError('Recording title must contain 1–120 characters.');
    const database = await openDatabase(), tx = database.transaction(RECORDINGS_STORE, 'readwrite'), done = transactionResult(tx), store = tx.objectStore(RECORDINGS_STORE);
    try {
      const recording = await requestResult(store.get(recordingId));
      if (!recording) throw abort(tx, new NoteNotFoundError(recordingId));
      const updated = { ...recording, title: title.trim(), updatedAt: Date.now() }; store.put(updated); await done; return updated;
    } catch (error) { try { await done; } catch { /* Consume the abort. */ } throw error; }
  }
  async function chunks(recordingId) {
    const database = await openDatabase(), tx = database.transaction(RECORDING_CHUNKS_STORE, 'readonly');
    const rows = await run(tx, tx.objectStore(RECORDING_CHUNKS_STORE).index('recordingSequence').getAll(IDBKeyRange.bound([recordingId, 0], [recordingId, Number.MAX_SAFE_INTEGER])));
    return rows.sort((a, b) => a.sequence - b.sequence);
  }
  async function remove(recordingId) {
    const database = await openDatabase(), tx = database.transaction([RECORDINGS_STORE, RECORDING_CHUNKS_STORE], 'readwrite'), done = transactionResult(tx);
    const recordings = tx.objectStore(RECORDINGS_STORE), chunkStore = tx.objectStore(RECORDING_CHUNKS_STORE);
    try {
      const recording = await requestResult(recordings.get(recordingId));
      if (!recording) throw abort(tx, new NoteNotFoundError(recordingId));
      if (['recording', 'paused'].includes(recording.status)) throw abort(tx, new NoteStateError('Stop the active recording before deleting it.'));
      const keys = await requestResult(chunkStore.index('recordingId').getAllKeys(recordingId));
      for (const key of keys) chunkStore.delete(key);
      recordings.delete(recordingId); await done; return recording;
    } catch (error) { try { await done; } catch { /* Consume the abort. */ } throw error; }
  }
  async function recover(recordingId) {
    const database = await openDatabase(), tx = database.transaction(RECORDINGS_STORE, 'readwrite'), done = transactionResult(tx), store = tx.objectStore(RECORDINGS_STORE);
    try {
      const recording = await requestResult(store.get(recordingId));
      if (!recording || !['recording', 'paused'].includes(recording.status)) {
        await done;
        return null;
      }
      const next = { ...recording, status: 'interrupted', updatedAt: Date.now() };
      store.put(next);
      await done;
      return next;
    } catch (error) { try { await done; } catch { /* Consume transaction abort. */ } throw error; }
  }
  return { list, listUnfinished, get, create, appendChunk, setStatus, rename, chunks, remove, recover };
}
