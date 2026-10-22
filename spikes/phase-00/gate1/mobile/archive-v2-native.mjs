import { sha256 } from '@noble/hashes/sha2.js';
import { assertNoteRecord } from '../web/app/lib/note-validation.mjs';
import { validateAudioAnchorSet } from '../web/app/lib/audio-anchors.mjs';

export const NATIVE_ARCHIVE_LIMITS = Object.freeze({ maxArchiveBytes: 1024 ** 3, maxEntryBytes: 512 * 1024 ** 2, maxJsonBytes: 16 * 1024 ** 2, maxEntries: 10004, maxNotes: 50000, maxRecordings: 10000, maxChunks: 100000, ioChunkBytes: 64 * 1024 });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const zero = bytes => bytes.every(byte => byte === 0);
const fail = message => { throw new Error(message); };
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const audioExtensions = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/aac': 'aac', 'audio/flac': 'flac' };

export function audioExtension(mime) {
  if (typeof mime !== 'string' || mime.length > 160 || !/^audio\/[a-z0-9.-]+(?:;\s*codecs=(?:[a-zA-Z0-9.,_-]+|"[a-zA-Z0-9.,_ -]+"))?$/iu.test(mime)) fail('Unsupported audio MIME type.');
  return audioExtensions[mime.split(';')[0].toLowerCase()] ?? fail('Unsupported audio MIME type.');
}

export function safeArchivePath(path) {
  if (typeof path !== 'string' || path.length > 99 || !/^[a-z0-9][a-z0-9._/-]*$/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('Unsafe archive entry path.');
  return path;
}
export function assertAvailableSpace(availableBytes, requiredBytes, reserveBytes = 16 * 1024 ** 2, activity = 'complete this operation') {
  if (!integer(requiredBytes) || !integer(reserveBytes)) fail('Invalid storage estimate.');
  if (availableBytes == null || !Number.isFinite(availableBytes) || availableBytes < 0) return { checked: false, requiredBytes: requiredBytes + reserveBytes };
  if (availableBytes < requiredBytes + reserveBytes) fail(`Not enough free space to ${activity}. Free at least ${Math.ceil((requiredBytes + reserveBytes) / 1024 ** 2)} MiB and try again.`);
  return { checked: true, requiredBytes: requiredBytes + reserveBytes };
}

function safeJson(value, depth = 0) {
  if (depth > 64) fail('Archive metadata nesting is excessive.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const child of value) safeJson(child, depth + 1); return; }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('Archive metadata must contain JSON values.');
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Unsafe archive metadata key.');
    safeJson(child, depth + 1);
  }
}
function portableRecordingMetadata(value) {
  if (Array.isArray(value)) return value.map(portableRecordingMetadata);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) if (key !== 'file_uri' && key !== 'fileUri') result[key] = portableRecordingMetadata(child);
  return result;
}

function parseJson(bytes, label) {
  try { const value = JSON.parse(decoder.decode(bytes)); safeJson(value); return value; }
  catch (error) { throw new Error(`${label} is invalid UTF-8 JSON: ${error instanceof Error ? error.message : 'invalid data'}`); }
}

function validateRecording(recording) {
  safeJson(recording);
  if (!recording || Array.isArray(recording) || !validId(recording.id) || !validId(recording.noteId) || !validId(recording.ownerId) || typeof recording.title !== 'string' || !recording.title.trim() || recording.title.length > 120 || !['complete', 'interrupted', 'failed'].includes(recording.status) || !['createdAt', 'updatedAt', 'durationMs', 'chunkCount'].every(key => integer(recording[key]))) fail('Invalid recording metadata.');
  audioExtension(recording.mimeType);
  validateAudioAnchorSet(recording.audioAnchors, recording.id, { durationMs: recording.durationMs, durationKnown: recording.nativeProvenance?.durationKnown !== false && recording.durationMs > 0 });
}

function digest(bytes) { return Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join(''); }
function streamHash() { return sha256.create(); }
function openByteReader(stream) {
  try {
    const reader = stream.getReader({ mode: 'byob' });
    return { reader, read: () => reader.read(new Uint8Array(NATIVE_ARCHIVE_LIMITS.ioChunkBytes)) };
  } catch {
    const reader = stream.getReader();
    return { reader, read: () => reader.read() };
  }
}
/** @param {ReadableStream<Uint8Array>} stream */
export async function hashReadableStream(stream) {
  const hash = streamHash(); let size = 0; const { reader, read } = openByteReader(stream);
  try { while (true) { const { value, done } = await read(); if (done) break; size += value.byteLength; hash.update(value); } }
  finally { reader.releaseLock(); }
  return { size, sha256: Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('') };
}

class StreamReader {
  constructor(stream) { const opened = openByteReader(stream); this.reader = opened.reader; this.readNext = opened.read; this.parts = []; this.available = 0; this.ended = false; this.totalRead = 0; }
  async take(count, allowEof = false) {
    while (this.available < count && !this.ended) {
      const { value, done } = await this.readNext();
      if (done) { this.ended = true; break; }
      if (!(value instanceof Uint8Array)) fail('Archive stream returned non-byte data.');
      this.totalRead += value.byteLength;
      this.parts.push(value); this.available += value.byteLength;
    }
    if (this.available < count) {
      if (allowEof && this.available === 0) return null;
      fail('Truncated TAR archive.');
    }
    const output = new Uint8Array(count); let written = 0;
    while (written < count) {
      const part = this.parts[0], amount = Math.min(part.byteLength, count - written);
      output.set(part.subarray(0, amount), written); written += amount; this.available -= amount;
      if (amount === part.byteLength) this.parts.shift(); else this.parts[0] = part.subarray(amount);
    }
    return output;
  }
  async drainZeroTail(limit) {
    let count = 0;
    while (this.available || !this.ended) {
      if (!this.available) {
        const { value, done } = await this.readNext();
        if (done) { this.ended = true; break; }
        this.parts.push(value); this.available += value.byteLength; this.totalRead += value.byteLength;
      }
      const part = this.parts.shift(); count += part.byteLength;
      if (count > limit || !zero(part)) fail('Invalid TAR end marker.');
    }
    return count;
  }
  async cancel() { try { await this.reader.cancel(); } catch {} }
}

function parseOctal(bytes, label) {
  const text = decoder.decode(bytes).replace(/[\0 ]+$/gu, '');
  if (!/^[0-7]+$/u.test(text)) fail(`Invalid TAR ${label}.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail('Unsafe TAR entry size.');
  return value;
}

function parseHeader(header) {
  const field = (start, end) => {
    const bytes = header.subarray(start, end), nul = bytes.indexOf(0);
    if (nul >= 0 && !zero(bytes.subarray(nul))) fail('Invalid TAR header field.');
    return decoder.decode(nul < 0 ? bytes : bytes.subarray(0, nul));
  };
  const advertised = parseOctal(header.subarray(148, 156), 'checksum');
  const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (advertised !== actual || field(257, 263) !== 'ustar' || decoder.decode(header.subarray(263, 265)) !== '00' || ![0, 48].includes(header[156]) || field(157, 257) || !zero(header.subarray(345))) fail('Unsupported or corrupt TAR header.');
  const path = safeArchivePath(field(0, 100)), size = parseOctal(header.subarray(124, 136), 'size');
  if (size > NATIVE_ARCHIVE_LIMITS.maxEntryBytes) fail('Archive entry exceeds the 512 MiB native limit.');
  return { path, size };
}

async function scanTar(stream, { onEntryStart = () => {}, onEntryChunk = () => {}, onEntryEnd = () => {}, onProgress = () => {}, maxArchiveBytes = NATIVE_ARCHIVE_LIMITS.maxArchiveBytes } = {}) {
  const input = new StreamReader(stream), entries = new Map(); let offset = 0, entryCount = 0, payloadSize = 0;
  try {
    while (true) {
      const header = await input.take(512, true);
      if (!header) fail('Missing TAR end marker.');
      offset += 512;
      if (zero(header)) {
        const second = await input.take(512);
        if (!zero(second)) fail('Invalid TAR end marker.');
        offset += 512;
        const tail = await input.drainZeroTail(10 * 1024 - 1024);
        if (tail % 512 !== 0 || offset + tail > maxArchiveBytes) fail('Invalid TAR end marker.');
        return entries;
      }
      if (++entryCount > NATIVE_ARCHIVE_LIMITS.maxEntries) fail('Archive has too many entries.');
      const { path, size } = parseHeader(header);
      if (entries.has(path)) fail('Duplicate TAR entry path.');
      payloadSize += size;
      if (!Number.isSafeInteger(payloadSize) || offset + size > maxArchiveBytes) fail('Archive exceeds the 1 GiB native limit.');
      const entry = { path, size, offset, sha256: null };
      entries.set(path, entry); await onEntryStart(entry);
      const hasher = streamHash(); let remaining = size;
      while (remaining > 0) {
        const bytes = await input.take(Math.min(remaining, NATIVE_ARCHIVE_LIMITS.ioChunkBytes));
        hasher.update(bytes); await onEntryChunk(entry, bytes); remaining -= bytes.byteLength; offset += bytes.byteLength;
        if (offset > maxArchiveBytes) fail('Archive exceeds the 1 GiB native limit.');
      }
      entry.sha256 = Array.from(hasher.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
      const paddingLength = (512 - size % 512) % 512;
      if (paddingLength) { const padding = await input.take(paddingLength); if (!zero(padding)) fail('Invalid TAR entry padding.'); offset += paddingLength; }
      await onEntryEnd(entry); onProgress(`Verified ${entry.path}`);
      if (offset + 1024 > maxArchiveBytes) fail('Archive exceeds the 1 GiB native limit.');
    }
  } catch (error) { await input.cancel(); throw error; }
}

function validateSnapshot(notes, rows, entries, manifest) {
  if (!Array.isArray(notes) || notes.length > NATIVE_ARCHIVE_LIMITS.maxNotes || !Array.isArray(rows) || rows.length > NATIVE_ARCHIVE_LIMITS.maxRecordings) fail('Archive record count exceeds the supported limit.');
  const noteIds = new Set(), recordingIds = new Set(), chunkIds = new Set(), audioPaths = new Set();
  for (const note of notes) { assertNoteRecord(note, { allowUnsupported: true }); if (noteIds.has(note.id)) fail('Duplicate note ID.'); noteIds.add(note.id); }
  let totalChunks = 0;
  for (const row of rows) {
    if (!row || Array.isArray(row) || !Array.isArray(row.chunks) || row.chunks.length > NATIVE_ARCHIVE_LIMITS.maxChunks) fail('Invalid recording archive row.');
    const recording = row.recording; validateRecording(recording);
    if (recordingIds.has(recording.id) || !noteIds.has(recording.noteId)) fail('Duplicate recording ID or missing note relationship.');
    recordingIds.add(recording.id); totalChunks += row.chunks.length;
    if (totalChunks > NATIVE_ARCHIVE_LIMITS.maxChunks || row.chunks.length !== recording.chunkCount) fail('Recording chunk count is inconsistent.');
    if (recording.status === 'complete' && row.chunks.length === 0) fail('A complete recording has no audio bytes.');
    if (row.chunks.length === 0) { if (row.file !== null) fail('Unexpected empty recording file.'); continue; }
    const audio = entries.get(row.file);
    if (!audio || !/^blobs\/[0-9]{6}\.(webm|ogg|m4a|wav|mp3|aac|flac)$/u.test(row.file) || !row.file.endsWith(`.${audioExtension(recording.mimeType)}`) || audioPaths.has(row.file)) fail('Missing, reused or inconsistent audio entry.');
    audioPaths.add(row.file); let offset = 0;
    for (const [sequence, chunk] of row.chunks.entries()) {
      if (!chunk || !validId(chunk.id) || chunkIds.has(chunk.id) || chunk.sequence !== sequence || chunk.offset !== offset || !integer(chunk.byteLength) || chunk.byteLength === 0 || typeof chunk.mimeType !== 'string' || offset + chunk.byteLength > audio.size) fail('Invalid, duplicate or out-of-order audio chunk descriptor.');
      if (chunk.mimeType) audioExtension(chunk.mimeType);
      if (chunk.mimeType.split(';')[0].toLowerCase() !== recording.mimeType.split(';')[0].toLowerCase()) fail('Audio chunk MIME does not match its recording.');
      chunkIds.add(chunk.id); offset += chunk.byteLength;
    }
    if (offset !== audio.size) fail('Audio entry contains unaccounted bytes.');
  }
  const expectedChunkCount = rows.reduce((sum, row) => sum + row.chunks.length, 0);
  if (manifest.counts.notes !== notes.length || manifest.counts.recordings !== rows.length || manifest.counts.chunks !== expectedChunkCount) fail('Archive record counts do not match the manifest.');
  if ([...entries.keys()].filter(path => path.startsWith('blobs/')).length !== audioPaths.size) fail('Archive contains an unreferenced audio entry.');
}

/** @param {ReadableStream<Uint8Array>} stream @param {{onProgress?: (message: string) => void, maxArchiveBytes?: number}} [options] */
export async function verifyArchiveStream(stream, options = {}) {
  const jsonBodies = new Map();
  const entries = await scanTar(stream, {
    ...options,
    onEntryStart: async entry => {
      if (['manifest.json', 'manifest.sha256', 'notes.json', 'recordings.json'].includes(entry.path)) {
        if (entry.size > NATIVE_ARCHIVE_LIMITS.maxJsonBytes) fail('Archive JSON exceeds the 16 MiB metadata limit.');
        jsonBodies.set(entry.path, []);
      }
    },
    onEntryChunk: async (entry, bytes) => { if (jsonBodies.has(entry.path)) jsonBodies.get(entry.path).push(bytes); },
  });
  const json = path => { const chunks = jsonBodies.get(path); if (!chunks) return fail(`Missing ${path}.`); jsonBodies.delete(path); return parseJson(joinBytes(chunks), path); };
  const checksumBytes = jsonBodies.get('manifest.sha256');
  if (!checksumBytes) fail('Missing manifest checksum.');
  jsonBodies.delete('manifest.sha256');
  const manifestHash = decoder.decode(joinBytes(checksumBytes));
  const manifestEntry = entries.get('manifest.json');
  if (!manifestEntry || !/^[0-9a-f]{64}$/u.test(manifestHash) || manifestEntry.sha256 !== manifestHash) fail('Manifest checksum is missing or invalid.');
  const manifest = json('manifest.json'); safeJson(manifest);
  if (manifest.format !== 'noteos.archive' || manifest.version !== 2 || !['web', 'ios'].includes(manifest.sourcePlatform) || typeof manifest.exportedAt !== 'string' || !Number.isFinite(Date.parse(manifest.exportedAt)) || !manifest.counts || !['notes', 'recordings', 'chunks'].every(key => integer(manifest.counts[key])) || !Array.isArray(manifest.files) || manifest.files.length > NATIVE_ARCHIVE_LIMITS.maxEntries - 2 || !Array.isArray(manifest.warnings) || !Array.isArray(manifest.skippedEntries) || manifest.skippedEntries.length) fail('Unsupported or malformed archive manifest.');
  const expected = new Set(['manifest.json', 'manifest.sha256']);
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !/^(notes\.json|recordings\.json|blobs\/[0-9]{6}\.(webm|ogg|m4a|wav|mp3|aac|flac))$/u.test(file.path) || expected.has(file.path) || !integer(file.byteLength) || !/^[0-9a-f]{64}$/u.test(file.sha256)) fail('Invalid or duplicate manifest entry.');
    const actual = entries.get(file.path);
    if (!actual || actual.size !== file.byteLength || actual.sha256 !== file.sha256) fail('Missing archive entry, incorrect length, or checksum mismatch. Nothing was imported.');
    expected.add(file.path);
  }
  if (entries.size !== expected.size || !expected.has('notes.json') || !expected.has('recordings.json')) fail('Archive contains missing or unexpected files.');
  const notes = json('notes.json'), rows = json('recordings.json');
  validateSnapshot(notes, rows, entries, manifest);
  return { manifest, notes, recordingRows: rows, media: rows.filter(row => row.chunks.length).map(row => ({ recordingId: row.recording.id, path: row.file, size: entries.get(row.file).size, sha256: entries.get(row.file).sha256, mimeType: row.recording.mimeType })) };
}

function joinBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function octal(value, width) { return value.toString(8).padStart(width - 1, '0') + '\0'; }
function tarHeader(path, size) {
  safeArchivePath(path); const header = new Uint8Array(512);
  const put = (offset, text) => header.set(encoder.encode(text), offset);
  put(0, path); put(100, octal(0o600, 8)); put(108, octal(0, 8)); put(116, octal(0, 8)); put(124, octal(size, 12)); put(136, octal(0, 12)); put(148, '        '); put(156, '0'); put(257, 'ustar\0'); put(263, '00');
  put(148, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ');
  return header;
}

async function writeAll(writer, bytes) { if (bytes.byteLength) await writer.write(bytes); }
async function writeTarEntry(writer, path, size, stream, onChunk) {
  await writeAll(writer, tarHeader(path, size)); let written = 0;
  const { reader, read } = openByteReader(stream);
  try {
    while (true) {
      const { value, done } = await read(); if (done) break;
      if (!(value instanceof Uint8Array) || written + value.byteLength > size) fail(`File changed during archive generation: ${path}`);
      written += value.byteLength; onChunk?.(value); await writeAll(writer, value);
    }
  } finally { reader.releaseLock(); }
  if (written !== size) fail(`File changed during archive generation: ${path}`);
  const pad = (512 - size % 512) % 512; if (pad) await writeAll(writer, new Uint8Array(pad));
}

async function hashFile(readStream, onBytes) {
  const hash = streamHash(); let size = 0; const { reader, read } = openByteReader(readStream());
  try { while (true) { const { value, done } = await read(); if (done) break; size += value.byteLength; hash.update(value); onBytes?.(value); } }
  finally { reader.releaseLock(); }
  return { size, sha256: Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('') };
}

/** @param {{notes: any[], recordings: any[], readStream: (uri: string) => ReadableStream<Uint8Array>, stat: (uri: string) => {exists: boolean; size?: number; modificationTime?: number|null}|Promise<{exists: boolean; size?: number; modificationTime?: number|null}>, exportedAt?: string, onProgress?: (message: string) => void}} input */
export async function buildArchivePlan({ notes, recordings, readStream, stat, exportedAt = new Date().toISOString(), onProgress = () => {} }) {
  if (!Array.isArray(notes) || !Array.isArray(recordings) || notes.length > NATIVE_ARCHIVE_LIMITS.maxNotes || recordings.length > NATIVE_ARCHIVE_LIMITS.maxRecordings) fail('Archive record count exceeds the supported limit.');
  const sortedNotes = [...notes].sort((a, b) => a.id.localeCompare(b.id));
  const noteIds = new Set(); for (const note of sortedNotes) { assertNoteRecord(note, { allowUnsupported: true }); if (noteIds.has(note.id)) fail('Duplicate note ID.'); noteIds.add(note.id); }
  const sortedRecordings = [...recordings].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(), rows = [], media = [], warnings = [];
  for (const [index, source] of sortedRecordings.entries()) {
    const meta = source.archiveMetadata ?? {};
    if (!validId(source.id) || !validId(source.note_id) || !noteIds.has(source.note_id) || ids.has(source.id)) fail('Invalid, duplicate, or orphan native recording metadata.');
    ids.add(source.id);
    const mimeType = meta.mimeType ?? source.mimeType;
    const status = source.status;
    const uri = source.file_uri || null;
    let info = null;
    if (uri) {
      const before = await stat(uri);
      if (!before?.exists || !integer(before.size)) fail(`Recording file is missing: ${source.title || source.id}. Full archive was not created.`);
      if (status === 'complete' && before.size === 0) fail(`Completed recording is empty: ${source.title || source.id}. Full archive was not created.`);
      if (before.size > NATIVE_ARCHIVE_LIMITS.maxEntryBytes) fail('A recording exceeds the 512 MiB per-file limit.');
      info = await hashFile(() => readStream(uri));
      const after = await stat(uri);
      if (!after?.exists || after.size !== before.size || (before.modificationTime != null && after.modificationTime !== before.modificationTime) || info.size !== before.size) fail(`Recording changed during backup: ${source.title || source.id}. Retry after it is no longer in use.`);
    }
    if (status === 'complete' && !info?.size) fail(`Completed recording has no audio file: ${source.title || source.id}.`);
    const file = info?.size ? `blobs/${String(index).padStart(6, '0')}.${audioExtension(mimeType)}` : null;
    const original = portableRecordingMetadata(meta.sourceRecording ?? {});
    const recording = {
      ...original,
      id: source.id,
      noteId: source.note_id,
      ownerId: meta.ownerId ?? original.ownerId ?? 'ios-local',
      title: source.title || original.title || 'Audio recording',
      mimeType,
      status,
      createdAt: source.created_at,
      updatedAt: meta.updatedAt ?? source.created_at,
      durationMs: meta.durationMs ?? original.durationMs ?? 0,
      ...(meta.audioAnchors ?? original.audioAnchors ? { audioAnchors: meta.audioAnchors ?? original.audioAnchors } : {}),
      chunkCount: info?.size ? 1 : 0,
      nativeProvenance: {
        sourcePlatform: meta.sourcePlatform ?? 'ios', durationKnown: meta.durationKnown === true,
        normalizedChunkCount: info?.size ? 1 : 0,
        ...(original.status ? { originalStatus: original.status } : {}),
        ...((meta.sourceRecording?.nativeProvenance?.sourceChunkDescriptors ?? meta.sourceChunkDescriptors) ? { sourceChunkDescriptors: meta.sourceRecording?.nativeProvenance?.sourceChunkDescriptors ?? meta.sourceChunkDescriptors } : {}),
        ...(meta.sourcePlatform === 'ios' && original.nativeProvenance?.sourceRecordingMetadata
          ? { sourceRecordingMetadata: portableRecordingMetadata(original.nativeProvenance.sourceRecordingMetadata) }
          : meta.sourcePlatform === 'web' && Object.keys(original).length
            ? { sourceRecordingMetadata: portableRecordingMetadata(original) }
            : {}),
      },
    };
    validateRecording(recording);
    if (status !== 'complete') warnings.push({ recordingId: source.id, message: info?.size ? 'Saved partial audio; playback may be incomplete.' : 'Recording metadata preserved; no audio bytes were available.' });
    const chunks = info?.size ? [{ id: `${source.id}:ios:0`, sequence: 0, offset: 0, byteLength: info.size, mimeType }] : [];
    rows.push({ recording, file, chunks });
    if (file) media.push({ recordingId: source.id, path: file, size: info.size, sha256: info.sha256, mimeType, uri });
    onProgress(`Checked recording ${index + 1} of ${sortedRecordings.length}`);
  }
  const snapshotRows = rows;
  const notesBytes = encoder.encode(JSON.stringify(sortedNotes));
  const recordingsBytes = encoder.encode(JSON.stringify(snapshotRows));
  if (notesBytes.byteLength > NATIVE_ARCHIVE_LIMITS.maxJsonBytes || recordingsBytes.byteLength > NATIVE_ARCHIVE_LIMITS.maxJsonBytes) fail('Archive JSON exceeds the 16 MiB metadata limit.');
  const files = [
    { path: 'notes.json', byteLength: notesBytes.byteLength, sha256: digest(notesBytes) },
    { path: 'recordings.json', byteLength: recordingsBytes.byteLength, sha256: digest(recordingsBytes) },
    ...media.map(item => ({ path: item.path, byteLength: item.size, sha256: item.sha256 })),
  ];
  const manifest = { format: 'noteos.archive', version: 2, exportedAt, sourcePlatform: 'ios', counts: { notes: sortedNotes.length, recordings: rows.length, chunks: rows.reduce((sum, row) => sum + row.chunks.length, 0) }, files, warnings, skippedEntries: [] };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > NATIVE_ARCHIVE_LIMITS.maxJsonBytes) fail('Archive manifest exceeds the 16 MiB limit.');
  const actualEntrySizes = [manifestBytes.byteLength, 64, notesBytes.byteLength, recordingsBytes.byteLength, ...media.map(item => item.size)];
  const total = 1024 + actualEntrySizes.reduce((sum, size) => sum + 512 + size + (512 - size % 512) % 512, 0);
  if (total > NATIVE_ARCHIVE_LIMITS.maxArchiveBytes) fail('Full archive exceeds the 1 GiB limit.');
  return { manifest, manifestBytes, manifestSha256: digest(manifestBytes), notesBytes, recordingsBytes, media, size: total };
}

/** @param {any} plan @param {{uri: string; exists: boolean; writableStream: () => WritableStream<Uint8Array>, info: () => {exists: boolean; size?: number}|Promise<{exists: boolean; size?: number}>; delete: () => void}} outputFile @param {{readStream: (uri: string) => ReadableStream<Uint8Array>, onProgress?: (message: string) => void}} options */
export async function writeArchivePlan(plan, outputFile, { readStream, onProgress = () => {} } = {}) {
  const writer = outputFile.writableStream().getWriter();
  try {
    const metadata = [
      ['manifest.json', plan.manifestBytes],
      ['manifest.sha256', encoder.encode(plan.manifestSha256)],
      ['notes.json', plan.notesBytes],
      ['recordings.json', plan.recordingsBytes],
    ];
    for (const [path, bytes] of metadata) await writeTarEntry(writer, path, bytes.byteLength, new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
    for (const [index, item] of plan.media.entries()) {
      const hash = streamHash(); let size = 0;
      await writeTarEntry(writer, item.path, item.size, readStream(item.uri), bytes => { hash.update(bytes); size += bytes.byteLength; });
      const actual = Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
      if (size !== item.size || actual !== item.sha256) fail(`Recording changed during archive generation: ${item.path}.`);
      onProgress(`Added audio ${index + 1} of ${plan.media.length}`);
    }
    await writeAll(writer, new Uint8Array(1024)); await writer.close();
    const stat = await outputFile.info();
    if (!stat.exists || stat.size !== plan.size) fail('The finished archive size did not match its validated plan.');
    return { file: outputFile, manifest: plan.manifest, size: stat.size };
  } catch (error) { try { await writer.abort(error); } catch {} try { outputFile.delete(); } catch {} throw error; }
}

export function planArchiveImport(verified, existingNotes, existingRecordings, mode = 'merge') {
  if (!verified?.manifest || !Array.isArray(verified.notes) || !Array.isArray(verified.recordingRows)) fail('Archive must be completely verified before import.');
  if (!['merge', 'skip'].includes(mode)) fail('Choose Merge or Skip.');
  const noteIds = new Set(existingNotes.map(note => note.id)), recordingIds = new Set(existingRecordings.map(recording => recording.id));
  const rowsByNote = new Map(); for (const row of verified.recordingRows) { if (!rowsByNote.has(row.recording.noteId)) rowsByNote.set(row.recording.noteId, []); rowsByNote.get(row.recording.noteId).push(row); }
  const conflicts = [];
  for (const note of verified.notes) if (noteIds.has(note.id)) conflicts.push({ type: 'note', id: note.id });
  for (const row of verified.recordingRows) if (recordingIds.has(row.recording.id)) conflicts.push({ type: 'recording', id: row.recording.id });
  if (mode === 'skip' && conflicts.length) fail('An ID collision was found. The entire import was left unchanged. Choose Merge to import non-conflicting note groups.');
  const acceptedNotes = [], acceptedRows = [], skippedNoteIds = new Set();
  for (const note of verified.notes) {
    const group = rowsByNote.get(note.id) ?? [];
    if (noteIds.has(note.id) || group.some(row => recordingIds.has(row.recording.id))) { skippedNoteIds.add(note.id); continue; }
    acceptedNotes.push(note); acceptedRows.push(...group);
  }
  return { mode, notes: acceptedNotes, recordingRows: acceptedRows, skippedNotes: verified.notes.length - acceptedNotes.length, skippedRecordings: verified.recordingRows.length - acceptedRows.length, conflicts };
}

export function adaptArchiveRecording(row, nativeRecording, sourcePlatform, mediaSha256 = null) {
  const sourceRecording = structuredClone(row.recording);
  return {
    ...nativeRecording.archiveMetadata,
    mimeType: sourceRecording.mimeType,
    ownerId: sourceRecording.ownerId,
    updatedAt: sourceRecording.updatedAt,
    durationMs: sourceRecording.durationMs,
    ...(sourceRecording.audioAnchors ?? nativeRecording.archiveMetadata?.audioAnchors ? { audioAnchors: sourceRecording.audioAnchors ?? nativeRecording.archiveMetadata.audioAnchors } : {}),
    durationKnown: typeof sourceRecording.nativeProvenance?.durationKnown === 'boolean' ? sourceRecording.nativeProvenance.durationKnown : true,
    sourcePlatform,
    sourceRecording,
    sourceChunkDescriptors: structuredClone(row.chunks),
    mediaSha256,
  };
}

/** @param {ReadableStream<Uint8Array>} stream @param {any} verified @param {Map<string, {uri: string; writableStream: () => WritableStream<Uint8Array>; delete: () => void}>} destinations @param {{onProgress?: (message: string) => void}} [options] */
export async function streamVerifiedMedia(stream, verified, destinations, { onProgress = () => {} } = {}) {
  const expected = new Map(verified.media.map(item => [item.path, item]));
  const staged = new Map();
  try {
    await scanTar(stream, {
      onEntryStart: async entry => {
        const descriptor = expected.get(entry.path);
        if (descriptor) {
          const target = destinations.get(descriptor.recordingId);
          if (!target) fail('No import staging destination was assigned for validated audio.');
          const writer = target.writableStream().getWriter();
          staged.set(entry.path, { descriptor, target, writer, hash: streamHash(), size: 0 });
        }
      },
      onEntryChunk: async (entry, bytes) => {
        const value = staged.get(entry.path); if (!value) return;
        value.size += bytes.byteLength; value.hash.update(bytes); await value.writer.write(bytes);
      },
      onEntryEnd: async entry => {
        const value = staged.get(entry.path); if (!value) return;
        await value.writer.close();
        const hash = Array.from(value.hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
        if (value.size !== value.descriptor.size || hash !== value.descriptor.sha256) fail('Audio changed between archive verification and staging.');
        onProgress(`Staged audio ${staged.size} of ${expected.size}`);
      },
    });
    if (staged.size !== expected.size) fail('A validated audio entry was not staged.');
    return [...staged.values()].map(({ descriptor, target }) => ({ ...descriptor, stagedUri: target.uri }));
  } catch (error) {
    for (const value of staged.values()) { try { await value.writer.abort(error); } catch {} try { value.target.delete(); } catch {} }
    throw error;
  }
}
