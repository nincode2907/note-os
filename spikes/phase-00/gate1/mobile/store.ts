import * as SQLite from 'expo-sqlite';
import { assertNoteRecord, validateNoteDocument } from '../web/app/lib/note-validation.mjs';
import { normalizeTagList } from '../web/app/lib/note-organization.mjs';
import { ArchiveOperationGate, canTransitionLifecycle, commitThenClearDraft } from './mobile-safety.mjs';
import { commitArchiveBatch, migrateArchiveSchema } from './archive-store.mjs';
import { commitQuickCaptureNote, commitQuickVoicePending, deleteQuickCaptureDraft, migrateQuickCaptureSchema, upsertQuickCaptureDraft } from './quick-capture-store.mjs';

export type Lifecycle = 'active' | 'archived' | 'trashed';
export type Note = { id: string; title: string; document: any; schemaVersion: number; createdAt: number; updatedAt: number; lifecycle: Lifecycle; revision: number; pinned: boolean; tags: string[]; [key: string]: any };
export type Recording = { id: string; note_id: string; title: string; file_uri: string; status: 'complete' | 'interrupted'; created_at: number };
export type RecoveryDraft = { version: 1; baseRevision: number; title: string; document: any; tagsText: string; pinned: boolean };
export type RecordingArchiveMetadata = { mimeType: string; ownerId: string; updatedAt: number; durationMs: number; durationKnown: boolean; sourcePlatform: 'ios' | 'web'; sourceRecording?: Record<string, unknown>; sourceChunkDescriptors?: unknown[]; mediaSha256?: string | null };
export class RevisionConflictError extends Error { constructor() { super('This note changed elsewhere. Reload it before saving.'); this.name = 'RevisionConflictError'; } }
export class RecoveryConflictError extends Error { constructor() { super('A recovery draft belongs to a different note revision and was preserved.'); this.name = 'RecoveryConflictError'; } }

let dbPromise: Promise<SQLite.SQLiteDatabase> | undefined;
const archiveOperationGate = new ArchiveOperationGate();
export const beginRecordingFinalization = () => archiveOperationGate.beginFinalization();
export const beginFullArchiveOperation = () => archiveOperationGate.beginExport();
const db = () => dbPromise ??= SQLite.openDatabaseAsync('noteos-mvp04.db').then(async value => { await value.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;'); await migrate(value); return value; }).catch(error => { dbPromise = undefined; throw error; });

async function migrate(database: SQLite.SQLiteDatabase) {
  let version = (await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
  if (version < 1) await database.withExclusiveTransactionAsync(async txn => {
    await txn.execAsync(`CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL, revision INTEGER NOT NULL,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived','trashed')), updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notes_lifecycle_updated ON notes(lifecycle, updated_at DESC);
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY NOT NULL, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        title TEXT NOT NULL, file_uri TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('complete','interrupted')), created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recordings_note ON recordings(note_id, created_at DESC); PRAGMA user_version = 1;`);
  });
  version = (await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
  if (version < 2) await database.withExclusiveTransactionAsync(async txn => {
    await txn.execAsync(`CREATE TABLE IF NOT EXISTS recovery_drafts (note_id TEXT PRIMARY KEY NOT NULL, base_revision INTEGER NOT NULL, draft_json TEXT NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS file_cleanup (file_uri TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL); PRAGMA user_version = 2;`);
  });
  await migrateArchiveSchema(database);
  await migrateQuickCaptureSchema(database);
}
function rawRecord(note: Note): string { return JSON.stringify(note); }
function decode(row: { record_json: string }): Note {
  const note = JSON.parse(row.record_json); assertNoteRecord(note, { allowUnsupported: true });
  // Defaults exist only in the read model. Legacy canonical JSON remains byte-for-byte untouched until an explicit edit.
  return { ...note, pinned: note.pinned === true, tags: Array.isArray(note.tags) ? note.tags : [] };
}
function requireWriteableDocument(note: Note) { assertNoteRecord(note, { allowUnsupported: false }); }
async function getRaw(txn: SQLite.SQLiteDatabase, id: string) { return txn.getFirstAsync<{ record_json: string; revision: number; lifecycle: Lifecycle }>('SELECT record_json, revision, lifecycle FROM notes WHERE id = ?', id); }

export async function listNotes(): Promise<Note[]> { const database = await db(); const rows = await database.getAllAsync<{record_json:string}>('SELECT record_json FROM notes'); return rows.map(decode); }
export async function getNote(id: string): Promise<Note | null> { const database = await db(); const row = await database.getFirstAsync<{record_json:string}>('SELECT record_json FROM notes WHERE id = ?', id); return row ? decode(row) : null; }
export async function exportNotes(): Promise<Note[]> { return listNotes(); }
export async function listRecordings(noteId: string): Promise<Recording[]> { const database = await db(); return database.getAllAsync<Recording>('SELECT id,note_id,title,file_uri,status,created_at FROM recordings WHERE note_id = ? ORDER BY created_at DESC', noteId); }
export async function listAllRecordings(): Promise<Recording[]> { const database = await db(); return database.getAllAsync<Recording>('SELECT id,note_id,title,file_uri,status,created_at FROM recordings ORDER BY id'); }

export async function createNote(note: Note) { requireWriteableDocument(note); const database = await db(); await database.withExclusiveTransactionAsync(async txn => { await txn.runAsync('INSERT INTO notes(id,record_json,revision,lifecycle,updated_at) VALUES(?,?,?,?,?)', note.id, rawRecord(note), note.revision, note.lifecycle, note.updatedAt); }); }
export async function createQuickCaptureNote(note: Note): Promise<{note:Note;created:boolean}> {
  requireWriteableDocument(note);
  const database = await db();
  let outcome!: {note:Note;created:boolean};
  await database.withExclusiveTransactionAsync(async txn => { outcome = await commitQuickCaptureNote(txn, note); });
  return outcome;
}
export async function getQuickCaptureDraft(draftId = 'home') {
  const database = await db();
  const row = await database.getFirstAsync<{body:string;sequence:number;note_json:string|null}>('SELECT body,sequence,note_json FROM quick_capture_drafts WHERE draft_id=?', draftId);
  return row ? { body: row.body, sequence: row.sequence, note: row.note_json ? JSON.parse(row.note_json) : null } : null;
}
export async function persistQuickCaptureDraft(body: string, sequence: number, note: Note | null = null, draftId = 'home') {
  if (typeof body !== 'string' || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Quick Capture draft metadata is invalid.');
  if (note) requireWriteableDocument(note);
  const database = await db();
  await database.withExclusiveTransactionAsync(async txn => { await upsertQuickCaptureDraft(txn, { draftId, body, sequence, noteJson: note ? rawRecord(note) : null }); });
}
export async function clearQuickCaptureDraft(sequence: number, draftId = 'home') {
  const database = await db();
  await database.withExclusiveTransactionAsync(txn => deleteQuickCaptureDraft(txn, { draftId, sequence }));
}
export async function journalQuickVoiceCapture(note: Note, recording: Recording, metadata: RecordingArchiveMetadata) {
  const database = await db();
  await database.withExclusiveTransactionAsync(async txn => {
    const existing = await txn.getFirstAsync<{note_json:string;recording_json:string}>('SELECT note_json,recording_json FROM quick_voice_pending WHERE recording_id=?', recording.id);
    const noteJson = rawRecord(note), recordingJson = JSON.stringify(recording);
    if (existing) {
      if (existing.note_json !== noteJson || existing.recording_json !== recordingJson) throw new Error('A different Quick Voice recovery journal already uses this recording ID.');
      return;
    }
    await txn.runAsync('INSERT INTO quick_voice_pending(recording_id,note_json,recording_json,metadata_json,created_at) VALUES(?,?,?,?,?)', recording.id, noteJson, recordingJson, JSON.stringify(metadata), Date.now());
  });
}
export async function commitQuickVoiceCapture(recordingId: string) {
  const database = await db();
  let outcome: Awaited<ReturnType<typeof commitQuickVoicePending>> = null;
  await database.withExclusiveTransactionAsync(async txn => { outcome = await commitQuickVoicePending(txn, recordingId); });
  return outcome;
}
export async function listPendingQuickVoiceCaptures() {
  const database = await db();
  return database.getAllAsync<{recording_id:string;note_json:string;recording_json:string;metadata_json:string}>('SELECT recording_id,note_json,recording_json,metadata_json FROM quick_voice_pending ORDER BY created_at');
}
export async function saveNote(note: Note, expectedRevision: number): Promise<{ note: Note; recoveryJournalCleared: boolean; recoveryJournalError?: string }> {
  if (note.schemaVersion !== 1) throw new Error('Only active schema-v1 notes can be edited in this prototype.');
  requireWriteableDocument(note); const database = await db(); const updated = { ...note, tags: normalizeTagList(note.tags ?? []), revision: expectedRevision + 1, updatedAt: Date.now() };
  const outcome = await commitThenClearDraft(
    async () => {
      await database.withExclusiveTransactionAsync(async txn => {
        const current = await getRaw(txn, note.id);
        if (!current || current.revision !== expectedRevision) throw new RevisionConflictError();
        const currentNote = decode(current);
        if (currentNote.schemaVersion !== 1) throw new Error('Only schema-v1 notes can be edited in this prototype.');
        requireWriteableDocument(currentNote);
        if (current.lifecycle !== 'active' || currentNote.lifecycle !== 'active' || note.lifecycle !== 'active') throw new Error('Only active notes can be edited. Restore this note first.');
        const result = await txn.runAsync('UPDATE notes SET record_json=?,revision=?,lifecycle=?,updated_at=? WHERE id=? AND revision=? AND lifecycle=?', rawRecord(updated), updated.revision, updated.lifecycle, updated.updatedAt, updated.id, expectedRevision, 'active');
        if (result.changes !== 1) throw new RevisionConflictError();
      });
      return updated;
    },
    async () => {
      await database.withExclusiveTransactionAsync(async txn => {
        const row = await txn.getFirstAsync<{base_revision:number}>('SELECT base_revision FROM recovery_drafts WHERE note_id=?', note.id);
        if (!row) return;
        if (row.base_revision !== expectedRevision) throw new RecoveryConflictError();
        await txn.runAsync('DELETE FROM recovery_drafts WHERE note_id=? AND base_revision=?', note.id, expectedRevision);
      });
    }
  );
  return { note: updated, recoveryJournalCleared: outcome.cleared, ...(outcome.error ? { recoveryJournalError: String(outcome.error) } : {}) };
}
export async function setPinned(id: string, pinned: boolean, expectedRevision: number): Promise<Note> {
  const database = await db(); let updated!: Note;
  await database.withExclusiveTransactionAsync(async txn => { const row = await getRaw(txn, id); if (!row || row.revision !== expectedRevision) throw new RevisionConflictError(); const note = decode(row); if (note.schemaVersion !== 1) throw new Error('Pinning is unavailable for a future note schema.'); validateNoteDocument(note.document, false); updated = { ...note, pinned, revision: expectedRevision + 1 }; const result = await txn.runAsync('UPDATE notes SET record_json=?,revision=? WHERE id=? AND revision=?', rawRecord(updated), updated.revision, id, expectedRevision); if (result.changes !== 1) throw new RevisionConflictError(); }); return updated;
}
export async function setLifecycle(id: string, lifecycle: Lifecycle, expectedRevision: number): Promise<Note> {
  const database = await db(); let updated!: Note;
  await database.withExclusiveTransactionAsync(async txn => { const row = await getRaw(txn, id); if (!row || row.revision !== expectedRevision) throw new RevisionConflictError(); const note = decode(row); if (!canTransitionLifecycle(note.lifecycle, lifecycle)) throw new Error('A trashed note cannot be archived. Restore it first.'); updated = { ...note, lifecycle, revision: expectedRevision + 1, updatedAt: Date.now() }; const result = await txn.runAsync('UPDATE notes SET record_json=?,revision=?,lifecycle=?,updated_at=? WHERE id=? AND revision=?', rawRecord(updated), updated.revision, lifecycle, updated.updatedAt, id, expectedRevision); if (result.changes !== 1) throw new RevisionConflictError(); }); return updated;
}
export async function importNotes(notes: Note[]) {
  const clean = notes.map(note => { assertNoteRecord(note, { allowUnsupported: true }); return note; }); const ids = new Set<string>(); for (const note of clean) { if (ids.has(note.id)) throw new Error(`Backup contains duplicate note ID ${note.id}.`); ids.add(note.id); }
  const database = await db(); await database.withExclusiveTransactionAsync(async txn => { for (const note of clean) { const exists = await txn.getFirstAsync('SELECT id FROM notes WHERE id=?', note.id); if (exists) throw new Error(`A note with ID ${note.id} already exists. Import was rolled back.`); } for (const note of clean) await txn.runAsync('INSERT INTO notes(id,record_json,revision,lifecycle,updated_at) VALUES(?,?,?,?,?)', note.id, rawRecord(note), note.revision, note.lifecycle, note.updatedAt); });
}
function inferArchiveMetadata(recording: Recording): RecordingArchiveMetadata {
  const ext = recording.file_uri.split(/[?#]/u)[0].split('.').at(-1)?.toLowerCase();
  const mimeType = ({ webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', mp3: 'audio/mpeg', aac: 'audio/aac', flac: 'audio/flac' } as Record<string, string>)[ext ?? ''] ?? 'audio/mp4';
  return { mimeType, ownerId: 'ios-local', updatedAt: recording.created_at, durationMs: 0, durationKnown: false, sourcePlatform: 'ios' };
}
export function recordingArchiveMetadata(recording: Recording): RecordingArchiveMetadata { return inferArchiveMetadata(recording); }
export async function saveRecording(recording: Recording, archiveMetadata: RecordingArchiveMetadata = inferArchiveMetadata(recording)) {
  const database = await db(); await database.withExclusiveTransactionAsync(async txn => {
    await txn.runAsync('INSERT INTO recordings(id,note_id,title,file_uri,status,created_at) VALUES(?,?,?,?,?,?)', recording.id, recording.note_id, recording.title, recording.file_uri, recording.status, recording.created_at);
    await txn.runAsync('INSERT INTO recording_archive_metadata(recording_id,metadata_json) VALUES(?,?)', recording.id, JSON.stringify(archiveMetadata));
  });
}
/** Snapshot all note and recording metadata in one short SQLite transaction. File bytes are read only after this transaction closes. */
export async function snapshotFullArchive() {
  const database = await db(); let notes: Note[] = [], recordings: (Recording & { archiveMetadata: RecordingArchiveMetadata })[] = [];
  await database.withExclusiveTransactionAsync(async txn => {
    const noteRows = await txn.getAllAsync<{record_json:string}>('SELECT record_json FROM notes');
    const recordingRows = await txn.getAllAsync<Recording & { metadata_json?: string }>(`SELECT r.id,r.note_id,r.title,r.file_uri,r.status,r.created_at,m.metadata_json
      FROM recordings r LEFT JOIN recording_archive_metadata m ON m.recording_id=r.id ORDER BY r.id`);
    notes = noteRows.map(row => { const note = JSON.parse(row.record_json); assertNoteRecord(note, { allowUnsupported: true }); return note; });
    recordings = recordingRows.map(row => { const { metadata_json, ...recording } = row; return { ...recording, archiveMetadata: metadata_json ? JSON.parse(metadata_json) : inferArchiveMetadata(recording) }; });
  });
  return { notes, recordings };
}
export async function listArchiveImports(): Promise<{importId:string;state:'staged'|'committed';files:Array<{stagedUri:string;finalUri:string;recordingId:string;size:number;sha256:string}>}[]> {
  const database = await db(); const rows = await database.getAllAsync<{import_id:string;state:'staged'|'committed';files_json:string}>('SELECT import_id,state,files_json FROM archive_imports ORDER BY created_at');
  return rows.map(row => ({ importId: row.import_id, state: row.state, files: JSON.parse(row.files_json) }));
}
export async function recordArchiveImport(importId: string, files: Array<{stagedUri:string;finalUri:string;recordingId:string;size:number;sha256:string}>) {
  const database = await db(); await database.withExclusiveTransactionAsync(async txn => { await txn.runAsync('INSERT INTO archive_imports(import_id,state,files_json,created_at) VALUES(?,?,?,?)', importId, 'staged', JSON.stringify(files), Date.now()); });
}
export async function finishArchiveImport(importId: string) { const database = await db(); await database.withExclusiveTransactionAsync(async txn => { await txn.runAsync('DELETE FROM archive_imports WHERE import_id=?', importId); }); }
export async function commitFullArchiveImport(importId: string, notes: Note[], rows: Array<{recording:Record<string,any>;file:string|null;chunks:unknown[]}>, acceptedFiles: Array<{recordingId:string;finalUri:string;sha256:string;size:number}>, sourcePlatform: 'ios'|'web') {
  const database = await db(); await database.withExclusiveTransactionAsync(txn => commitArchiveBatch(txn, { importId, notes, rows, acceptedFiles, sourcePlatform }));
}
export async function renameRecording(id: string, title: string) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw new Error('Recording title must contain 1–120 characters.');
  const database = await db(); await database.withExclusiveTransactionAsync(async txn => {
    const result = await txn.runAsync('UPDATE recordings SET title=? WHERE id=?', title.trim(), id);
    if (result.changes !== 1) throw new Error('Recording no longer exists.');
    const row = await txn.getFirstAsync<{metadata_json:string}>('SELECT metadata_json FROM recording_archive_metadata WHERE recording_id=?', id);
    if (row) {
      const metadata = JSON.parse(row.metadata_json); metadata.updatedAt = Date.now();
      if (metadata.sourceRecording) metadata.sourceRecording = { ...metadata.sourceRecording, title: title.trim(), updatedAt: metadata.updatedAt };
      await txn.runAsync('UPDATE recording_archive_metadata SET metadata_json=? WHERE recording_id=?', JSON.stringify(metadata), id);
    }
  });
}
export async function removeRecording(id: string): Promise<string> {
  const database = await db(); let uri = '';
  await database.withExclusiveTransactionAsync(async txn => { const row = await txn.getFirstAsync<{file_uri:string}>('SELECT file_uri FROM recordings WHERE id=?', id); if (!row) throw new Error('Recording no longer exists.'); uri = row.file_uri; await txn.runAsync('INSERT OR IGNORE INTO file_cleanup(file_uri,created_at) VALUES(?,?)', uri, Date.now()); const result = await txn.runAsync('DELETE FROM recordings WHERE id=?', id); if (result.changes !== 1) throw new Error('Recording metadata changed before deletion.'); }); return uri;
}
export async function permanentlyDeleteNote(id: string, expectedRevision: number): Promise<string[]> {
  const database = await db(); let uris: string[] = [];
  await database.withExclusiveTransactionAsync(async txn => { const row = await getRaw(txn, id); if (!row || row.revision !== expectedRevision) throw new RevisionConflictError(); if (row.lifecycle !== 'trashed') throw new Error('Only a trashed note can be permanently deleted.'); uris = (await txn.getAllAsync<{file_uri:string}>('SELECT file_uri FROM recordings WHERE note_id=?', id)).map(item => item.file_uri); for (const uri of uris) await txn.runAsync('INSERT OR IGNORE INTO file_cleanup(file_uri,created_at) VALUES(?,?)', uri, Date.now()); await txn.runAsync('DELETE FROM recovery_drafts WHERE note_id=?', id); await txn.runAsync('DELETE FROM recordings WHERE note_id=?', id); const result = await txn.runAsync('DELETE FROM notes WHERE id=? AND revision=? AND lifecycle=?', id, expectedRevision, 'trashed'); if (result.changes !== 1) throw new RevisionConflictError(); }); return uris;
}
export async function listPendingFileCleanups(): Promise<string[]> { const database = await db(); return (await database.getAllAsync<{file_uri:string}>('SELECT file_uri FROM file_cleanup ORDER BY created_at')).map(row => row.file_uri); }
export async function markFileCleanupDone(uri: string) { const database = await db(); await database.withExclusiveTransactionAsync(async txn => { await txn.runAsync('DELETE FROM file_cleanup WHERE file_uri=?', uri); }); }

export async function saveRecoveryDraft(noteId: string, baseRevision: number, draft: RecoveryDraft) {
  if (draft.version !== 1 || draft.baseRevision !== baseRevision) throw new Error('Recovery draft version or base revision is invalid.'); validateNoteDocument(draft.document, false);
  const database = await db(); await database.withExclusiveTransactionAsync(async txn => { const noteRow = await getRaw(txn, noteId); if (!noteRow || noteRow.revision !== baseRevision || noteRow.lifecycle !== 'active') throw new RecoveryConflictError(); const old = await txn.getFirstAsync<{base_revision:number}>('SELECT base_revision FROM recovery_drafts WHERE note_id=?', noteId); if (old && old.base_revision !== baseRevision) throw new RecoveryConflictError(); await txn.runAsync('INSERT INTO recovery_drafts(note_id,base_revision,draft_json,updated_at,version) VALUES(?,?,?,?,1) ON CONFLICT(note_id) DO UPDATE SET draft_json=excluded.draft_json,updated_at=excluded.updated_at WHERE recovery_drafts.base_revision=excluded.base_revision', noteId, baseRevision, JSON.stringify(draft), Date.now()); });
}
export async function getRecoveryDraft(noteId: string): Promise<{baseRevision:number; draft:RecoveryDraft} | null> { const database = await db(); const row = await database.getFirstAsync<{base_revision:number;draft_json:string;version:number}>('SELECT base_revision,draft_json,version FROM recovery_drafts WHERE note_id=?', noteId); if (!row) return null; const draft = JSON.parse(row.draft_json); if (row.version !== 1 || draft.version !== 1) throw new Error('This recovery draft uses an unknown version and was preserved.'); return { baseRevision: row.base_revision, draft }; }
export async function discardRecoveryDraft(noteId: string, baseRevision: number) { const database = await db(); await database.withExclusiveTransactionAsync(async txn => { const row = await txn.getFirstAsync<{base_revision:number}>('SELECT base_revision FROM recovery_drafts WHERE note_id=?', noteId); if (!row) return; if (row.base_revision !== baseRevision) throw new RecoveryConflictError(); await txn.runAsync('DELETE FROM recovery_drafts WHERE note_id=? AND base_revision=?', noteId, baseRevision); }); }
