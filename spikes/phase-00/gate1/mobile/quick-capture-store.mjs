import { assertNoteRecord } from '../web/app/lib/note-validation.mjs';

export const QUICK_CAPTURE_SCHEMA_V4_SQL = `CREATE TABLE IF NOT EXISTS quick_capture_drafts (
    draft_id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL, sequence INTEGER NOT NULL,
    note_json TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS quick_voice_pending (
    recording_id TEXT PRIMARY KEY NOT NULL, note_json TEXT NOT NULL,
    recording_json TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL
  ); PRAGMA user_version = 4;`;

export async function migrateQuickCaptureSchema(database) {
  const version = (await database.getFirstAsync('PRAGMA user_version'))?.user_version ?? 0;
  if (version < 4) await database.withExclusiveTransactionAsync((txn) => txn.execAsync(QUICK_CAPTURE_SCHEMA_V4_SQL));
}

/** @param {any} txn @param {{draftId?: string, body: string, sequence: number, noteJson?: string|null, updatedAt?: number}} input */
export async function upsertQuickCaptureDraft(txn, { draftId = 'home', body, sequence, noteJson = null, updatedAt = Date.now() }) {
  if (typeof body !== 'string' || !Number.isSafeInteger(sequence) || sequence < 0 || typeof draftId !== 'string' || !draftId) throw new Error('Quick Capture draft metadata is invalid.');
  await txn.runAsync(`INSERT INTO quick_capture_drafts(draft_id,body,sequence,note_json,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(draft_id) DO UPDATE SET body=excluded.body,sequence=excluded.sequence,
      note_json=CASE WHEN excluded.sequence > quick_capture_drafts.sequence THEN excluded.note_json ELSE COALESCE(excluded.note_json,quick_capture_drafts.note_json) END,
      updated_at=excluded.updated_at WHERE excluded.sequence >= quick_capture_drafts.sequence`, draftId, body, sequence, noteJson, updatedAt);
}

export async function deleteQuickCaptureDraft(txn, { draftId = 'home', sequence }) {
  await txn.runAsync('DELETE FROM quick_capture_drafts WHERE draft_id=? AND sequence=?', draftId, sequence);
}

export async function commitQuickCaptureNote(txn, note) {
  assertNoteRecord(note);
  const existing = await txn.getFirstAsync('SELECT record_json FROM notes WHERE id=?', note.id);
  const serialized = JSON.stringify(note);
  if (existing) {
    if (existing.record_json !== serialized) throw new Error('This Quick Capture ID already belongs to a different note. The draft was preserved.');
    return { note, created: false };
  }
  await txn.runAsync('INSERT INTO notes(id,record_json,revision,lifecycle,updated_at) VALUES(?,?,?,?,?)', note.id, serialized, note.revision, note.lifecycle, note.updatedAt);
  return { note, created: true };
}

export async function commitQuickVoicePending(txn, recordingId) {
  const pending = await txn.getFirstAsync('SELECT note_json,recording_json,metadata_json FROM quick_voice_pending WHERE recording_id=?', recordingId);
  if (!pending) return null;
  const note = JSON.parse(pending.note_json), recording = JSON.parse(pending.recording_json), metadata = JSON.parse(pending.metadata_json);
  assertNoteRecord(note);
  if (recording.id !== recordingId || recording.note_id !== note.id || !recording.file_uri || !['complete','interrupted'].includes(recording.status)) throw new Error('The pending voice recording does not match its note. The recovery journal was preserved.');
  const noteRow = await txn.getFirstAsync('SELECT record_json FROM notes WHERE id=?', note.id);
  const recordingRow = await txn.getFirstAsync('SELECT note_id,file_uri FROM recordings WHERE id=?', recording.id);
  if (noteRow || recordingRow) {
    if (noteRow?.record_json !== pending.note_json || recordingRow?.note_id !== note.id || recordingRow?.file_uri !== recording.file_uri) throw new Error('A Quick Voice ID collision was found. The recovery journal was preserved.');
    await txn.runAsync('DELETE FROM quick_voice_pending WHERE recording_id=?', recordingId);
    return { note, recording, recovered: false };
  }
  await txn.runAsync('INSERT INTO notes(id,record_json,revision,lifecycle,updated_at) VALUES(?,?,?,?,?)', note.id, pending.note_json, note.revision, note.lifecycle, note.updatedAt);
  await txn.runAsync('INSERT INTO recordings(id,note_id,title,file_uri,status,created_at) VALUES(?,?,?,?,?,?)', recording.id, recording.note_id, recording.title, recording.file_uri, recording.status, recording.created_at);
  await txn.runAsync('INSERT INTO recording_archive_metadata(recording_id,metadata_json) VALUES(?,?)', recording.id, pending.metadata_json);
  await txn.runAsync('DELETE FROM quick_voice_pending WHERE recording_id=?', recordingId);
  return { note, recording, recovered: true };
}
