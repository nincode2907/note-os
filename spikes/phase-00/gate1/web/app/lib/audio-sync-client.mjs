import { sha256 } from '@noble/hashes/sha2.js';
import { createAudioRepository } from './local-notes.js';
import { AUDIO_SYNC_CHUNK_BYTES, validateAudioManifest, audioMetadataHash } from './audio-sync-protocol.mjs';
import { emptyAudioAnchorSet, validateAudioAnchorSet } from './audio-anchors.mjs';

const audioRepository = createAudioRepository();
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
async function api(action, { method = 'GET', body, binaryBody, expectBinary = false, fetcher = fetch } = {}) {
  const response = await fetcher(`/api/v1/sync/media/${action}`, { method, credentials: 'same-origin', cache: 'no-store', headers: binaryBody ? { 'Content-Type': 'application/octet-stream', 'X-NoteOS-Sync': '1' } : body === undefined ? {} : { 'Content-Type': 'application/json', 'X-NoteOS-Sync': '1' }, ...(body === undefined && binaryBody === undefined ? {} : { body: binaryBody ?? JSON.stringify(body) }) });
  if (response.status === 204) return null;
  const data = expectBinary ? response : await response.json();
  if (!response.ok) throw Object.assign(new Error(expectBinary ? 'Audio transfer request failed.' : data.error ?? 'Audio transfer request failed.'), { status: response.status, body: data });
  return data;
}
async function digestBlob(blob) {
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += AUDIO_SYNC_CHUNK_BYTES) hash.update(new Uint8Array(await blob.slice(offset, offset + AUDIO_SYNC_CHUNK_BYTES).arrayBuffer()));
  return hex(hash.digest());
}
async function makeManifest(recording, rows, transferId, baseServerVersion) {
  const source = new Blob(rows.map(row => row.blob), { type: recording.mimeType });
  const whole = sha256.create(), chunks = [];
  for (let offset = 0, index = 0; offset < source.size; offset += AUDIO_SYNC_CHUNK_BYTES, index++) {
    const bytes = new Uint8Array(await source.slice(offset, offset + AUDIO_SYNC_CHUNK_BYTES).arrayBuffer());
    whole.update(bytes); chunks.push({ index, byteLength: bytes.byteLength, sha256: hex(sha256(bytes)) });
  }
  const anchors = validateAudioAnchorSet(recording.audioAnchors ?? emptyAudioAnchorSet(recording.id), recording.id, { durationMs: recording.durationMs, durationKnown: recording.durationMs > 0 });
  return { protocolVersion: 1, transferId, baseServerVersion, recording: { id: recording.id, noteId: recording.noteId, title: recording.title, mimeType: recording.mimeType, status: recording.status, createdAt: recording.createdAt, updatedAt: recording.updatedAt, durationMs: recording.durationMs, ...(recording.extensions ? { extensions: recording.extensions } : {}), ...(recording.nativeProvenance ? { nativeProvenance: recording.nativeProvenance } : {}) }, anchors, sha256: hex(whole.digest()), totalBytes: source.size, chunkSize: AUDIO_SYNC_CHUNK_BYTES, chunks, source };
}
async function ensureLocalState(recordingId, repository = audioRepository) {
  const current = await repository.getSyncStateForRecording(recordingId);
  if (current) return current;
  const created = { recordingId, status: 'saved-local', transferId: crypto.randomUUID(), serverVersion: 0, audioCursor: 0 };
  await repository.putSyncState(created); return created;
}

async function uploadRecording(recording, state, fetcher, onProgress, repository) {
  const rows = await repository.chunks(recording.id);
  if (recording.status !== 'complete' || !rows.length) return { ...state, status: 'saved-local', error: 'incomplete_recording' };
  let manifest = await makeManifest(recording, rows, state.transferId ?? crypto.randomUUID(), state.serverVersion ?? 0);
  const requestedMetadataHash = audioMetadataHash(manifest.recording, manifest.anchors, manifest.sha256, manifest.totalBytes);
  if (state.lastMetadataHash && state.lastMetadataHash !== requestedMetadataHash) manifest = await makeManifest(recording, rows, crypto.randomUUID(), state.serverVersion ?? 0);
  const { source, ...wireManifest } = manifest;
  const start = await api('uploads', { method: 'POST', body: { manifest: wireManifest }, fetcher });
  const received = new Set(start.received ?? []);
  if (!start.alreadyCommitted) {
    await repository.putSyncState({ ...state, transferId: manifest.transferId, manifest: wireManifest, status: 'uploading', totalBytes: manifest.totalBytes, verifiedBytes: [...received].reduce((sum,index) => sum + manifest.chunks[index].byteLength, 0) });
    let verifiedBytes = 0;
    for (const index of [...received]) verifiedBytes += manifest.chunks[index].byteLength;
    for (let index = 0; index < manifest.chunks.length; index++) {
      if (received.has(index)) continue;
      const part = source.slice(index * AUDIO_SYNC_CHUNK_BYTES, index * AUDIO_SYNC_CHUNK_BYTES + manifest.chunks[index].byteLength);
      await api(`uploads/${manifest.transferId}/chunks/${index}`, { method: 'PUT', binaryBody: part, fetcher });
      verifiedBytes += part.size; await repository.putSyncState({ recordingId: recording.id, transferId: manifest.transferId, manifest: wireManifest, status: 'uploading', totalBytes: manifest.totalBytes, verifiedBytes, serverVersion: state.serverVersion ?? 0 });
      onProgress?.({ recordingId: recording.id, verifiedBytes, totalBytes: manifest.totalBytes });
    }
  }
  const committed = start.alreadyCommitted ? start : await api(`uploads/${manifest.transferId}/complete`, { method: 'POST', body: {}, fetcher });
  if (committed.conflict) return { ...state, status: 'needs-review', conflict: committed };
  const next = { recordingId: recording.id, transferId: manifest.transferId, status: 'verified-here', serverVersion: committed.serverVersion ?? state.serverVersion ?? 1, serverCursor: committed.serverCursor ?? 0, totalBytes: manifest.totalBytes, verifiedBytes: manifest.totalBytes, sha256: manifest.sha256, lastMetadataHash: audioMetadataHash(manifest.recording, manifest.anchors, manifest.sha256, manifest.totalBytes), audioCursor: state.audioCursor ?? 0 };
  await repository.putSyncState(next);
  return next;
}

async function downloadChange(change, fetcher, onProgress, repository) {
  let state = await ensureLocalState(change.recording.id, repository);
  const transferId = state.status === 'downloading' && state.sha256 === change.sha256 ? state.transferId : crypto.randomUUID();
  const manifest = { protocolVersion: 1, transferId, baseServerVersion: change.serverVersion, recording: change.recording, anchors: change.anchors, sha256: change.sha256, totalBytes: change.totalBytes, chunkSize: change.chunkSize, chunks: change.chunks };
  validateAudioManifest(manifest);
  if (state.status === 'verified-here' && state.sha256 === manifest.sha256) { await api('verify', { method: 'POST', body: { recordingId: change.recording.id, sha256: manifest.sha256 }, fetcher }); return state; }
  state = { ...state, transferId, status: 'downloading', totalBytes: manifest.totalBytes, sha256: manifest.sha256, serverVersion: change.serverVersion, manifest };
  await repository.putSyncState(state);
  const saved = new Map((await repository.listDownloadedChunks(transferId)).map(row => [row.sequence, row]));
  const blobParts = [];
  for (let index = 0; index < manifest.chunks.length; index++) {
    let part = saved.get(index)?.blob;
    if (part && (part.size !== manifest.chunks[index].byteLength || await digestBlob(part) !== manifest.chunks[index].sha256)) part = null;
    if (!part) {
      const response = await api(`downloads/${change.recording.id}/chunks/${index}`, { fetcher, expectBinary: true });
      part = await response.blob();
      if (part.size !== manifest.chunks[index].byteLength || await digestBlob(part) !== manifest.chunks[index].sha256 || response.headers.get('x-noteos-chunk-sha256') !== manifest.chunks[index].sha256) throw new Error('audio_chunk_digest_mismatch');
      await repository.putDownloadedChunk(transferId, index, part, manifest.chunks[index].sha256);
    }
    blobParts.push(part); onProgress?.({ recordingId: change.recording.id, verifiedBytes: blobParts.reduce((sum,item) => sum+item.size,0), totalBytes: manifest.totalBytes });
  }
  const blob = new Blob(blobParts, { type: manifest.recording.mimeType });
  if (await digestBlob(blob) !== manifest.sha256 || blob.size !== manifest.totalBytes) throw new Error('audio_object_digest_mismatch');
  let recording;
  try { recording = await repository.finalizeDownload(manifest, blob, blobParts); }
  catch (error) {
    const collision = await repository.get(change.recording.id);
    if (!collision) throw error;
    const conflict = { ...state, status: 'needs-review', conflict: { error: 'audio_local_recording_collision', remote: manifest, serverVersion: change.serverVersion }, localRecordingId: collision.id };
    await repository.putSyncState(conflict); return conflict;
  }
  await api('verify', { method: 'POST', body: { recordingId: recording.id, sha256: manifest.sha256 }, fetcher });
  const next = { ...state, status: 'verified-here', verifiedBytes: manifest.totalBytes, totalBytes: manifest.totalBytes, sha256: manifest.sha256 };
  await repository.putSyncState(next); return next;
}

/** Runs inside the existing text sync cycle; all audio work is independently resumable and best-effort. */
export async function synchronizeAudio({ fetcher = fetch, locks = globalThis.navigator?.locks, onProgress, repository = audioRepository } = {}) {
  if (!locks?.request) return { status: 'transfer-unavailable', transferred: 0 };
  let result = { status: 'idle', transferred: 0 };
  await locks.request('noteos-web-audio-sync', { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) { result.status = 'waiting'; return; }
    try {
      await api('status', { fetcher });
      const approvals = await repository.listSyncApprovals();
      const discovered = [];
      for (const approval of approvals) {
        const approved = await api('approve', { method: 'POST', body: { noteId: approval.noteId, approved: approval.approved === true }, fetcher });
        if (approval.approved === true) discovered.push(...(approved.recordings ?? []));
      }
      for (const recording of await repository.listSyncCandidates()) {
        const state = await ensureLocalState(recording.id, repository);
        if (state.status === 'needs-review') continue;
        let updated;
        try { updated = await uploadRecording(recording, state, fetcher, onProgress, repository); }
        catch (error) {
          if (error.status === 409 && error.body?.error === 'audio_metadata_conflict') {
            const localManifest = await makeManifest(recording, await repository.chunks(recording.id), state.transferId ?? crypto.randomUUID(), state.serverVersion ?? 0);
            updated = { ...state, status: 'needs-review', sha256: localManifest.sha256, conflict: error.body, localAnchors: recording.audioAnchors };
          }
          else throw error;
        }
        await repository.putSyncState(updated); result.transferred++;
      }
      const cursorState = await repository.getSyncStateForRecording('__cursor__') ?? { recordingId: '__cursor__', audioCursor: 0 };
      const page = await api('changes', { method: 'POST', body: { protocolVersion: 1, cursor: cursorState.audioCursor ?? 0, limit: 100 }, fetcher });
      const changes = [...new Map([...discovered, ...page.changes].map(change => [`${change.recording.id}:${change.serverVersion}`, change])).values()];
      for (const change of changes) {
        const approved = await repository.getSyncApproval(change.recording.noteId);
        if (!approved?.approved) continue;
        if (change.deviceVerified) { result.transferred++; continue; }
        await downloadChange(change, fetcher, onProgress, repository); result.transferred++;
      }
      await repository.putSyncState({ recordingId: '__cursor__', audioCursor: page.nextCursor });
      result.status = result.transferred ? 'transferred' : 'idle';
    } catch (error) {
      result.status = error.status === 503 ? 'transfer-unavailable' : error.status === 401 ? 'needs-pairing' : error.status === 409 ? 'needs-review' : 'waiting-connection';
      result.error = error.message;
      if (result.status === 'transfer-unavailable') for (const recording of await repository.listSyncCandidates().catch(() => [])) {
        const state = await ensureLocalState(recording.id, repository);
        await repository.putSyncState({ ...state, status: 'transfer-unavailable', previousStatus: state.status });
      }
    }
  });
  return result;
}
