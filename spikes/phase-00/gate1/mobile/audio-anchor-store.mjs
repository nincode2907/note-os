import { assertNoteRecord } from '../web/app/lib/note-validation.mjs';
import { addAudioAnchor, deleteAudioAnchor, emptyAudioAnchorSet, renameAudioAnchor, validateAudioAnchorSet } from '../web/app/lib/audio-anchors.mjs';

export const AUDIO_ANCHOR_SCHEMA_V5_SQL = `CREATE TABLE IF NOT EXISTS audio_anchor_sessions (
    recording_id TEXT PRIMARY KEY NOT NULL, note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
    note_json TEXT, recording_json TEXT NOT NULL, metadata_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
    CHECK(note_id IS NOT NULL OR note_json IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS audio_anchor_sessions_note ON audio_anchor_sessions(note_id, updated_at);
  PRAGMA user_version = 5;`;

export async function migrateAudioAnchorSchema(database) {
  const version = (await database.getFirstAsync('PRAGMA user_version'))?.user_version ?? 0;
  if (version < 5) await database.withExclusiveTransactionAsync(txn => txn.execAsync(AUDIO_ANCHOR_SCHEMA_V5_SQL));
}

function anchorSet(metadata, recordingId) {
  const known = metadata.durationKnown === true && Number.isSafeInteger(metadata.durationMs) && metadata.durationMs > 0;
  return validateAudioAnchorSet(metadata.audioAnchors, recordingId, { durationMs: metadata.durationMs, durationKnown: known });
}

function validateSession({ noteId, note, recording, metadata }) {
  if (!recording || typeof recording.id !== 'string' || !recording.id || recording.id.length > 512 || typeof recording.note_id !== 'string' || recording.note_id !== (note?.id ?? noteId)) throw new Error('Recording session identity does not match its note.');
  if (note) { assertNoteRecord(note); if (noteId != null && noteId !== note.id) throw new Error('Recording session note does not match its note journal.'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Recording session metadata is invalid.');
  const audioAnchors = anchorSet(metadata, recording.id);
  return { noteId: note?.id ?? noteId ?? null, note, recording, metadata: { ...metadata, audioAnchors } };
}

/** @param {any} txn @param {{noteId?:string|null,note?:any,recording:any,metadata:any,updatedAt?:number}} input */
export async function saveAudioAnchorSession(txn, input) {
  const session = validateSession(input);
  const old = await txn.getFirstAsync('SELECT note_id,note_json FROM audio_anchor_sessions WHERE recording_id=?', session.recording.id);
  const noteJson = session.note ? JSON.stringify(session.note) : null;
  const ownerNoteId = input.noteId ?? null;
  if (old && (old.note_id !== ownerNoteId || (old.note_json && old.note_json !== noteJson))) throw new Error('A different audio session already uses this recording ID.');
  await txn.runAsync(`INSERT INTO audio_anchor_sessions(recording_id,note_id,note_json,recording_json,metadata_json,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(recording_id) DO UPDATE SET note_id=excluded.note_id,note_json=COALESCE(excluded.note_json,audio_anchor_sessions.note_json),recording_json=excluded.recording_json,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
  session.recording.id, ownerNoteId, noteJson, JSON.stringify(session.recording), JSON.stringify(session.metadata), input.updatedAt ?? Date.now());
  return session;
}

async function mutateSession(txn, recordingId, change) {
  const row = await txn.getFirstAsync('SELECT note_id,note_json,recording_json,metadata_json FROM audio_anchor_sessions WHERE recording_id=?', recordingId);
  if (!row) throw new Error('Audio recording session no longer exists.');
  const recording = JSON.parse(row.recording_json), metadata = JSON.parse(row.metadata_json), note = row.note_json ? JSON.parse(row.note_json) : null;
  const session = validateSession({ noteId: row.note_id, note, recording, metadata });
  session.metadata.audioAnchors = change(session.metadata.audioAnchors, session);
  await txn.runAsync('UPDATE audio_anchor_sessions SET metadata_json=?,updated_at=? WHERE recording_id=?', JSON.stringify(session.metadata), Date.now(), recordingId);
  return session.metadata.audioAnchors;
}

export async function addSessionAudioAnchor(txn, recordingId, anchor) {
  return mutateSession(txn, recordingId, (set, session) => addAudioAnchor(set, anchor, recordingId, { durationMs: session.metadata.durationMs, durationKnown: session.metadata.durationKnown === true && session.metadata.durationMs > 0 }));
}
export async function renameSessionAudioAnchor(txn, recordingId, anchorId, label) {
  return mutateSession(txn, recordingId, (set, session) => renameAudioAnchor(set, anchorId, label, recordingId, { durationMs: session.metadata.durationMs, durationKnown: session.metadata.durationKnown === true && session.metadata.durationMs > 0 }));
}
export async function deleteSessionAudioAnchor(txn, recordingId, anchorId) {
  return mutateSession(txn, recordingId, set => deleteAudioAnchor(set, anchorId, recordingId));
}
export async function removeAudioAnchorSession(txn, recordingId) {
  await txn.runAsync('DELETE FROM audio_anchor_sessions WHERE recording_id=?', recordingId);
}

/** Commits a finalized recording, note (for Quick Voice), and anchors in one transaction. */
export async function commitAudioAnchorSession(txn, recordingId) {
  const row = await txn.getFirstAsync('SELECT note_id,note_json,recording_json,metadata_json FROM audio_anchor_sessions WHERE recording_id=?', recordingId);
  if (!row) return null;
  const session = validateSession({ noteId: row.note_id, note: row.note_json ? JSON.parse(row.note_json) : null, recording: JSON.parse(row.recording_json), metadata: JSON.parse(row.metadata_json) });
  const { recording, note, metadata } = session;
  if (recording.id !== recordingId || !recording.file_uri || !['complete', 'interrupted'].includes(recording.status)) throw new Error('Finalized recording metadata is invalid. Its recovery journal was preserved.');
  if (!metadata.mimeType || !metadata.ownerId || !Number.isSafeInteger(metadata.updatedAt) || !Number.isSafeInteger(metadata.durationMs) || metadata.durationMs < 0) throw new Error('Finalized recording archive metadata is invalid. Its recovery journal was preserved.');
  const existingNote = note ? await txn.getFirstAsync('SELECT record_json FROM notes WHERE id=?', note.id) : null;
  if (note && existingNote && existingNote.record_json !== JSON.stringify(note)) throw new Error('Quick Voice note ID collision. Its recovery journal was preserved.');
  if (!note && !await txn.getFirstAsync('SELECT id FROM notes WHERE id=?', recording.note_id)) throw new Error('The note for this recording no longer exists. Its recovery journal was preserved.');
  const existingRecording = await txn.getFirstAsync('SELECT note_id,file_uri FROM recordings WHERE id=?', recording.id);
  if (existingRecording) {
    if (existingRecording.note_id !== recording.note_id || existingRecording.file_uri !== recording.file_uri) throw new Error('Audio recording ID collision. Its recovery journal was preserved.');
    await txn.runAsync('DELETE FROM audio_anchor_sessions WHERE recording_id=?', recordingId);
    return { note, recording, metadata, recovered: false };
  }
  if (note && !existingNote) await txn.runAsync('INSERT INTO notes(id,record_json,revision,lifecycle,updated_at) VALUES(?,?,?,?,?)', note.id, JSON.stringify(note), note.revision, note.lifecycle, note.updatedAt);
  await txn.runAsync('INSERT INTO recordings(id,note_id,title,file_uri,status,created_at) VALUES(?,?,?,?,?,?)', recording.id, recording.note_id, recording.title, recording.file_uri, recording.status, recording.created_at);
  await txn.runAsync('INSERT INTO recording_archive_metadata(recording_id,metadata_json) VALUES(?,?)', recording.id, JSON.stringify(metadata));
  await txn.runAsync('DELETE FROM audio_anchor_sessions WHERE recording_id=?', recordingId);
  return { note, recording, metadata, recovered: true };
}
