import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalJson, SYNC_LIMITS, validateSummaries } from './sync-protocol.mjs';
import { assertNoteRecord } from './note-validation.mjs';

const DB = 'noteos-mvp-01';
const result = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Cannot inspect local data')); });

export function noteSummary(note, recordings = []) {
  assertNoteRecord(note, { allowUnsupported: true });
  // Preserve unknown semantic fields. Client CAS and clock fields are not server versions/content.
  const { id, revision, createdAt, updatedAt, ...content } = note;
  const encoded = new TextEncoder().encode(canonicalJson(content));
  if (encoded.length > 2 * 1024 * 1024) throw new Error('A note exceeds the preview hashing limit');
  return { id, localRevision: revision, lifecycle: note.lifecycle, contentHash: Array.from(sha256(encoded), b => b.toString(16).padStart(2, '0')).join(''), recordingCount: recordings.filter(r => r.noteId === id).length };
}

// No createNotesRepository call: opening it could create/upgrade a database.
export async function discoverLocal(factory = globalThis.indexedDB) {
  if (!factory?.databases) throw new Error('Read-only discovery is unavailable in this browser. Your local notes are unchanged.');
  if (!(await factory.databases()).some(db => db.name === DB)) return { noteCount: 0, recordingCount: 0, excludedCount: 0, records: [], databasePresent: false };
  const db = await new Promise((resolve, reject) => {
    const req = factory.open(DB);
    req.onupgradeneeded = () => { req.transaction.abort(); reject(new Error('Database creation is forbidden during discovery')); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('Cannot inspect local database'));
  });
  try {
    if (!db.objectStoreNames.contains('notes') || !db.objectStoreNames.contains('recordings')) throw new Error('Unknown local database schema; discovery stopped');
    const hasEnrollment = db.objectStoreNames.contains('syncEnrollment');
    const tx = db.transaction(['notes','recordings', ...(hasEnrollment ? ['syncEnrollment'] : [])], 'readonly');
    const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(new Error('Read-only snapshot failed')); });
    const notesStore = tx.objectStore('notes'), audioStore = tx.objectStore('recordings');
    const [noteCount, recordingCount, notes, recordings, enrollments] = await Promise.all([
      result(notesStore.count()), result(audioStore.count()), result(notesStore.getAll(undefined, SYNC_LIMITS.maxRecords + 1)), result(audioStore.getAll(undefined, 10001)), hasEnrollment ? result(tx.objectStore('syncEnrollment').getAll()) : Promise.resolve([]),
    ]);
    await done;
    if (notes.length > SYNC_LIMITS.maxRecords || recordings.length > 10000) throw new Error('Local library exceeds this milestone’s preview capacity. No data was sent.');
    // Missing/DEVICE_ONLY privacy never implicitly becomes server-eligible.
    const enrollmentMap = new Map(enrollments.filter(row => row.optedIn).map(row => [row.id,true]));
    const eligible = notes.filter(note => note.privacy !== 'DEVICE_ONLY' && (['PRIVATE_SERVER','CLOUD_ALLOWED'].includes(note.privacy) || enrollmentMap.has(note.id)));
    const records = eligible.map(note => noteSummary(note, recordings));
    const candidates = notes.filter(note => note.privacy !== 'DEVICE_ONLY' && note.schemaVersion === 1 && note.document?.schemaVersion === 1 && !recordings.some(recording => recording.noteId === note.id))
      .map(note => ({ id: note.id, title: typeof note.title === 'string' ? note.title : 'Untitled note', lifecycle: note.lifecycle, hasPrivacy: ['PRIVATE_SERVER','CLOUD_ALLOWED','DEVICE_ONLY'].includes(note.privacy), enrolled: enrollmentMap.has(note.id) }));
    validateSummaries({ protocolVersion: 1, records });
    return { noteCount, recordingCount, excludedCount: notes.length - eligible.length, records, candidates, databasePresent: true };
  } finally { db.close(); }
}
