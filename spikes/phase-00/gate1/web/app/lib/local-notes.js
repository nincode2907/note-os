import { validateCanonicalDocument } from '../../packages/document-engine/src/index.js';

const DATABASE_NAME = 'noteos-mvp-01';
const DATABASE_VERSION = 1;
const STORE_NAME = 'notes';

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

export class NoteDocumentError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'NoteDocumentError';
    this.issues = issues;
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
  };
}

function assertExpectedRevision(revision) {
  if (!Number.isInteger(revision) || revision < 0) throw new TypeError('An expected note revision is required.');
}

function validateNoteDocument(document, allowUnsupported) {
  const result = validateCanonicalDocument(document);
  if (result.status === 'invalid' || (!allowUnsupported && result.status !== 'supported')) {
    const message = result.issues?.[0]?.message ?? 'The note document cannot be safely written.';
    throw new NoteDocumentError(message, result.issues ?? []);
  }
  return result;
}

function assertNoteRecord(note, { allowUnsupported = false } = {}) {
  if (!note || typeof note.id !== 'string' || !note.id.trim()) throw new TypeError('A note requires a stable ID.');
  if (typeof note.title !== 'string') throw new TypeError('A note title must be a string.');
  if (!Number.isInteger(note.schemaVersion) || note.schemaVersion < 1) throw new TypeError('A note requires a supported record schema version.');
  if (!Number.isFinite(note.createdAt) || !Number.isFinite(note.updatedAt)) throw new TypeError('A note requires valid creation and update timestamps.');
  if (!['active', 'archived', 'trashed'].includes(note.lifecycle)) throw new TypeError('A note requires a valid lifecycle.');
  if (!Number.isInteger(note.revision) || note.revision < 0) throw new TypeError('A note requires a valid revision.');
  validateNoteDocument(note.document, allowUnsupported);
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
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('lifecycle', 'lifecycle', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
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
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const done = transactionResult(transaction);
    const store = transaction.objectStore(STORE_NAME);
    try {
      const current = await requestResult(store.get(id));
      if (!current) throw abort(transaction, new NoteNotFoundError(id));
      if (current.revision !== expectedRevision) throw abort(transaction, new NoteConflictError());
      if (current.lifecycle !== 'trashed') throw abort(transaction, new NoteStateError('Only trashed notes can be permanently deleted.'));
      store.delete(id);
      await done;
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

  return { list, get, create, save, setLifecycle, deleteForever, importNotes };
}
