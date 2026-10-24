import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalJson } from './sync-protocol.mjs';
import { validateAudioAnchorSet } from './audio-anchors.mjs';

export const AUDIO_SYNC_PROTOCOL_VERSION = 1;
export const AUDIO_SYNC_CHUNK_BYTES = 1024 * 1024;
export const AUDIO_SYNC_MAX_RECORDING_BYTES = 512 * 1024 * 1024;
export const AUDIO_SYNC_MAX_CHUNKS = AUDIO_SYNC_MAX_RECORDING_BYTES / AUDIO_SYNC_CHUNK_BYTES;
export const AUDIO_SYNC_DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const AUDIO_SYNC_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AUDIO_SYNC_MAX_JSON_BYTES = 256 * 1024;

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const supportedMimeTypes = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/wav',
  'audio/wave', 'audio/x-wav', 'audio/mpeg', 'audio/aac', 'audio/flac',
]);

function assertJson(value, depth = 0) {
  if (depth > 32) throw new TypeError('Audio metadata nesting is excessive.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const row of value) assertJson(row, depth + 1); return; }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Audio metadata must be JSON data.');
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('Unsafe audio metadata key.');
    assertJson(child, depth + 1);
  }
}

export function validateAudioManifest(value, { transferId = value?.transferId, maxBytes = AUDIO_SYNC_MAX_RECORDING_BYTES } = {}) {
  const expected = 'anchors,baseServerVersion,chunkSize,chunks,protocolVersion,recording,sha256,totalBytes,transferId';
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== expected || value.protocolVersion !== AUDIO_SYNC_PROTOCOL_VERSION) throw new TypeError('Invalid audio transfer manifest.');
  if (!id(transferId) || value.transferId !== transferId || !id(value.recording?.id) || !id(value.recording?.noteId)) throw new TypeError('Invalid audio or transfer identity.');
  if (!value.recording || typeof value.recording !== 'object' || Array.isArray(value.recording)) throw new TypeError('Invalid recording metadata.');
  const recording = value.recording;
  const allowedRecordingKeys = ['createdAt', 'durationMs', 'extensions', 'id', 'mimeType', 'nativeProvenance', 'noteId', 'status', 'title', 'updatedAt'];
  if (Object.keys(recording).some(key => !allowedRecordingKeys.includes(key)) || !['id','noteId','title','mimeType','status','createdAt','updatedAt','durationMs'].every(key => Object.hasOwn(recording, key))) throw new TypeError('Unsupported recording metadata fields.');
  assertJson(recording);
  if (recording.status !== 'complete' || typeof recording.title !== 'string' || !recording.title.trim() || [...recording.title].length > 120 ||
      !integer(recording.createdAt) || !integer(recording.updatedAt) || !integer(recording.durationMs) || typeof recording.mimeType !== 'string' ||
      !/^audio\/[a-z0-9.-]+(?:;\s*codecs=(?:[a-zA-Z0-9.,_-]+|"[a-zA-Z0-9.,_ -]+"))?$/i.test(recording.mimeType) ||
      !supportedMimeTypes.has(recording.mimeType.split(';')[0].toLowerCase()) || recording.mimeType.length > 160) throw new TypeError('Recording is not complete or its metadata is invalid.');
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1 || value.totalBytes > maxBytes || value.chunkSize !== AUDIO_SYNC_CHUNK_BYTES ||
      !Number.isSafeInteger(value.baseServerVersion) || value.baseServerVersion < 0 || !digest(value.sha256) || !Array.isArray(value.chunks) ||
      value.chunks.length < 1 || value.chunks.length > AUDIO_SYNC_MAX_CHUNKS) throw new TypeError('Audio size, digest or chunk manifest is invalid.');
  let bytes = 0;
  for (const [index, chunk] of value.chunks.entries()) {
    if (!chunk || Array.isArray(chunk) || Object.keys(chunk).sort().join(',') !== 'byteLength,index,sha256' || chunk.index !== index ||
        !Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < 1 || chunk.byteLength > value.chunkSize || !digest(chunk.sha256) ||
        index < value.chunks.length - 1 && chunk.byteLength !== value.chunkSize) throw new TypeError('Audio chunk manifest is malformed.');
    bytes += chunk.byteLength;
  }
  if (bytes !== value.totalBytes) throw new TypeError('Audio chunk lengths do not match the total byte length.');
  if (value.chunks.length === 1 && value.chunks[0].sha256 !== value.sha256) throw new TypeError('Single audio chunk hash must match the full recording hash.');
  const anchors = validateAudioAnchorSet(value.anchors, recording.id, { durationMs: recording.durationMs, durationKnown: recording.durationMs > 0 });
  return { ...value, recording: { ...recording }, anchors };
}

export function audioManifestHash(manifest) {
  const bytes = sha256(new TextEncoder().encode(canonicalJson(manifest)));
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

export function audioMetadataHash(recording, anchors, sha256Hex, totalBytes) {
  const data = canonicalJson({ anchors, recording, sha256: sha256Hex, totalBytes });
  return Array.from(sha256(new TextEncoder().encode(data)), value => value.toString(16).padStart(2, '0')).join('');
}
