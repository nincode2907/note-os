import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createEmptyCanonicalDocument } from '../../web/packages/document-engine/src/index.js';
import { createTar, readTar } from '../../web/app/lib/archive-tar.mjs';
import { exportArchive, verifyArchive } from '../../web/app/lib/archive-v2.mjs';
import { createAudioAnchor } from '../../web/app/lib/audio-anchors.mjs';
import { adaptArchiveRecording, assertAvailableSpace, buildArchivePlan, planArchiveImport, streamVerifiedMedia, verifyArchiveStream, writeArchivePlan } from '../archive-v2-native.mjs';
import { ARCHIVE_SCHEMA_V3_SQL, commitArchiveBatch, migrateArchiveSchema } from '../archive-store.mjs';
import { reconcileImportJournals } from '../archive-reconcile.mjs';

const note = (id = 'note-1') => ({ id, title: 'Ghi chú 東京', document: { ...createEmptyCanonicalDocument(), content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tiếng Việt — 日本語 — 漢字' }] }] }, schemaVersion: 1, createdAt: 100, updatedAt: 200, lifecycle: 'active', revision: 3, pinned: true, tags: ['Việt', '日本語'] });
const hash = async value => createHash('sha256').update(value instanceof ArrayBuffer ? new Uint8Array(value) : value).digest('hex');
const bytesOf = async stream => { const reader = stream.getReader(), chunks = []; let size = 0; try { while (true) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); size += value.byteLength; } } finally { reader.releaseLock(); } const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result; };
class MemoryFile {
  constructor(uri = 'memory://out') { this.uri = uri; this.parts = []; this.size = 0; this.exists = true; }
  writableStream() { return new WritableStream({ write: bytes => { const copy = new Uint8Array(bytes); this.parts.push(copy); this.size += copy.byteLength; }, abort: () => { this.exists = false; } }); }
  info() { return { exists: this.exists, size: this.size }; }
  delete() { this.exists = false; this.parts = []; this.size = 0; }
  blob() { return new Blob(this.parts, { type: 'application/x-tar' }); }
}
class FailingFile extends MemoryFile {
  writableStream() { return new WritableStream({ write() { throw new Error('synthetic quota failure'); }, abort: () => { this.exists = false; } }); }
}
function sqliteFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE notes(id TEXT PRIMARY KEY,record_json TEXT NOT NULL,revision INTEGER NOT NULL,lifecycle TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE recordings(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(id),title TEXT NOT NULL,file_uri TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE recovery_drafts(note_id TEXT PRIMARY KEY,base_revision INTEGER,draft_json TEXT,updated_at INTEGER,version INTEGER);
    CREATE TABLE file_cleanup(file_uri TEXT PRIMARY KEY,created_at INTEGER); PRAGMA user_version=2;`);
  const exec = async (sql, ...params) => db.prepare(sql).run(...params);
  const txn = {
    getFirstAsync: async (sql, ...params) => db.prepare(sql).get(...params),
    runAsync: async (sql, ...params) => { const result = db.prepare(sql).run(...params); return { changes: Number(result.changes) }; },
    execAsync: async sql => db.exec(sql),
  };
  const database = {
    getFirstAsync: async (sql, ...params) => db.prepare(sql).get(...params),
    withExclusiveTransactionAsync: async work => { db.exec('BEGIN EXCLUSIVE'); try { const value = await work(txn); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
  };
  return { db, database, txn, exec };
}
function fixtureWebArchive({ status = 'complete', audio = new Uint8Array([0, 1, 2, 255, 7]) } = {}) {
  const recording = { id: 'rec-1', noteId: 'note-1', ownerId: 'web-tab', title: 'Âm thanh 東京', mimeType: 'audio/mp4', status, createdAt: 110, updatedAt: 220, durationMs: 900, chunkCount: audio.length ? 2 : 0 };
  const chunks = audio.length ? [{ id: 'rec-1:0', recordingId: 'rec-1', sequence: 0, blob: new Blob([audio.slice(0, 2)], { type: 'audio/mp4' }) }, { id: 'rec-1:1', recordingId: 'rec-1', sequence: 1, blob: new Blob([audio.slice(2)], { type: 'audio/mp4' }) }] : [];
  return { notes: [note()], recordings: [recording], chunks };
}
async function webArchive(snapshot) { return (await exportArchive({ snapshotArchive: async () => snapshot }, { exportedAt: '2026-10-22T00:00:00.000Z' })).blob; }
async function nativeArchive({ status = 'complete', media = new Uint8Array([0, 1, 2, 255, 7]), noteRows = [note()] } = {}) {
  const fileMap = new Map([['memory://audio', new Blob([media])]]);
  const recordings = [{ id: 'rec-ios-1', note_id: noteRows[0].id, title: 'Âm thanh 東京', file_uri: media.length ? 'memory://audio' : '', status, created_at: 110, archiveMetadata: { mimeType: 'audio/mp4', ownerId: 'ios-local', updatedAt: 220, durationMs: 0, durationKnown: false, sourcePlatform: 'ios' } }];
  const plan = await buildArchivePlan({ notes: noteRows, recordings, readStream: uri => fileMap.get(uri).stream(), stat: uri => ({ exists: fileMap.has(uri), size: fileMap.get(uri).size, modificationTime: 42 }), exportedAt: '2026-10-22T00:00:00.000Z' });
  const output = new MemoryFile();
  await writeArchivePlan(plan, output, { readStream: uri => fileMap.get(uri).stream() });
  return { blob: output.blob(), plan, output };
}
async function replaceFirstPath(blob, path) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), header = bytes.subarray(0, 512);
  header.fill(0, 0, 100); header.set(new TextEncoder().encode(path), 0); header.fill(32, 148, 156);
  const checksum = header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ';
  header.set(new TextEncoder().encode(checksum), 148);
  return new Blob([bytes]);
}
async function duplicateFirstTarEntry(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), header = bytes.subarray(0, 512);
  const sizeText = new TextDecoder().decode(header.subarray(124, 136)).replace(/[\0 ]+$/u, '');
  const size = Number.parseInt(sizeText, 8), firstEntryEnd = 512 + size + (512 - size % 512) % 512;
  return new Blob([bytes.subarray(0, firstEntryEnd), bytes.subarray(0, bytes.length - 1024), new Uint8Array(1024)]);
}

test('iPhone export → iPhone restore preserves canonical JSON, multilingual text, lifecycle and exact concatenated audio bytes', async () => {
  const { blob } = await nativeArchive();
  const verified = await verifyArchiveStream(blob.stream());
  assert.equal(verified.manifest.sourcePlatform, 'ios');
  assert.deepEqual(verified.notes[0], note());
  const target = new MemoryFile('memory://staged/rec-1');
  const destinations = new Map([['rec-ios-1', target]]);
  await streamVerifiedMedia(blob.stream(), verified, destinations);
  assert.deepEqual(await bytesOf(target.blob().stream()), new Uint8Array([0, 1, 2, 255, 7]));
  assert.equal(await hash(await target.blob().arrayBuffer()), verified.media[0].sha256);
});

test('Web V2 export → iPhone verification and staging preserves exact concatenated audio SHA-256 and source metadata', async () => {
  const webSnapshot = fixtureWebArchive(); const blob = await webArchive(webSnapshot);
  const verified = await verifyArchiveStream(blob.stream());
  assert.equal(verified.manifest.sourcePlatform, 'web');
  assert.equal(verified.recordingRows[0].recording.ownerId, 'web-tab');
  const target = new MemoryFile('memory://staged/rec-1');
  await streamVerifiedMedia(blob.stream(), verified, new Map([['rec-1', target]]));
  const expected = new Uint8Array([0, 1, 2, 255, 7]);
  assert.deepEqual(await bytesOf(target.blob().stream()), expected);
  assert.equal(await hash(await target.blob().arrayBuffer()), await hash(expected));
});

test('audioAnchors extension survives Web V2 → iPhone import and iPhone V2 export unchanged', async () => {
  const anchor = createAudioAnchor('rec-1', 345, 'Visão — 東京', { id: 'bookmark-cross-platform', createdAt: 222 });
  const snapshot = fixtureWebArchive(); snapshot.recordings[0].audioAnchors = { version: 1, items: [anchor] };
  const web = await webArchive(snapshot); const verifiedWeb = await verifyArchiveStream(web.stream());
  assert.deepEqual(verifiedWeb.recordingRows[0].recording.audioAnchors.items[0], anchor);
  const nativeMetadata = adaptArchiveRecording(verifiedWeb.recordingRows[0], { archiveMetadata: { sourcePlatform: 'web' } }, 'web');
  assert.deepEqual(nativeMetadata.audioAnchors.items[0], anchor);
  const toIos = await buildArchivePlan({ notes: [note()], recordings: [{ id: 'rec-1', note_id: 'note-1', title: 'Audio', file_uri: 'memory://audio', status: 'complete', created_at: 110, archiveMetadata: { ...nativeMetadata, durationKnown: true } }], readStream: () => new Blob([new Uint8Array([1])]).stream(), stat: () => ({ exists: true, size: 1 }), exportedAt: '2026-10-22T00:00:00.000Z' });
  const exported = JSON.parse(new TextDecoder().decode(toIos.recordingsBytes))[0].recording.audioAnchors.items[0];
  assert.equal(exported.label, anchor.label); assert.equal(exported.offsetMs, anchor.offsetMs); assert.equal(exported.recordingId, 'rec-1');
  await assert.rejects(buildArchivePlan({ notes: [note()], recordings: [{ id: 'bad', note_id: 'note-1', title: 'Bad', file_uri: 'memory://audio', status: 'complete', created_at: 1, archiveMetadata: { mimeType: 'audio/mp4', ownerId: 'ios-local', updatedAt: 2, durationMs: 900, durationKnown: true, sourcePlatform: 'ios', audioAnchors: { version: 1, items: [{ ...anchor, recordingId: 'bad', offsetMs: 901 }] } } }], readStream: () => new Blob([new Uint8Array([1])]).stream(), stat: () => ({ exists: true, size: 1 }) }), /duration/u);
});

test('iPhone V2 export → Web V2 reader accepts the unchanged logical V2 structure and normalizes audio to one chunk', async () => {
  const { blob } = await nativeArchive();
  const web = await verifyArchive(blob);
  assert.equal(web.manifest.version, 2); assert.equal(web.manifest.sourcePlatform, 'ios');
  assert.deepEqual(web.notes[0], note());
  assert.equal(web.recordings[0].ownerId, 'ios-local');
  assert.equal(web.recordings[0].durationMs, 0);
  assert.equal(web.recordings[0].nativeProvenance.durationKnown, false);
  assert.equal(web.recordings[0].chunkCount, 1);
  assert.equal(web.chunks.length, 1);
  assert.equal(await hash(await web.chunks[0].blob.arrayBuffer()), await hash(new Uint8Array([0, 1, 2, 255, 7])));
});

test('supported rich-text structures and unsupported future note JSON remain unchanged in the archive', async () => {
  const richDocument = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../web/packages/document-engine/fixtures/schema-v1-rich.json', import.meta.url), 'utf8'));
  const rich = { ...note('rich-note'), document: richDocument, lifecycle: 'archived', revision: 9 };
  const richArchive = await nativeArchive({ noteRows: [rich], status: 'interrupted', media: new Uint8Array() });
  assert.deepEqual((await verifyArchiveStream(richArchive.blob.stream())).notes[0], rich);
  const future = { ...note('future-note'), schemaVersion: 77, document: { schemaVersion: 77, type: 'doc', content: [], futureExtension: { label: '未来' } } };
  const { blob } = await nativeArchive({ noteRows: [future], media: new Uint8Array(), status: 'interrupted' });
  const verified = await verifyArchiveStream(blob.stream());
  assert.deepEqual(verified.notes[0], future);
});
test('snapshot archive contains active, archived and trashed notes without lifecycle filtering', async () => {
  const lifecycleNotes = [note('active-note'), { ...note('archived-note'), lifecycle: 'archived' }, { ...note('trashed-note'), lifecycle: 'trashed' }];
  const { blob } = await nativeArchive({ noteRows: lifecycleNotes, status: 'interrupted', media: new Uint8Array() });
  const verified = await verifyArchiveStream(blob.stream());
  assert.deepEqual(verified.notes.map(item => item.lifecycle), ['active', 'archived', 'trashed']);
});

test('completed audio requires existing nonzero bytes; missing and zero-byte files block full export', async () => {
  const recording = { id: 'r', note_id: 'note-1', title: 'Test', file_uri: 'missing', status: 'complete', created_at: 1, archiveMetadata: { mimeType: 'audio/mp4', ownerId: 'ios', durationKnown: false } };
  await assert.rejects(buildArchivePlan({ notes: [note()], recordings: [recording], stat: () => ({ exists: false, size: 0 }), readStream: () => new Blob([]).stream() }), /missing/u);
  await assert.rejects(buildArchivePlan({ notes: [note()], recordings: [recording], stat: () => ({ exists: true, size: 0 }), readStream: () => new Blob([]).stream() }), /empty|no audio/u);
});
test('storage estimate blocks insufficient space, accepts safe space and reports an unavailable estimate without pretending it was checked', () => {
  assert.throws(() => assertAvailableSpace(20, 10, 16, 'stage archive media'), /Not enough free space/u);
  assert.equal(assertAvailableSpace(100, 10, 16).checked, true);
  assert.equal(assertAvailableSpace(-1, 10, 16).checked, false);
});

test('interrupted recordings preserve metadata when no audio was finalized without claiming measured duration', async () => {
  const { blob, plan } = await nativeArchive({ status: 'interrupted', media: new Uint8Array() });
  assert.equal(plan.manifest.warnings.length, 1);
  const verified = await verifyArchiveStream(blob.stream());
  assert.equal(verified.recordingRows[0].recording.status, 'interrupted');
  assert.equal(verified.recordingRows[0].recording.durationMs, 0);
  assert.equal(verified.recordingRows[0].recording.nativeProvenance.durationKnown, false);
  assert.equal(verified.media.length, 0);
});

test('portable iPhone recording metadata never exports an absolute native file URI', async () => {
  const audio = new Uint8Array([1, 2, 3]), fileMap = new Map([['file:///private/var/mobile/audio.m4a', new Blob([audio])]]);
  const recording = { id: 'uri-rec', note_id: 'note-1', title: 'Private path', file_uri: 'file:///private/var/mobile/audio.m4a', status: 'complete', created_at: 1, archiveMetadata: { mimeType: 'audio/mp4', ownerId: 'ios-local', updatedAt: 2, durationMs: 0, durationKnown: false, sourcePlatform: 'web', sourceRecording: { id: 'uri-rec', noteId: 'note-1', ownerId: 'web', title: 'Private path', mimeType: 'audio/mp4', status: 'complete', createdAt: 1, updatedAt: 2, durationMs: 0, chunkCount: 1, file_uri: 'file:///private/var/mobile/original.m4a' } } };
  const plan = await buildArchivePlan({ notes: [note()], recordings: [recording], readStream: uri => fileMap.get(uri).stream(), stat: uri => ({ exists: fileMap.has(uri), size: fileMap.get(uri).size }) });
  const output = new MemoryFile(); await writeArchivePlan(plan, output, { readStream: uri => fileMap.get(uri).stream() });
  const entries = await readTar(output.blob()), rows = JSON.parse(await entries.get('recordings.json').text());
  assert.equal('file_uri' in rows[0].recording, false);
  assert.equal(JSON.stringify(rows).includes('/private/var/mobile/'), false);
});

test('Skip aborts ID collisions; Merge skips an existing note with its audio group and repeated merge stays idempotent', async () => {
  const { blob } = await nativeArchive(); const verified = await verifyArchiveStream(blob.stream());
  assert.throws(() => planArchiveImport(verified, [note()], [], 'skip'), /entire import/u);
  const merged = planArchiveImport(verified, [note()], [], 'merge');
  assert.equal(merged.notes.length, 0); assert.equal(merged.recordingRows.length, 0);
  assert.equal(merged.skippedNotes, 1); assert.equal(merged.skippedRecordings, 1);
  const recordingCollision = planArchiveImport(verified, [], [{ id: 'rec-ios-1' }], 'merge');
  assert.equal(recordingCollision.notes.length, 0); assert.equal(recordingCollision.skippedNotes, 1);
});

test('bad manifest/audio checksum, duplicate entries and traversal paths reject before staging', async () => {
  const { blob } = await nativeArchive();
  const tarEntries = await readTar(blob);
  const audioPath = [...tarEntries.keys()].find(path => path.startsWith('blobs/'));
  const audio = new Uint8Array(await tarEntries.get(audioPath).arrayBuffer()); audio[0] ^= 0x80;
  tarEntries.set(audioPath, new Blob([audio]));
  const corrupt = createTar([...tarEntries].map(([path, body]) => ({ path, blob: body })));
  await assert.rejects(verifyArchiveStream(corrupt.stream()), /checksum mismatch/u);
  const manifestChecksum = new Uint8Array(await tarEntries.get('manifest.sha256').arrayBuffer()); manifestChecksum[0] ^= 1;
  tarEntries.set('manifest.sha256', new Blob([manifestChecksum]));
  const badManifest = createTar([...tarEntries].map(([path, body]) => ({ path, blob: body })));
  await assert.rejects(verifyArchiveStream(badManifest.stream()), /Manifest checksum/u);
  await assert.rejects(verifyArchiveStream((await replaceFirstPath(blob, '../private')).stream()), /Unsafe archive entry path/u);
  await assert.rejects(verifyArchiveStream((await duplicateFirstTarEntry(blob)).stream()), /Duplicate TAR entry/u);
});

test('staging write failure aborts the stream and removes only the import destination', async () => {
  const { blob } = await nativeArchive(); const verified = await verifyArchiveStream(blob.stream());
  const target = new FailingFile('memory://import-only');
  await assert.rejects(streamVerifiedMedia(blob.stream(), verified, new Map([['rec-ios-1', target]])), /synthetic quota failure/u);
  assert.equal(target.exists, false);
});

test('additive SQLite migration preserves existing notes, recordings, recovery rows and cleanup queue', async () => {
  const { db, database, exec } = sqliteFixture();
  const existing = note('pre-phase04');
  await exec('INSERT INTO notes(id,record_json,revision,lifecycle,updated_at) VALUES(?,?,?,?,?)', existing.id, JSON.stringify(existing), existing.revision, existing.lifecycle, existing.updatedAt);
  await exec('INSERT INTO recordings(id,note_id,title,file_uri,status,created_at) VALUES(?,?,?,?,?,?)', 'old-rec', existing.id, 'Existing audio', 'file:///private/old.m4a', 'complete', 10);
  await exec('INSERT INTO recovery_drafts(note_id,base_revision,draft_json,updated_at,version) VALUES(?,?,?,?,?)', existing.id, existing.revision, '{}', 11, 1);
  await exec('INSERT INTO file_cleanup(file_uri,created_at) VALUES(?,?)', 'file:///private/pending.m4a', 12);
  await migrateArchiveSchema(database);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare('SELECT record_json FROM notes WHERE id=?').get(existing.id).record_json, JSON.stringify(existing));
  assert.equal(db.prepare('SELECT file_uri FROM recordings WHERE id=?').get('old-rec').file_uri, 'file:///private/old.m4a');
  assert.equal(db.prepare('SELECT count(*) AS n FROM recovery_drafts').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM file_cleanup').get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('recording_archive_metadata','archive_imports')").get().n, 2);
  assert.match(ARCHIVE_SCHEMA_V3_SQL, /CREATE TABLE IF NOT EXISTS/u);
  db.close();
});

test('SQLite import transaction commits note/audio references and provenance together', async () => {
  const { db, database, exec } = sqliteFixture(); await migrateArchiveSchema(database);
  await exec('INSERT INTO archive_imports(import_id,state,files_json,created_at) VALUES(?,?,?,?)', 'import-a', 'staged', '[]', 1);
  const incoming = { ...fixtureWebArchive().recordings[0], nativeProvenance: { durationKnown: false } };
  const files = [{ recordingId: incoming.id, finalUri: 'file:///app/noteos-recordings/import-a-0.m4a', sha256: 'a'.repeat(64), size: 5 }];
  await database.withExclusiveTransactionAsync(txn => commitArchiveBatch(txn, { importId: 'import-a', notes: [note()], rows: [{ recording: incoming, file: 'blobs/000000.m4a', chunks: [{ sequence: 0, byteLength: 5 }] }], acceptedFiles: files, sourcePlatform: 'web' }));
  assert.equal(db.prepare('SELECT count(*) AS n FROM notes').get().n, 1);
  assert.equal(db.prepare('SELECT file_uri FROM recordings WHERE id=?').get(incoming.id).file_uri, files[0].finalUri);
  const metadata = JSON.parse(db.prepare('SELECT metadata_json FROM recording_archive_metadata WHERE recording_id=?').get(incoming.id).metadata_json);
  assert.equal(metadata.ownerId, incoming.ownerId); assert.equal(metadata.durationKnown, false); assert.deepEqual(metadata.sourceChunkDescriptors, [{ sequence: 0, byteLength: 5 }]);
  assert.equal(db.prepare('SELECT state FROM archive_imports WHERE import_id=?').get('import-a').state, 'committed');
  db.close();
});

test('SQLite trigger failure rolls back inserted note and recording while retaining staged journal for cleanup', async () => {
  const { db, database, exec } = sqliteFixture(); await migrateArchiveSchema(database);
  await exec('INSERT INTO archive_imports(import_id,state,files_json,created_at) VALUES(?,?,?,?)', 'import-fail', 'staged', '[]', 1);
  db.exec("CREATE TRIGGER fail_archive_metadata BEFORE INSERT ON recording_archive_metadata BEGIN SELECT RAISE(ABORT,'synthetic sqlite write failure'); END;");
  const incoming = fixtureWebArchive().recordings[0];
  const files = [{ recordingId: incoming.id, finalUri: 'file:///app/noteos-recordings/import-fail-0.m4a', sha256: 'b'.repeat(64), size: 5 }];
  await assert.rejects(database.withExclusiveTransactionAsync(txn => commitArchiveBatch(txn, { importId: 'import-fail', notes: [note()], rows: [{ recording: incoming, file: 'blobs/000000.m4a', chunks: [{}] }], acceptedFiles: files, sourcePlatform: 'web' })), /synthetic sqlite write failure/u);
  assert.equal(db.prepare('SELECT count(*) AS n FROM notes').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM recordings').get().n, 0);
  assert.equal(db.prepare('SELECT state FROM archive_imports WHERE import_id=?').get('import-fail').state, 'staged');
  db.close();
});

test('crash recovery removes only journaled uncommitted files and retains committed or unrelated media', async () => {
  const files = new Map([['stage://aborted', new Uint8Array([1])], ['final://aborted', new Uint8Array([1])], ['stage://committed', new Uint8Array([2])], ['final://committed', new Uint8Array([3])], ['stage://referenced', new Uint8Array([4])], ['final://referenced', new Uint8Array([4])], ['unrelated://recording', new Uint8Array([9])]]);
  const records = [{ id: 'committed-rec', file_uri: 'final://committed' }, { id: 'referenced-rec', file_uri: 'final://referenced' }];
  const entries = [
    { importId: 'aborted', state: 'staged', files: [{ stagedUri: 'stage://aborted', finalUri: 'final://aborted', recordingId: 'aborted-rec', size: 1, sha256: await hash(new Uint8Array([1])) }] },
    { importId: 'committed', state: 'committed', files: [{ stagedUri: 'stage://committed', finalUri: 'final://committed', recordingId: 'committed-rec', size: 1, sha256: await hash(new Uint8Array([3])) }] },
    { importId: 'referenced', state: 'staged', files: [{ stagedUri: 'stage://referenced', finalUri: 'final://referenced', recordingId: 'referenced-rec', size: 1, sha256: await hash(new Uint8Array([4])) }] },
    { importId: 'corrupt', state: 'committed', files: [{ stagedUri: 'stage://committed', finalUri: 'final://committed', recordingId: 'committed-rec', size: 1, sha256: 'f'.repeat(64) }] },
  ];
  const finished = [];
  const result = await reconcileImportJournals(entries, records, {
    removeStaged: async (staged, final) => { files.delete(staged); if (final) files.delete(final); },
    inspectFinal: async uri => { const bytes = files.get(uri); return bytes ? { exists: true, size: bytes.length, sha256: await hash(bytes) } : { exists: false, size: 0, sha256: '' }; },
    finish: async id => finished.push(id),
  });
  assert.deepEqual(finished, ['aborted', 'committed']);
  assert.equal(files.has('final://aborted'), false);
  assert.equal(files.has('stage://committed'), false); assert.equal(files.has('final://committed'), true);
  assert.equal(files.has('stage://referenced'), true); assert.equal(files.has('final://referenced'), true);
  assert.equal(files.has('unrelated://recording'), true);
  assert.deepEqual([...result.unresolvedIds].sort(), ['corrupt', 'referenced']);
});

test('archive writer streams a 32 MiB synthetic recording in bounded chunks without retaining TAR bytes', async () => {
  const size = 32 * 1024 ** 2, chunkSize = 64 * 1024;
  const memoryStart = process.memoryUsage().rss, startedAt = performance.now(); let rssPeak = memoryStart;
  const memorySampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 5);
  let currentHash = createHash('sha256');
  const makeStream = () => new ReadableStream({ pull(controller) {
    const remaining = size - (this.offset ?? 0);
    if (remaining <= 0) { controller.close(); return; }
    const length = Math.min(chunkSize, remaining); const chunk = new Uint8Array(length); chunk.fill((this.offset ?? 0) / chunkSize % 251);
    this.offset = (this.offset ?? 0) + length; currentHash.update(chunk); controller.enqueue(chunk);
  } });
  // Hash a first pass, then use an equivalent deterministic stream for archive output.
  const expectedHash = await (async () => { const hash = createHash('sha256'); for (let offset = 0; offset < size; offset += chunkSize) { const chunk = new Uint8Array(Math.min(chunkSize, size - offset)); chunk.fill(offset / chunkSize % 251); hash.update(chunk); } return hash.digest('hex'); })();
  const recorder = { id: 'large-rec', note_id: 'note-1', title: 'Synthetic 32 MiB', file_uri: 'memory://large', status: 'complete', created_at: 3, archiveMetadata: { mimeType: 'audio/wav', ownerId: 'ios-local', durationMs: 0, durationKnown: false } };
  const plan = await buildArchivePlan({ notes: [note()], recordings: [recorder], stat: () => ({ exists: true, size }), readStream: makeStream, exportedAt: '2026-10-22T00:00:00.000Z' });
  assert.equal(plan.media[0].sha256, expectedHash);
  let outputBytes = 0, maxWrite = 0;
  const sink = { uri: 'memory://counting-output', exists: true, writableStream: () => new WritableStream({ write(bytes) { outputBytes += bytes.byteLength; maxWrite = Math.max(maxWrite, bytes.byteLength); } }), info: async () => ({ exists: true, size: outputBytes }), delete() {} };
  const result = await writeArchivePlan(plan, sink, { readStream: makeStream });
  assert.equal(result.size, plan.size); assert.equal(outputBytes, plan.size); assert.ok(maxWrite <= chunkSize + 512); assert.ok(currentHash.digest('hex').length === 64);
  clearInterval(memorySampler);
  const elapsedMs = Math.round(performance.now() - startedAt), rssAfter = process.memoryUsage().rss;
  rssPeak = Math.max(rssPeak, rssAfter);
  console.log(`synthetic archive performance: Node ${process.version}, 32 MiB audio → ${Math.ceil(outputBytes / 1024 ** 2)} MiB TAR, 64 KiB source chunks, max write ${maxWrite} B, ${elapsedMs} ms, sampled RSS start/peak/end ${Math.round(memoryStart / 1024 ** 2)}/${Math.round(rssPeak / 1024 ** 2)}/${Math.round(rssAfter / 1024 ** 2)} MiB`);
});
