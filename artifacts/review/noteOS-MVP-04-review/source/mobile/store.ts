import * as SQLite from 'expo-sqlite';
import { assertNoteRecord } from '../web/app/lib/note-validation.mjs';

export type Lifecycle = 'active' | 'archived' | 'trashed';
export type Note = {
  id: string; title: string; document: any; schemaVersion: number; createdAt: number; updatedAt: number;
  lifecycle: Lifecycle; revision: number; pinned: boolean; tags: string[];
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;
export function database() {
  databasePromise ??= SQLite.openDatabaseAsync('noteos-mvp04.db').then(async db => {
    await db.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    if ((version?.user_version ?? 0) < 1) {
      await db.withTransactionAsync(async () => {
        await db.execAsync(`CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY NOT NULL,
          record_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived','trashed')),
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS notes_lifecycle_updated ON notes(lifecycle, updated_at DESC);
        CREATE TABLE IF NOT EXISTS recordings (
          id TEXT PRIMARY KEY NOT NULL,
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          file_uri TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('complete','interrupted')),
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS recordings_note ON recordings(note_id, created_at DESC);
        PRAGMA user_version = 1;`);
      });
    }
    return db;
  }).catch(error => { databasePromise = undefined; throw error; });
  return databasePromise;
}

function decode(record_json: string): Note {
  const record = JSON.parse(record_json) as Note;
  assertNoteRecord(record, { allowUnsupported: true });
  return record;
}
export async function listNotes() {
  const db = await database();
  const rows = await db.getAllAsync<{ record_json: string }>('SELECT record_json FROM notes ORDER BY updated_at DESC');
  return rows.map(row => decode(row.record_json));
}
export async function getNote(id: string) {
  const db = await database();
  const row = await db.getFirstAsync<{ record_json: string }>('SELECT record_json FROM notes WHERE id = ?', id);
  return row ? decode(row.record_json) : null;
}
export async function createNote(note: Note) {
  assertNoteRecord(note);
  const db = await database();
  await db.runAsync('INSERT INTO notes(id,record_json,revision,lifecycle,updated_at) VALUES(?,?,?,?,?)', note.id, JSON.stringify(note), note.revision, note.lifecycle, note.updatedAt);
}
export class RevisionConflictError extends Error { constructor() { super('This note changed since it was opened. Reload the saved version before editing.'); this.name = 'RevisionConflictError'; } }
export async function saveNote(note: Note, expectedRevision: number) {
  assertNoteRecord(note);
  const db = await database();
  const next = { ...note, revision: expectedRevision + 1, updatedAt: Date.now() };
  const result = await db.runAsync('UPDATE notes SET record_json = ?, revision = ?, lifecycle = ?, updated_at = ? WHERE id = ? AND revision = ?', JSON.stringify(next), next.revision, next.lifecycle, next.updatedAt, next.id, expectedRevision);
  if (result.changes !== 1) throw new RevisionConflictError();
  return next;
}
export async function setLifecycle(id: string, lifecycle: Lifecycle, expectedRevision: number) {
  const current = await getNote(id);
  if (!current) throw new Error('Note was not found.');
  const db = await database();
  const next = { ...current, lifecycle, revision: expectedRevision + 1, updatedAt: Date.now() };
  const result = await db.runAsync('UPDATE notes SET record_json = ?, revision = ?, lifecycle = ?, updated_at = ? WHERE id = ? AND revision = ?', JSON.stringify(next), next.revision, next.lifecycle, next.updatedAt, next.id, expectedRevision);
  if (result.changes !== 1) throw new RevisionConflictError();
  return next;
}
export async function importNotes(notes: Note[]) {
  const db = await database();
  await db.withTransactionAsync(async () => {
    const collisions = [] as string[];
    for (const note of notes) {
      assertNoteRecord(note, { allowUnsupported: true });
      if (await db.getFirstAsync('SELECT id FROM notes WHERE id = ?', note.id)) collisions.push(note.id);
    }
    if (collisions.length) throw new Error(`${collisions.length} note ID collision(s). Nothing was imported.`);
    for (const note of notes) await db.runAsync('INSERT INTO notes(id,record_json,revision,lifecycle,updated_at) VALUES(?,?,?,?,?)', note.id, JSON.stringify(note), note.revision, note.lifecycle, note.updatedAt);
  });
}
export async function exportNotes() { return listNotes(); }

export type Recording = { id: string; note_id: string; title: string; file_uri: string; status: 'complete' | 'interrupted'; created_at: number };
export async function listRecordings(noteId: string) {
  const db = await database();
  return db.getAllAsync<Recording>('SELECT * FROM recordings WHERE note_id = ? ORDER BY created_at DESC', noteId);
}
export async function saveRecording(recording: Recording) {
  const db = await database();
  await db.runAsync('INSERT INTO recordings(id,note_id,title,file_uri,status,created_at) VALUES(?,?,?,?,?,?)', recording.id, recording.note_id, recording.title, recording.file_uri, recording.status, recording.created_at);
}
export async function renameRecording(id: string, title: string) {
  const db = await database(); await db.runAsync('UPDATE recordings SET title = ? WHERE id = ?', title, id);
}
export async function removeRecording(id: string) {
  const db = await database(); await db.runAsync('DELETE FROM recordings WHERE id = ?', id);
}
export async function permanentlyDeleteNote(id: string) {
  const db = await database();
  await db.withTransactionAsync(async () => { await db.runAsync('DELETE FROM notes WHERE id = ?', id); });
}
