import { assertNoteRecord, validateNoteDocument } from './note-validation.mjs';
import { normalizeTagList } from './note-organization.mjs';
import { requireVerifiedArchive } from './archive-v2.mjs';
import { addAudioAnchor, deleteAudioAnchor, emptyAudioAnchorSet, renameAudioAnchor, validateAudioAnchorSet } from './audio-anchors.mjs';
import { canonicalJson } from './sync-protocol.mjs';
export { NoteDocumentError } from './note-validation.mjs';

const DATABASE_NAME = 'noteos-mvp-01';
const DATABASE_VERSION = 4;
const STORE_NAME = 'notes';
const RECORDINGS_STORE = 'recordings';
const RECORDING_CHUNKS_STORE = 'recordingChunks';
const SYNC_OUTBOX_STORE = 'syncOutbox';
const SYNC_BASELINES_STORE = 'syncBaselines';
const SYNC_STATE_STORE = 'syncState';
const SYNC_CONFLICTS_STORE = 'syncConflicts';
const SYNC_ENROLLMENT_STORE = 'syncEnrollment';
const SYNC_QUARANTINE_STORE = 'syncQuarantine';

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

function notifyLocalCommit() {
  try { globalThis.dispatchEvent?.(new Event('noteos:local-note-commit')); } catch {}
  try { const channel = new BroadcastChannel('noteos-local-commits'); channel.postMessage({ type: 'committed' }); channel.close(); } catch {}
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
          if (!database.objectStoreNames.contains(SYNC_OUTBOX_STORE)) database.createObjectStore(SYNC_OUTBOX_STORE, { keyPath: 'operationId' });
          if (!database.objectStoreNames.contains(SYNC_BASELINES_STORE)) database.createObjectStore(SYNC_BASELINES_STORE, { keyPath: 'id' });
          if (!database.objectStoreNames.contains(SYNC_STATE_STORE)) database.createObjectStore(SYNC_STATE_STORE, { keyPath: 'key' });
          if (!database.objectStoreNames.contains(SYNC_CONFLICTS_STORE)) database.createObjectStore(SYNC_CONFLICTS_STORE, { keyPath: 'id' });
          if (!database.objectStoreNames.contains(SYNC_ENROLLMENT_STORE)) database.createObjectStore(SYNC_ENROLLMENT_STORE, { keyPath: 'id' });
          if (!database.objectStoreNames.contains(SYNC_QUARANTINE_STORE)) database.createObjectStore(SYNC_QUARANTINE_STORE, { keyPath: 'operationId' });
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

  async function hasExistingDatabase() {
    if (!indexedDBFactory?.databases) return false;
    return (await indexedDBFactory.databases()).some(database => database.name === databaseName);
  }

  async function enqueueMutation(transaction, note, { remote = false, optedIn = false } = {}) {
    const enrollments = transaction.objectStore(SYNC_ENROLLMENT_STORE);
    const preferences = transaction.objectStore(SYNC_STATE_STORE);
    const [enrollment, preference, recordings] = await Promise.all([
      requestResult(enrollments.get(note.id)), requestResult(preferences.get('defaultEnrollment')),
      requestResult(transaction.objectStore(RECORDINGS_STORE).index('noteId').count(note.id)),
    ]);
    if (remote || recordings > 0) return;
    const allowed = note.privacy !== 'DEVICE_ONLY' && (optedIn || enrollment?.optedIn === true || preference?.value === true);
    if (!allowed) return;
    enrollments.put({ id: note.id, optedIn: true, updatedAt: Date.now() });
    const baseline = await requestResult(transaction.objectStore(SYNC_BASELINES_STORE).get(note.id));
    const operation = { operationId: crypto.randomUUID(), entityId: note.id, localRevision: note.revision, baseServerVersion: baseline?.serverVersion ?? 0, ownerApproved: true, type: 'upsert', recordJson: canonicalJson(note), createdAt: Date.now() };
    transaction.objectStore(SYNC_OUTBOX_STORE).add(operation);
  }

  async function setSyncEnrollment(ids, optedIn = true) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new TypeError('Invalid note selection.');
    const database = await openDatabase();
    const transaction = database.transaction([STORE_NAME, RECORDINGS_STORE, SYNC_ENROLLMENT_STORE, SYNC_OUTBOX_STORE, SYNC_BASELINES_STORE, SYNC_STATE_STORE], 'readwrite');
    const done = transactionResult(transaction);
    const notes = transaction.objectStore(STORE_NAME), recordings = transaction.objectStore(RECORDINGS_STORE);
    try {
      for (const id of ids) {
        const note = await requestResult(notes.get(id));
        if (!note || note.privacy === 'DEVICE_ONLY') continue;
        if ((await requestResult(recordings.index('noteId').count(id))) > 0) continue;
        transaction.objectStore(SYNC_ENROLLMENT_STORE).put({ id, optedIn, updatedAt: Date.now() });
        if (optedIn) await enqueueMutation(transaction, note, { optedIn: true });
        else for (const operation of await requestResult(transaction.objectStore(SYNC_OUTBOX_STORE).getAll())) if (operation.entityId === id) transaction.objectStore(SYNC_OUTBOX_STORE).delete(operation.operationId);
      }
      await done;
    } catch (error) { abort(transaction, error); try { await done; } catch {} throw error; }
  }

  async function setDefaultSyncEnrollment(value) {
    const database = await openDatabase();
    const transaction = database.transaction(SYNC_STATE_STORE, 'readwrite');
    const done = transactionResult(transaction);
    transaction.objectStore(SYNC_STATE_STORE).put({ key: 'defaultEnrollment', value: Boolean(value) });
    await done;
  }

  async function listSyncOutbox(limit = 100) {
    const database = await openDatabase(); const transaction = database.transaction([SYNC_OUTBOX_STORE, RECORDINGS_STORE, STORE_NAME, SYNC_ENROLLMENT_STORE], 'readonly'); const done = transactionResult(transaction);
    const [rows, recordings, notes, enrolled] = await Promise.all([requestResult(transaction.objectStore(SYNC_OUTBOX_STORE).getAll()), requestResult(transaction.objectStore(RECORDINGS_STORE).getAll()), requestResult(transaction.objectStore(STORE_NAME).getAll()), requestResult(transaction.objectStore(SYNC_ENROLLMENT_STORE).getAll())]); await done;
    const audioNotes = new Set(recordings.map(row => row.noteId)), noteMap = new Map(notes.map(row => [row.id,row])), enrolledSet = new Set(enrolled.filter(row => row.optedIn).map(row => row.id));
    return rows.filter(row => !audioNotes.has(row.entityId) && noteMap.get(row.entityId)?.privacy !== 'DEVICE_ONLY' && enrolledSet.has(row.entityId)).sort((a,b) => a.createdAt-b.createdAt || a.entityId.localeCompare(b.entityId) || a.localRevision-b.localRevision || a.operationId.localeCompare(b.operationId)).slice(0, limit);
  }

  async function getSyncOverview() {
    const database = await openDatabase();
    const transaction = database.transaction([STORE_NAME, RECORDINGS_STORE, SYNC_OUTBOX_STORE, SYNC_BASELINES_STORE, SYNC_STATE_STORE, SYNC_CONFLICTS_STORE, SYNC_ENROLLMENT_STORE, SYNC_QUARANTINE_STORE], 'readonly');
    const done = transactionResult(transaction);
    const stores = name => transaction.objectStore(name).getAll();
    const [notes, recordings, outbox, baselines, state, conflicts, enrollments, quarantine] = await Promise.all([
      ...[STORE_NAME, RECORDINGS_STORE, SYNC_OUTBOX_STORE, SYNC_BASELINES_STORE, SYNC_STATE_STORE, SYNC_CONFLICTS_STORE, SYNC_ENROLLMENT_STORE, SYNC_QUARANTINE_STORE].map(name => requestResult(stores(name))),
    ]);
    await done;
    const noteMap = new Map(notes.map(note => [note.id, note]));
    const enrollmentSet = new Set(enrollments.filter(row => row.optedIn).map(row => row.id));
    const audioCounts = new Map();
    for (const recording of recordings) audioCounts.set(recording.noteId, (audioCounts.get(recording.noteId) ?? 0) + 1);
    const eligible = outbox.filter(row => !audioCounts.has(row.entityId) && noteMap.get(row.entityId)?.privacy !== 'DEVICE_ONLY' && enrollmentSet.has(row.entityId));
    const eligibleIds = new Set(eligible.map(row => row.operationId));
    const blocked = outbox.filter(row => !eligibleIds.has(row.operationId));
    const pendingNotes = new Set(eligible.map(row => row.entityId));
    const baselineMap = new Map(baselines.map(row => [row.id, row]));
    const conflictNotes = new Set(conflicts.map(row => row.noteId));
    const quarantinedNotes = new Set(quarantine.map(row => row.entityId));
    const noteStatuses = notes.map(note => {
      const hasAudio = (audioCounts.get(note.id) ?? 0) > 0;
      const hasConflict = conflictNotes.has(note.id) || quarantinedNotes.has(note.id);
      const pending = pendingNotes.has(note.id);
      const baseline = baselineMap.get(note.id);
      const textSynced = Boolean(baseline && baseline.localRevision >= note.revision);
      const status = hasConflict ? 'needs-review' : hasAudio ? 'media-local-only' : pending ? 'pending' : textSynced ? 'text-synced' : 'saved-device';
      return { id: note.id, status, textSynced, recordingCount: audioCounts.get(note.id) ?? 0 };
    });
    const values = Object.fromEntries(state.map(row => [row.key, row.value ?? row]));
    return {
      totalOutbox: outbox.length, eligiblePending: eligible.length, blockedPending: blocked.length,
      quarantined: quarantine.length, conflicts: conflicts.length, recordings: recordings.length,
      unfinishedRecordings: recordings.filter(row => ['recording', 'paused', 'interrupted'].includes(row.status)).length,
      mediaLocalOnly: noteStatuses.filter(row => row.status === 'media-local-only').length,
      textSyncedWithMedia: noteStatuses.filter(row => row.status === 'media-local-only' && row.textSynced).length,
      noteStatuses, conflictRecords: conflicts, quarantineRecords: quarantine,
      recovery: values.recovery ?? null, paired: values.paired === true, history: values.history ?? null,
    };
  }

  async function quarantineSyncOperation(operationId, reason = 'The server rejected this operation.') {
    const database = await openDatabase();
    const transaction = database.transaction([SYNC_OUTBOX_STORE, SYNC_QUARANTINE_STORE], 'readwrite');
    const done = transactionResult(transaction);
    const outbox = transaction.objectStore(SYNC_OUTBOX_STORE), operation = await requestResult(outbox.get(operationId));
    if (operation) {
      transaction.objectStore(SYNC_QUARANTINE_STORE).put({ ...operation, reason, quarantinedAt: Date.now(), status: 'needs-review' });
      outbox.delete(operationId);
    }
    await done;
  }

  async function saveSyncRecovery(reason, serverHistory = null) {
    const database = await openDatabase(); const transaction = database.transaction(SYNC_STATE_STORE, 'readwrite'); const done = transactionResult(transaction);
    transaction.objectStore(SYNC_STATE_STORE).put({ key: 'recovery', value: { reason, serverHistory, at: Date.now() } }); await done;
  }

  async function setSyncPaired(value) {
    const database = await openDatabase(); const transaction = database.transaction(SYNC_STATE_STORE, 'readwrite'); const done = transactionResult(transaction);
    transaction.objectStore(SYNC_STATE_STORE).put({ key: 'paired', value: Boolean(value) }); await done;
  }

  async function getSyncState() {
    const database = await openDatabase(); const transaction = database.transaction([SYNC_STATE_STORE, SYNC_CONFLICTS_STORE, SYNC_QUARANTINE_STORE], 'readonly'); const done = transactionResult(transaction);
    const [state, conflicts, quarantine] = await Promise.all([requestResult(transaction.objectStore(SYNC_STATE_STORE).getAll()), requestResult(transaction.objectStore(SYNC_CONFLICTS_STORE).getAll()), requestResult(transaction.objectStore(SYNC_QUARANTINE_STORE).getAll())]);
    await done; return { state: Object.fromEntries(state.map(row => [row.key, row.value ?? row])), conflicts, quarantine };
  }

  async function getSyncBaseline(id) {
    const database = await openDatabase(); const transaction = database.transaction(SYNC_BASELINES_STORE, 'readonly'); const done = transactionResult(transaction);
    const row = await requestResult(transaction.objectStore(SYNC_BASELINES_STORE).get(id)); await done; return row ?? null;
  }

  async function recordSyncConflict(operationId, conflict) {
    const database = await openDatabase(); const transaction = database.transaction([STORE_NAME, SYNC_OUTBOX_STORE, SYNC_BASELINES_STORE, SYNC_CONFLICTS_STORE, SYNC_QUARANTINE_STORE], 'readwrite'); const done = transactionResult(transaction);
    try {
      const outbox = transaction.objectStore(SYNC_OUTBOX_STORE), operation = await requestResult(outbox.get(operationId));
      if (operation) {
        const current = await requestResult(transaction.objectStore(STORE_NAME).get(operation.entityId));
        const remote = conflict.remote?.record;
        const conflictId = `conflict-${conflict.serverEpoch}-${operation.entityId}-${conflict.actualVersion}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0,128);
        if (remote && current && canonicalJson(remote) !== canonicalJson(current)) {
          const notes = transaction.objectStore(STORE_NAME);
          if (!(await requestResult(notes.get(conflictId)))) notes.add({ ...remote, id: conflictId, title: `${remote.title || 'Untitled note'} (Sync conflict)`, revision: 0, updatedAt: Date.now() });
          transaction.objectStore(SYNC_CONFLICTS_STORE).put({ id: conflictId, noteId: operation.entityId, conflictNoteId: conflictId, kind: 'edit-edit', localOnly: true, status: 'needs-review', localRecord: current, remoteRecord: remote, serverEpoch: conflict.serverEpoch, serverVersion: conflict.actualVersion, createdAt: Date.now() });
        } else transaction.objectStore(SYNC_CONFLICTS_STORE).put({ id: `conflict-${operation.entityId}`, noteId: operation.entityId, kind: conflict.tombstoned ? 'edit-delete' : 'id-collision', localOnly: true, status: 'needs-review', localRecord: current ?? null, remoteRecord: remote ?? null, serverEpoch: conflict.serverEpoch, serverVersion: conflict.actualVersion, createdAt: Date.now() });
        if (conflict.actualVersion > 0) transaction.objectStore(SYNC_BASELINES_STORE).put({ id: operation.entityId, serverVersion: conflict.actualVersion, localRevision: current?.revision ?? 0 });
        for (const pending of await requestResult(outbox.getAll())) if (pending.entityId === operation.entityId) {
          transaction.objectStore(SYNC_QUARANTINE_STORE).put({ ...pending, reason: 'Blocked because another device changed this note.', quarantinedAt: Date.now(), status: 'needs-review' });
          outbox.delete(pending.operationId);
        }
      }
      await done;
    } catch (error) { abort(transaction,error); try { await done; } catch {} throw error; }
  }

  async function commitSyncPull({ serverEpoch, serverCursor, changes }) {
    const database = await openDatabase();
    const transaction = database.transaction([STORE_NAME, RECORDINGS_STORE, SYNC_OUTBOX_STORE, SYNC_BASELINES_STORE, SYNC_STATE_STORE, SYNC_CONFLICTS_STORE, SYNC_ENROLLMENT_STORE, SYNC_QUARANTINE_STORE], 'readwrite');
    const done = transactionResult(transaction);
    const notes = transaction.objectStore(STORE_NAME), outbox = transaction.objectStore(SYNC_OUTBOX_STORE), baselines = transaction.objectStore(SYNC_BASELINES_STORE);
    try {
      for (const change of changes) {
        const current = await requestResult(notes.get(change.id));
        const entityOperations = (await requestResult(outbox.getAll())).filter(op => op.entityId === change.id);
        const localPending = entityOperations.length > 0;
        const localRecordings = await requestResult(transaction.objectStore(RECORDINGS_STORE).index('noteId').count(change.id));
        const remote = change.event === 'tombstone' ? null : JSON.parse(change.recordJson);
        const baseline = await requestResult(baselines.get(change.id));
        // A push can commit on the server while its ACK is lost. Pull then returns
        // the exact queued snapshot; reconcile it as an ACK before conflict handling.
        const lostAck = remote && entityOperations.find(operation => operation.localRevision === remote.revision && operation.recordJson === canonicalJson(remote));
        if (lostAck) {
          outbox.delete(lostAck.operationId);
          baselines.put({ id: change.id, serverVersion: change.serverVersion, localRevision: remote.revision, contentHash: change.contentHash, lifecycle: change.lifecycle });
          continue;
        }
        if (localRecordings > 0) {
          transaction.objectStore(SYNC_CONFLICTS_STORE).put({ id: `audio:${change.id}`, noteId: change.id, kind: 'audio-review', localOnly: true, status: 'needs-review', localRecord: current ?? null, remoteRecord: remote, serverCursor: change.cursor, serverEpoch, serverVersion: change.serverVersion, createdAt: Date.now() });
          continue;
        }
        if (current && (!baseline || localPending || current.revision !== baseline.localRevision)) {
          if (remote && canonicalJson(current) !== canonicalJson(remote)) {
            const conflictId = `conflict-${change.serverEpoch}-${change.id}-${change.serverVersion}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0,128);
            const existing = await requestResult(notes.get(conflictId));
            if (!existing) {
              const copy = { ...remote, id: conflictId, title: `${remote.title || 'Untitled note'} (Sync conflict)`, revision: 0, updatedAt: Date.now(), lifecycle: remote.lifecycle };
              notes.add(copy); transaction.objectStore(SYNC_CONFLICTS_STORE).put({ id: conflictId, noteId: change.id, conflictNoteId: conflictId, kind: 'edit-edit', localOnly: true, status: 'needs-review', localRecord: current, remoteRecord: remote, serverCursor: change.cursor, serverEpoch, serverVersion: change.serverVersion, createdAt: Date.now() });
            }
          } else if (!localPending && remote) baselines.put({ id: change.id, serverVersion: change.serverVersion, localRevision: current.revision, contentHash: change.contentHash, lifecycle: change.lifecycle });
          else if (!remote) transaction.objectStore(SYNC_CONFLICTS_STORE).put({ id: `delete:${change.id}`, noteId: change.id, kind: 'edit-delete', localOnly: true, status: 'needs-review', localRecord: current, remoteRecord: null, serverCursor: change.cursor, serverEpoch, serverVersion: change.serverVersion, createdAt: Date.now() });
          if (localPending) for (const pending of entityOperations) {
            transaction.objectStore(SYNC_QUARANTINE_STORE).put({ ...pending, reason: 'Blocked because a remote change arrived while this note had pending edits.', quarantinedAt: Date.now(), status: 'needs-review' });
            outbox.delete(pending.operationId);
          }
          continue;
        }
        if (change.event === 'tombstone') {
          if (current && current.lifecycle !== 'trashed') {
            // Text-only remote tombstones are held for review to avoid orphaning local data.
            transaction.objectStore(SYNC_CONFLICTS_STORE).put({ id: `delete:${change.id}`, noteId: change.id, kind: 'remote-delete-review', localOnly: true, status: 'needs-review', localRecord: current, remoteRecord: null, serverCursor: change.cursor, serverEpoch, serverVersion: change.serverVersion, createdAt: Date.now() });
            continue;
          }
        } else if (!current) { notes.add(remote); transaction.objectStore(SYNC_ENROLLMENT_STORE).put({ id: change.id, optedIn: true, updatedAt: Date.now() }); }
        else if (canonicalJson(current) !== canonicalJson(remote)) notes.put(remote);
        baselines.put({ id: change.id, serverVersion: change.serverVersion, localRevision: remote?.revision ?? current?.revision ?? 0, contentHash: change.contentHash, lifecycle: change.lifecycle });
      }
      transaction.objectStore(SYNC_STATE_STORE).put({ key: 'history', serverEpoch, serverCursor });
      await done;
    } catch (error) { abort(transaction, error); try { await done; } catch {} throw error; }
  }

  async function acknowledgeSyncOperations(acks, history = null) {
    const database = await openDatabase(); const transaction = database.transaction([SYNC_OUTBOX_STORE, SYNC_BASELINES_STORE, SYNC_STATE_STORE], 'readwrite'); const done = transactionResult(transaction);
    if (history !== null) {
      const previous = await requestResult(transaction.objectStore(SYNC_STATE_STORE).get('history'));
      if (typeof history.serverEpoch !== 'string' || !Number.isSafeInteger(history.serverCursor) || history.serverCursor < 0 ||
        (previous && (previous.serverEpoch !== history.serverEpoch || history.serverCursor < previous.serverCursor))) {
        const error = abort(transaction, new Error('Acknowledged server history is invalid or moved backwards. Sync recovery review is required.'));
        try { await done; } catch {}
        throw error;
      }
    }
    for (const ack of acks) { transaction.objectStore(SYNC_OUTBOX_STORE).delete(ack.operationId); transaction.objectStore(SYNC_BASELINES_STORE).put(ack.baseline); }
    if (history?.serverEpoch && Number.isSafeInteger(history.serverCursor)) transaction.objectStore(SYNC_STATE_STORE).put({ key: 'history', serverEpoch: history.serverEpoch, serverCursor: history.serverCursor });
    await done;
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
    const transaction = database.transaction([STORE_NAME, RECORDINGS_STORE, SYNC_OUTBOX_STORE, SYNC_BASELINES_STORE, SYNC_STATE_STORE, SYNC_ENROLLMENT_STORE], 'readwrite');
    const done = transactionResult(transaction);
    try {
      transaction.objectStore(STORE_NAME).add(note);
      await enqueueMutation(transaction, note);
      await done;
    } catch (error) { abort(transaction,error); try { await done; } catch {} throw error; }
    notifyLocalCommit();
    return note;
  }

  async function createIfMissing(note) {
    assertNoteRecord(note);
    const database = await openDatabase();
    const transaction = database.transaction([STORE_NAME, RECORDINGS_STORE, SYNC_OUTBOX_STORE, SYNC_BASELINES_STORE, SYNC_STATE_STORE, SYNC_ENROLLMENT_STORE], 'readwrite');
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
      await enqueueMutation(transaction, note);
      await done;
      notifyLocalCommit();
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
    const transaction = database.transaction([STORE_NAME, RECORDINGS_STORE, SYNC_OUTBOX_STORE, SYNC_BASELINES_STORE, SYNC_STATE_STORE, SYNC_ENROLLMENT_STORE], 'readwrite');
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
      await enqueueMutation(transaction, updated);
      await done;
      notifyLocalCommit();
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
    const transaction = database.transaction([STORE_NAME, RECORDINGS_STORE, SYNC_OUTBOX_STORE, SYNC_BASELINES_STORE, SYNC_STATE_STORE, SYNC_ENROLLMENT_STORE], 'readwrite');
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
      await enqueueMutation(transaction, updated);
      await done;
      notifyLocalCommit();
      return updated;
    } catch (error) { try { await done; } catch { /* Consume the transaction abort. */ } throw error; }
  }

  async function setLifecycle(id, lifecycle, expectedRevision) {
    if (!['active', 'archived', 'trashed'].includes(lifecycle)) throw new TypeError('Invalid note lifecycle.');
    assertExpectedRevision(expectedRevision);
    const database = await openDatabase();
    const transaction = database.transaction([STORE_NAME, RECORDINGS_STORE, SYNC_OUTBOX_STORE, SYNC_BASELINES_STORE, SYNC_STATE_STORE, SYNC_ENROLLMENT_STORE], 'readwrite');
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
      await enqueueMutation(transaction, updated);
      await done;
      notifyLocalCommit();
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

  return { list, get, hasExistingDatabase, create, createIfMissing, save, updateOrganization, setLifecycle, deleteForever, importNotes, snapshotArchive, importArchive, setSyncEnrollment, setDefaultSyncEnrollment, listSyncOutbox, getSyncState, getSyncOverview, quarantineSyncOperation, getSyncBaseline, setSyncPaired, saveSyncRecovery, recordSyncConflict, commitSyncPull, acknowledgeSyncOperations };
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
    const tx = database.transaction([STORE_NAME, RECORDINGS_STORE, SYNC_OUTBOX_STORE, SYNC_QUARANTINE_STORE], 'readwrite');
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
      const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
      for (const operation of await requestResult(outbox.getAll())) if (operation.entityId === noteId) {
        tx.objectStore(SYNC_QUARANTINE_STORE).put({ ...operation, reason: 'Text sync paused because this note now has local-only audio.', quarantinedAt: Date.now(), status: 'needs-review' });
        outbox.delete(operation.operationId);
      }
      await done;
      notifyLocalCommit();
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
      store.put(updated); await done; notifyLocalCommit(); return updated;
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
  async function updateAnchors(recordingId, update) {
    const database = await openDatabase(), tx = database.transaction(RECORDINGS_STORE, 'readwrite'), done = transactionResult(tx), store = tx.objectStore(RECORDINGS_STORE);
    try {
      const recording = await requestResult(store.get(recordingId));
      if (!recording) throw abort(tx, new NoteNotFoundError(recordingId));
      const current = validateAudioAnchorSet(recording.audioAnchors, recordingId, { durationMs: recording.durationMs, durationKnown: !['recording', 'paused'].includes(recording.status) && recording.durationMs > 0 && recording.nativeProvenance?.durationKnown !== false });
      const audioAnchors = update(current, recording);
      const updated = { ...recording, audioAnchors };
      store.put(updated); await done; return updated;
    } catch (error) { try { await done; } catch { /* Consume transaction abort before returning the original error. */ } throw error; }
  }
  async function listAnchors(recordingId) {
    const recording = await get(recordingId);
    return recording ? validateAudioAnchorSet(recording.audioAnchors, recordingId, { durationMs: recording.durationMs, durationKnown: !['recording', 'paused'].includes(recording.status) && recording.durationMs > 0 && recording.nativeProvenance?.durationKnown !== false }).items : [];
  }
  async function addAnchor(recordingId, anchor) {
    return updateAnchors(recordingId, (current, recording) => addAudioAnchor(current, anchor, recordingId, { durationMs: recording.durationMs, durationKnown: !['recording', 'paused'].includes(recording.status) && recording.durationMs > 0 && recording.nativeProvenance?.durationKnown !== false }));
  }
  async function renameAnchor(recordingId, anchorId, label) {
    return updateAnchors(recordingId, (current, recording) => renameAudioAnchor(current, anchorId, label, recordingId, { durationMs: recording.durationMs, durationKnown: !['recording', 'paused'].includes(recording.status) && recording.durationMs > 0 && recording.nativeProvenance?.durationKnown !== false }));
  }
  async function removeAnchor(recordingId, anchorId) {
    return updateAnchors(recordingId, current => deleteAudioAnchor(current, anchorId, recordingId));
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
      recordings.delete(recordingId); await done; notifyLocalCommit(); return recording;
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
  return { list, listUnfinished, get, create, appendChunk, setStatus, rename, chunks, listAnchors, addAnchor, renameAnchor, removeAnchor, remove, recover };
}
