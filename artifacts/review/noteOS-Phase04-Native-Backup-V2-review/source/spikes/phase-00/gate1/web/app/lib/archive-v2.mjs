import { sha256 } from '@noble/hashes/sha2.js';
import { assertNoteRecord } from './note-validation.mjs';
import { parseBackup } from './mvp-utils.mjs';
import { ARCHIVE_LIMITS, createTar, readTar } from './archive-tar.mjs';

export { ARCHIVE_LIMITS };
const verified = new WeakSet();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fail = (message) => { throw new Error(message); };
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const id = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value);
const extensions = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/aac': 'aac', 'audio/flac': 'flac' };
export function audioExtension(mime) {
  if (typeof mime !== 'string' || mime.length > 160 || !/^audio\/[a-z0-9.-]+(?:;\s*codecs=(?:[a-zA-Z0-9.,_-]+|"[a-zA-Z0-9.,_ -]+"))?$/i.test(mime)) fail('Unsupported audio MIME type.');
  return extensions[mime.split(';')[0].toLowerCase()] ?? fail('Unsupported audio MIME type.');
}
function safeJson(value, depth = 0) {
  if (depth > 64) fail('Metadata nesting is excessive.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const child of value) safeJson(child, depth + 1); return; }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('Metadata must contain JSON values.');
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Unsafe metadata key.');
    safeJson(child, depth + 1);
  }
}
function freeze(value) { if (value && typeof value === 'object' && !(value instanceof Blob)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function checkRecording(recording) {
  safeJson(recording);
  if (!recording || Array.isArray(recording)) fail('Invalid recording metadata.');
  if (['recording', 'paused'].includes(recording.status)) fail('Stop/finalize active recording sessions in every tab before exporting a Full Archive. Saved chunks and statuses were kept unchanged.');
  if (!id(recording.id) || !id(recording.noteId) || !id(recording.ownerId) || typeof recording.title !== 'string' || !recording.title.trim() || recording.title.length > 120 || !['complete', 'interrupted', 'failed'].includes(recording.status) || !['createdAt', 'updatedAt', 'durationMs', 'chunkCount'].every((key) => integer(recording[key]))) fail('Invalid recording metadata.');
  audioExtension(recording.mimeType);
}
export function validateArchiveSnapshot(snapshot) {
  const { notes, recordings, chunks } = snapshot;
  if (!Array.isArray(notes) || !Array.isArray(recordings) || !Array.isArray(chunks) || notes.length > ARCHIVE_LIMITS.maxNotes || recordings.length > ARCHIVE_LIMITS.maxRecordings || chunks.length > ARCHIVE_LIMITS.maxChunks) fail('Archive record count exceeds the supported limit.');
  const noteIds = new Set(), recordingIds = new Set(), chunkIds = new Set(), groups = new Map();
  for (const note of notes) { safeJson(note); assertNoteRecord(note, { allowUnsupported: true }); if (!id(note.id) || noteIds.has(note.id)) fail('Duplicate or invalid note ID.'); noteIds.add(note.id); }
  for (const recording of recordings) { checkRecording(recording); if (recordingIds.has(recording.id)) fail('Duplicate recording ID.'); if (!noteIds.has(recording.noteId)) fail('Recording refers to a missing note.'); recordingIds.add(recording.id); groups.set(recording.id, []); }
  for (const chunk of chunks) {
    if (!id(chunk.id) || chunkIds.has(chunk.id) || !groups.has(chunk.recordingId) || !integer(chunk.sequence) || !(chunk.blob instanceof Blob) || !chunk.blob.size) fail('Invalid, duplicate, empty or orphan audio chunk.');
    if (chunk.blob.type) audioExtension(chunk.blob.type);
    chunkIds.add(chunk.id); groups.get(chunk.recordingId).push(chunk);
  }
  for (const recording of recordings) {
    const rows = groups.get(recording.id).sort((a, b) => a.sequence - b.sequence);
    if (rows.length !== recording.chunkCount || rows.some((row, index) => row.sequence !== index) || (recording.status === 'complete' && rows.length === 0)) fail('Audio chunk ordering/count is inconsistent; no archive was created.');
    if (rows.some((row) => row.blob.type && row.blob.type.split(';')[0].toLowerCase() !== recording.mimeType.split(';')[0].toLowerCase())) fail('Audio chunk MIME does not match its recording.');
  }
  return groups;
}
export async function sha256Blob(blob) {
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += 1024 ** 2) hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 ** 2).arrayBuffer()));
  return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function jsonBlob(value) {
  const blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
  if (blob.size > ARCHIVE_LIMITS.maxJsonBytes) fail('Archive JSON exceeds the 16 MiB metadata limit.');
  return blob;
}
async function jsonFile(blob) {
  if (!blob || blob.size > ARCHIVE_LIMITS.maxJsonBytes) fail('Missing or excessive archive metadata.');
  try { return JSON.parse(decoder.decode(await blob.arrayBuffer())); } catch { fail('Corrupt archive JSON.'); }
}
export async function exportArchive(repository, { onProgress = (_stage) => {}, exportedAt = new Date().toISOString() } = {}) {
  onProgress('Taking a consistent snapshot…');
  const snapshot = await repository.snapshotArchive();
  const groups = validateArchiveSnapshot(snapshot), warnings = [], entries = [], recordingRows = [];
  const notes = [...snapshot.notes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const recordings = [...snapshot.recordings].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const [index, recording] of recordings.entries()) {
    const rows = groups.get(recording.id), file = rows.length ? `blobs/${String(index).padStart(6, '0')}.${audioExtension(recording.mimeType)}` : null;
    if (recording.status !== 'complete') warnings.push({ recordingId: recording.id, message: rows.length ? 'Saved partial audio; playback may be incomplete.' : 'Recording metadata preserved; no saved audio bytes exist.' });
    let offset = 0;
    const chunks = rows.map((row) => { const descriptor = { id: row.id, sequence: row.sequence, offset, byteLength: row.blob.size, mimeType: row.blob.type }; offset += row.blob.size; return descriptor; });
    recordingRows.push({ recording, file, chunks });
    if (file) entries.push({ path: file, blob: new Blob(rows.map((row) => row.blob), { type: recording.mimeType }) });
  }
  entries.unshift({ path: 'notes.json', blob: jsonBlob(notes) }, { path: 'recordings.json', blob: jsonBlob(recordingRows) });
  const files = [];
  let payloadSize = 0;
  for (const [index, entry] of entries.entries()) {
    payloadSize += entry.blob.size;
    if (entry.blob.size > ARCHIVE_LIMITS.maxEntryBytes || payloadSize > ARCHIVE_LIMITS.maxArchiveBytes) fail('Audio exceeds the supported archive size limit (512 MiB per file; 1 GiB total).');
    onProgress(`Checking file ${index + 1} of ${entries.length}…`);
    files.push({ path: entry.path, byteLength: entry.blob.size, sha256: await sha256Blob(entry.blob) });
  }
  const manifest = { format: 'noteos.archive', version: 2, exportedAt, sourcePlatform: 'web', counts: { notes: notes.length, recordings: recordings.length, chunks: snapshot.chunks.length }, files, warnings, skippedEntries: [] };
  const manifestBlob = jsonBlob(manifest);
  onProgress('Preparing archive download…');
  const blob = createTar([{ path: 'manifest.json', blob: manifestBlob }, { path: 'manifest.sha256', blob: new Blob([await sha256Blob(manifestBlob)]) }, ...entries]);
  return { blob, manifest };
}
export async function verifyArchive(blob, { onProgress = (_stage) => {} } = {}) {
  onProgress('Reading archive structure…');
  const entries = await readTar(blob);
  const manifestBlob = entries.get('manifest.json'), checksum = entries.get('manifest.sha256');
  if (!manifestBlob || manifestBlob.size > ARCHIVE_LIMITS.maxJsonBytes || !checksum || checksum.size !== 64 || !/^[0-9a-f]{64}$/.test(await checksum.text()) || await sha256Blob(manifestBlob) !== await checksum.text()) fail('Manifest checksum is missing or invalid.');
  const manifest = await jsonFile(manifestBlob); safeJson(manifest);
  if (manifest.format !== 'noteos.archive' || manifest.version !== 2 || !['web', 'ios'].includes(manifest.sourcePlatform) || typeof manifest.exportedAt !== 'string' || !Number.isFinite(Date.parse(manifest.exportedAt)) || !manifest.counts || !['notes', 'recordings', 'chunks'].every((key) => integer(manifest.counts[key])) || !Array.isArray(manifest.files) || manifest.files.length > ARCHIVE_LIMITS.maxEntries - 2 || !Array.isArray(manifest.warnings) || !Array.isArray(manifest.skippedEntries) || manifest.skippedEntries.length) fail('Unsupported or malformed archive manifest.');
  const expected = new Set(['manifest.json', 'manifest.sha256']);
  for (const [index, file] of manifest.files.entries()) {
    if (!file || typeof file.path !== 'string' || !/^(notes\.json|recordings\.json|blobs\/[0-9]{6}\.(webm|ogg|m4a|wav|mp3|aac|flac))$/.test(file.path) || expected.has(file.path) || !integer(file.byteLength) || !/^[0-9a-f]{64}$/.test(file.sha256)) fail('Invalid or duplicate manifest file.');
    const entry = entries.get(file.path);
    if (!entry || entry.size !== file.byteLength) fail('Missing archive entry or incorrect byte length.');
    onProgress(`Verifying file ${index + 1} of ${manifest.files.length}…`);
    if (await sha256Blob(entry) !== file.sha256) fail('Archive checksum mismatch. Nothing was imported.');
    expected.add(file.path);
  }
  if (entries.size !== expected.size || !expected.has('notes.json') || !expected.has('recordings.json')) fail('Missing or unexpected archive files.');
  const notes = await jsonFile(entries.get('notes.json')), rows = await jsonFile(entries.get('recordings.json'));
  if (!Array.isArray(rows) || rows.length > ARCHIVE_LIMITS.maxRecordings) fail('Invalid recordings file.');
  const recordings = [], chunks = [], audioPaths = new Set();
  for (const row of rows) {
    if (!row || !Array.isArray(row.chunks) || row.chunks.length > ARCHIVE_LIMITS.maxChunks) fail('Invalid audio chunk descriptors.');
    checkRecording(row.recording);
    const { recording } = row; recordings.push(recording);
    if (!row.chunks.length) { if (row.file !== null) fail('Unexpected empty recording file.'); continue; }
    const audio = entries.get(row.file);
    if (!audio || !expected.has(row.file) || !/^blobs\/[0-9]{6}\./.test(row.file) || !row.file.endsWith(`.${audioExtension(recording.mimeType)}`) || audioPaths.has(row.file)) fail('Missing, reused or inconsistent audio entry.');
    audioPaths.add(row.file); let offset = 0;
    for (const [sequence, chunk] of row.chunks.entries()) {
      if (!chunk || !id(chunk.id) || chunk.sequence !== sequence || chunk.offset !== offset || !integer(chunk.byteLength) || !chunk.byteLength || typeof chunk.mimeType !== 'string' || offset + chunk.byteLength > audio.size) fail('Invalid audio chunk ordering or byte ranges.');
      if (chunk.mimeType) audioExtension(chunk.mimeType);
      chunks.push({ id: chunk.id, recordingId: recording.id, sequence, blob: audio.slice(offset, offset + chunk.byteLength, chunk.mimeType) });
      if (chunks.length > ARCHIVE_LIMITS.maxChunks) fail('Too many audio chunks.');
      offset += chunk.byteLength;
    }
    if (offset !== audio.size) fail('Audio contains unaccounted bytes.');
  }
  if ([...expected].filter((path) => path.startsWith('blobs/')).length !== audioPaths.size) fail('Unreferenced audio entry.');
  const snapshot = { notes, recordings, chunks };
  validateArchiveSnapshot(snapshot);
  if (notes.length !== manifest.counts.notes || recordings.length !== manifest.counts.recordings || chunks.length !== manifest.counts.chunks) fail('Archive record counts do not match.');
  const result = freeze({ ...snapshot, manifest }); verified.add(result); return result;
}
export function requireVerifiedArchive(snapshot) { if (!verified.has(snapshot)) fail('Verify the complete archive before opening an import transaction.'); }
export async function restoreBackup(file, repository, mode = 'merge', options = {}) {
  if (!(file instanceof Blob) || file.size > ARCHIVE_LIMITS.maxArchiveBytes) fail('Unsupported or excessive backup size.');
  const prefix = new Uint8Array(await file.slice(257, 263).arrayBuffer());
  if (String.fromCharCode(...prefix) !== 'ustar\0') {
    options.onProgress?.('Validating legacy notes-only JSON…');
    if (file.size > ARCHIVE_LIMITS.maxJsonBytes) fail('Legacy JSON exceeds the 16 MiB limit.');
    const bundle = parseBackup(await jsonFile(file));
    const result = await repository.importNotes(bundle.notes, mode);
    return { importedNotes: result.imported, skippedNotes: result.skipped, importedRecordings: 0, skippedRecordings: 0, version: 1, warnings: [] };
  }
  const snapshot = await verifyArchive(file, options);
  options.onProgress?.('Committing verified notes and audio together…');
  return { ...await repository.importArchive(snapshot, mode), version: 2, warnings: snapshot.recordings.filter((recording) => recording.status !== 'complete') };
}
