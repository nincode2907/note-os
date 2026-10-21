import * as SQLite from 'expo-sqlite';
import { assertNoteRecord, validateNoteDocument } from '../web/app/lib/note-validation.mjs';
import { normalizeTagList } from '../web/app/lib/note-organization.mjs';
import { canTransitionLifecycle } from './mobile-safety.mjs';

export type Lifecycle = 'active' | 'archived' | 'trashed';
export type Note = { id: string; title: string; document: any; schemaVersion: number; createdAt: number; updatedAt: number; lifecycle: Lifecycle; revision: number; pinned: boolean; tags: string[]; [key: string]: any };
export type Recording = { id: string; note_id: string; title: string; file_uri: string; status: 'complete' | 'interrupted'; created_at: number };
export type RecoveryDraft = { version: 1; baseRevision: number; title: string; document: any; tagsText: string; pinned: boolean };
export class RevisionConflictError extends Error { constructor() { super('This note changed elsewhere. Reload it before saving.'); this.name = 'RevisionConflictError'; } }
export class RecoveryConflictError extends Error { constructor() { super('A recovery draft belongs to a different note revision and was preserved.'); this.name = 'RecoveryConflictError'; } }

let dbPromise: Promise<SQLite.SQLiteDatabase> | undefined;
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

export async function createNote(note: Note) { requireWriteableDocument(note); const database = await db(); await database.withExclusiveTransactionAsync(async txn => { await txn.runAsync('INSERT INTO notes(id,record_json,revision,lifecycle,updated_at) VALUES(?,?,?,?,?)', note.id, rawRecord(note), note.revision, note.lifecycle, note.updatedAt); }); }
export async function saveNote(note: Note, expectedRevision: number): Promise<Note> {
  requireWriteableDocument(note); const database = await db(); const updated = { ...note, tags: normalizeTagList(note.tags ?? []), revision: expectedRevision + 1, updatedAt: Date.now() };
  await database.withExclusiveTransactionAsync(async txn => { const result = await txn.runAsync('UPDATE notes SET record_json=?,revision=?,lifecycle=?,updated_at=? WHERE id=? AND revision=?', rawRecord(updated), updated.revision, updated.lifecycle, updated.updatedAt, updated.id, expectedRevision); if (result.changes !== 1) throw new RevisionConflictError(); await txn.runAsync('DELETE FROM recovery_drafts WHERE note_id=? AND base_revision=?', note.id, expectedRevision); });
  return updated;
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
export async function saveRecording(recording: Recording) { const database = await db(); await database.withExclusiveTransactionAsync(async txn => { await txn.runAsync('INSERT INTO recordings(id,note_id,title,file_uri,status,created_at) VALUES(?,?,?,?,?,?)', recording.id, recording.note_id, recording.title, recording.file_uri, recording.status, recording.created_at); }); }
export async function renameRecording(id: string, title: string) { const database = await db(); const result = await database.runAsync('UPDATE recordings SET title=? WHERE id=?', title, id); if (result.changes !== 1) throw new Error('Recording no longer exists.'); }
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
