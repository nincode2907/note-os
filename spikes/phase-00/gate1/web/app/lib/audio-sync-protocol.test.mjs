import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateAudioManifest, AUDIO_SYNC_CHUNK_BYTES } from './audio-sync-protocol.mjs';

const bytes = Buffer.from('synthetic protocol audio'), sha = createHash('sha256').update(bytes).digest('hex');
function manifest() {
  return { protocolVersion: 1, transferId: '123e4567-e89b-42d3-a456-426614174000', baseServerVersion: 0,
    recording: { id: 'recording-proto', noteId: 'note-proto', title: 'Ghi âm — 東京 🎧', mimeType: 'audio/webm;codecs=opus', status: 'complete', createdAt: 1, updatedAt: 2, durationMs: 1000, extensions: { originalCapture: 'web' } },
    anchors: { version: 1, items: [{ id: 'anchor-proto', recordingId: 'recording-proto', offsetMs: 500, label: 'Điểm chính 📝', createdAt: 3 }] },
    sha256: sha, totalBytes: bytes.length, chunkSize: AUDIO_SYNC_CHUNK_BYTES, chunks: [{ index: 0, byteLength: bytes.length, sha256: sha }] };
}

test('audio transfer manifest preserves Unicode labels and supported extension metadata', () => {
  const parsed = validateAudioManifest(manifest());
  assert.equal(parsed.recording.title, 'Ghi âm — 東京 🎧'); assert.equal(parsed.anchors.items[0].label, 'Điểm chính 📝'); assert.deepEqual(parsed.recording.extensions, { originalCapture: 'web' });
});
test('manifest rejects incomplete recordings, bad byte lengths, changed hashes and unsupported schema keys', () => {
  for (const mutate of [value => { value.recording.status = 'interrupted'; }, value => { value.totalBytes++; }, value => { value.chunks[0].sha256 = '0'.repeat(64); value.sha256 = '1'.repeat(64); }, value => { value.recording.surprise = true; }]) {
    const invalid = manifest(); mutate(invalid); assert.throws(() => validateAudioManifest(invalid));
  }
});
test('anchor set is checked against stable recording identity and known duration', () => {
  const invalid = manifest(); invalid.anchors.items[0].offsetMs = 1001;
  assert.throws(() => validateAudioManifest(invalid), /duration/);
});
test('service worker keeps every API route network-only and rejects private no-store responses from caches', () => {
  const workerPath = fileURLToPath(new URL('../../public/sw.js', import.meta.url)), source = readFileSync(workerPath, 'utf8');
  assert.match(source, /if \(url\.pathname\.startsWith\('\/api\/'\)\) return false/);
  assert.match(source, /if \(isSyncApi\(url\)\)\s*\{\s*event\.respondWith\(fetch\(request, \{ cache: 'no-store' \}\)\)/);
  assert.match(source, /no-store[\s\S]*private/);
});
