import { assertNoteRecord } from '../web/app/lib/note-validation.mjs';

export const ARCHIVE_SCHEMA_V3_SQL = `CREATE TABLE IF NOT EXISTS recording_archive_metadata (
    recording_id TEXT PRIMARY KEY NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    metadata_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS archive_imports (
    import_id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL CHECK(state IN ('staged','committed')),
    files_json TEXT NOT NULL, created_at INTEGER NOT NULL
  ); PRAGMA user_version = 3;`;

/** The additive migration preserves all v1/v2 note, recording, recovery and cleanup rows. */
export async function migrateArchiveSchema(database) {
  const version = (await database.getFirstAsync('PRAGMA user_version'))?.user_version ?? 0;
  if (version < 3) await database.withExclusiveTransactionAsync(txn => txn.execAsync(ARCHIVE_SCHEMA_V3_SQL));
}

/** Database-transaction body shared by Expo SQLite and isolated node:sqlite regression tests. */
export async function commitArchiveBatch(txn, { importId, notes, rows, acceptedFiles, sourcePlatform }) {
  const journal = await txn.getFirstAsync('SELECT state FROM archive_imports WHERE import_id=?', importId);
  if (!journal || journal.state !== 'staged') throw new Error('Import staging journal is missing. No database records were added.');
  const noteIds = new Set();
  for (const note of notes) {
    assertNoteRecord(note, { allowUnsupported: true });
    if (noteIds.has(note.id) || await txn.getFirstAsync('SELECT id FROM notes WHERE id=?', note.id)) throw new Error('A note ID collision appeared before commit. Nothing was imported.');
    noteIds.add(note.id);
  }
  const media = new Map(acceptedFiles.map(file => [file.recordingId, file]));
  const recordingIds = new Set();
  for (const row of rows) {
    const recording = row.recording;
    if (recordingIds.has(recording.id) || await txn.getFirstAsync('SELECT id FROM recordings WHERE id=?', recording.id)) throw new Error('A recording ID collision appeared before commit. Nothing was imported.');
    if (!noteIds.has(recording.noteId)) throw new Error('Archive recording refers to a note outside the accepted import group.');
    recordingIds.add(recording.id);
    if (row.chunks.length && !media.has(recording.id)) throw new Error('A recording has no verified staged media file.');
  }
  for (const note of notes) await txn.runAsync('INSERT INTO notes(id,record_json,revision,lifecycle,updated_at) VALUES(?,?,?,?,?)', note.id, JSON.stringify(note), note.revision, note.lifecycle, note.updatedAt);
  for (const row of rows) {
    const incoming = row.recording, mediaFile = media.get(incoming.id);
    const status = incoming.status === 'complete' ? 'complete' : 'interrupted';
    const recording = { id: incoming.id, note_id: incoming.noteId, title: incoming.title, file_uri: mediaFile?.finalUri ?? '', status, created_at: incoming.createdAt };
    await txn.runAsync('INSERT INTO recordings(id,note_id,title,file_uri,status,created_at) VALUES(?,?,?,?,?,?)', recording.id, recording.note_id, recording.title, recording.file_uri, recording.status, recording.created_at);
    const metadata = {
      mimeType: incoming.mimeType, ownerId: incoming.ownerId, updatedAt: incoming.updatedAt, durationMs: incoming.durationMs,
      durationKnown: typeof incoming.nativeProvenance?.durationKnown === 'boolean' ? incoming.nativeProvenance.durationKnown : true,
      sourcePlatform, sourceRecording: incoming, sourceChunkDescriptors: row.chunks,
      mediaSha256: mediaFile?.sha256 ?? null,
    };
    await txn.runAsync('INSERT INTO recording_archive_metadata(recording_id,metadata_json) VALUES(?,?)', recording.id, JSON.stringify(metadata));
  }
  const marked = await txn.runAsync("UPDATE archive_imports SET state='committed' WHERE import_id=? AND state='staged'", importId);
  if (marked.changes !== 1) throw new Error('Import journal changed before commit. The transaction was rolled back.');
}
