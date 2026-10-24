import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, statSync as requireStatSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { authenticate } from './auth.mjs';
import { openStore, serverMeta, transaction, appendChange } from './storage.mjs';
import { allowedOrigin } from './http.mjs';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';
import { validateAudioManifest, audioManifestHash, audioMetadataHash, AUDIO_SYNC_CHUNK_BYTES, AUDIO_SYNC_DEFAULT_QUOTA_BYTES, AUDIO_SYNC_SESSION_TTL_MS, AUDIO_SYNC_MAX_JSON_BYTES } from '../app/lib/audio-sync-protocol.mjs';
import { assembleObject, ensureMediaDirectories, hashFile, mediaDiskUsage, mediaPaths, MediaError, receiveChunkToFile, recoverStagedChunks, verifyObject } from './media-storage.mjs';
import { validateAudioAnchorSet } from '../app/lib/audio-anchors.mjs';

const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { ...responseHeaders, ...headers } });
const fail = (error, status = 400) => json({ error }, status);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validTransferId = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');

let publishQueue = Promise.resolve();
function withPublishLock(operation) {
  const result = publishQueue.then(operation, operation);
  publishQueue = result.catch(() => {});
  return result;
}

function responseCookieName(origin) { return origin.protocol === 'https:' ? '__Secure-noteos_sync' : 'noteos_sync_local'; }
function authenticatedDevice(db, request, cookieName) {
  const values = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
  return values.length === 1 ? authenticate(db, values[0].slice(cookieName.length + 1)) : null;
}

async function readJson(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json' || request.headers.get('x-noteos-sync') !== '1') throw new MediaError('csrf_denied', 403);
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > AUDIO_SYNC_MAX_JSON_BYTES)) throw new MediaError('invalid_audio_manifest', 413);
  if (!request.body) throw new MediaError('invalid_json', 400);
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > AUDIO_SYNC_MAX_JSON_BYTES) { await reader.cancel(); throw new MediaError('invalid_audio_manifest', 413); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (error instanceof MediaError) throw error; throw new MediaError('invalid_json', 400); }
}

function featureEnabled(env) {
  return env.NOTEOS_SYNC_ENABLED === '1' && env.NOTEOS_AUDIO_SYNC_ENABLED === '1';
}

function mediaQuota(env) {
  const configured = Number(env.NOTEOS_AUDIO_SYNC_MAX_BYTES ?? AUDIO_SYNC_DEFAULT_QUOTA_BYTES);
  if (!Number.isSafeInteger(configured) || configured < 64 * 1024 * 1024 || configured > 8 * 1024 * 1024 * 1024) throw new MediaError('media_configuration_invalid', 503);
  return configured;
}

function requireApprovedNote(db, deviceId, noteId) {
  const row = db.prepare("SELECT id,record_json recordJson,lifecycle FROM sync_entities WHERE entity_type='note' AND id=?").get(noteId);
  const deleted = db.prepare("SELECT 1 FROM sync_tombstones WHERE entity_type='note' AND id=?").get(noteId);
  if (!row || deleted) throw new MediaError('note_not_available', 404);
  let note;
  try { note = JSON.parse(row.recordJson); } catch { throw new MediaError('note_not_available', 409); }
  if (!['PRIVATE_SERVER', 'CLOUD_ALLOWED'].includes(note.privacy)) throw new MediaError('audio_permission_required', 403);
  const approved = db.prepare('SELECT approved FROM sync_media_approvals WHERE device_id=? AND note_id=?').get(deviceId, noteId)?.approved === 1;
  if (!approved) throw new MediaError('audio_permission_required', 403);
  return { ...note, lifecycle: row.lifecycle };
}

function findCurrent(db, recordingId) {
  return db.prepare(`SELECT m.recording_id recordingId,m.note_id noteId,m.object_sha256 sha256,m.mime_type mimeType,m.total_bytes totalBytes,
      m.chunk_size chunkSize,m.chunk_count chunkCount,m.server_version serverVersion,m.manifest_json manifestJson,m.metadata_hash metadataHash,
      e.committed_cursor cursor FROM sync_recording_media m JOIN sync_entities e ON e.entity_type='recording' AND e.id=m.recording_id WHERE m.recording_id=?`).get(recordingId) ?? null;
}

function manifestForDevice(db, row, deviceId) {
  const verifiedHere = db.prepare('SELECT object_sha256 sha256,verified_bytes bytes,verified_at verifiedAt FROM sync_media_device_state WHERE device_id=? AND recording_id=?').get(deviceId, row.recordingId);
  const verifiedElsewhere = db.prepare('SELECT 1 FROM sync_media_device_state WHERE recording_id=? AND device_id<>? AND object_sha256=? LIMIT 1').get(row.recordingId, deviceId, row.sha256);
  return { ...JSON.parse(row.manifestJson), serverVersion: row.serverVersion, serverCursor: row.cursor, deviceVerified: Boolean(verifiedHere && verifiedHere.sha256 === row.sha256 && verifiedHere.bytes === row.totalBytes), verifiedElsewhere: Boolean(verifiedElsewhere) };
}

function checkMetadataConflict(db, deviceId, manifest) {
  const current = findCurrent(db, manifest.recording.id);
  const metadataHash = audioMetadataHash(manifest.recording, manifest.anchors, manifest.sha256, manifest.totalBytes);
  if (current && current.sha256 === manifest.sha256 && current.metadataHash === metadataHash) {
    db.prepare(`INSERT INTO sync_media_device_state(device_id,recording_id,object_sha256,verified_bytes,verified_at) VALUES(?,?,?,?,?)
      ON CONFLICT(device_id,recording_id) DO UPDATE SET object_sha256=excluded.object_sha256,verified_bytes=excluded.verified_bytes,verified_at=excluded.verified_at`)
      .run(deviceId, manifest.recording.id, manifest.sha256, manifest.totalBytes, Date.now());
    return { current, metadataHash, idempotent: true };
  }
  if ((current?.serverVersion ?? 0) !== manifest.baseServerVersion) return { current, metadataHash, conflict: true };
  return { current, metadataHash, idempotent: false };
}

function saveConflict(db, deviceId, recordingId, baseVersion, localMetadata, remoteMetadata) {
  const conflictId = randomUUID();
  db.prepare(`INSERT INTO sync_audio_conflicts(conflict_id,recording_id,device_id,base_server_version,local_metadata_json,remote_metadata_json,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(conflictId, recordingId, deviceId, baseVersion, canonicalJson(localMetadata), canonicalJson(remoteMetadata), Date.now());
  return conflictId;
}

function storedManifest(manifest) {
  return {
    protocolVersion: 1,
    recording: manifest.recording,
    anchors: manifest.anchors,
    sha256: manifest.sha256,
    totalBytes: manifest.totalBytes,
    chunkSize: manifest.chunkSize,
    chunks: manifest.chunks,
  };
}

function commitManifest(db, deviceId, manifest, objectPath) {
  const note = requireApprovedNote(db, deviceId, manifest.recording.noteId);
  const check = checkMetadataConflict(db, deviceId, manifest);
  if (check.current && check.current.noteId !== manifest.recording.noteId) throw new MediaError('audio_parent_note_immutable', 409);
  if (check.conflict) {
    const conflictId = saveConflict(db, deviceId, manifest.recording.id, manifest.baseServerVersion,
      { ...storedManifest(manifest), sourceObject: manifest.sha256 }, { ...JSON.parse(check.current.manifestJson), serverVersion: check.current.serverVersion });
    return { conflict: true, conflictId, current: check.current };
  }
  if (check.idempotent) return { recordingId: manifest.recording.id, serverVersion: check.current.serverVersion, serverCursor: serverMeta(db).serverCursor, verifiedBytes: manifest.totalBytes, idempotent: true };

  const version = (check.current?.serverVersion ?? 0) + 1, now = Date.now(), record = storedManifest(manifest);
  const recordJson = canonicalJson(record), cursor = appendChange(db, 'recording', manifest.recording.id, version, 'upsert', recordJson);
  const obj = statSyncSafe(objectPath);
  if (!obj || obj.size !== manifest.totalBytes) throw new MediaError('media_storage_unavailable', 503);
  db.prepare('INSERT OR IGNORE INTO sync_media_objects(sha256,byte_length,mime_type,created_at) VALUES(?,?,?,?)').run(manifest.sha256, manifest.totalBytes, manifest.recording.mimeType, now);
  const savedObject = db.prepare('SELECT byte_length byteLength FROM sync_media_objects WHERE sha256=?').get(manifest.sha256);
  if (savedObject?.byteLength !== manifest.totalBytes) throw new MediaError('audio_object_digest_mismatch', 422);
  if (check.current) {
    db.prepare(`UPDATE sync_recording_media SET note_id=?,object_sha256=?,mime_type=?,total_bytes=?,chunk_size=?,chunk_count=?,server_version=?,manifest_json=?,metadata_hash=?,updated_at=? WHERE recording_id=?`)
      .run(manifest.recording.noteId, manifest.sha256, manifest.recording.mimeType, manifest.totalBytes, manifest.chunkSize, manifest.chunks.length, version, recordJson, check.metadataHash, now, manifest.recording.id);
    db.prepare(`UPDATE sync_entities SET server_version=?,record_json=?,content_hash=?,lifecycle='active',recording_count=0,committed_cursor=? WHERE entity_type='recording' AND id=?`)
      .run(version, recordJson, check.metadataHash, cursor, manifest.recording.id);
  } else {
    db.prepare(`INSERT INTO sync_recording_media(recording_id,note_id,object_sha256,mime_type,total_bytes,chunk_size,chunk_count,server_version,manifest_json,metadata_hash,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(manifest.recording.id, manifest.recording.noteId, manifest.sha256, manifest.recording.mimeType, manifest.totalBytes, manifest.chunkSize, manifest.chunks.length, version, recordJson, check.metadataHash, now);
    db.prepare(`INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor)
      VALUES('recording',?,?,?,?,'active',0,?)`).run(manifest.recording.id, version, recordJson, check.metadataHash, cursor);
    db.prepare("UPDATE sync_entities SET recording_count=recording_count+1 WHERE entity_type='note' AND id=?").run(note.id);
  }
  db.prepare('INSERT INTO sync_recording_versions(recording_id,server_version,device_id,metadata_json,metadata_hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(manifest.recording.id, version, deviceId, recordJson, check.metadataHash, now);
  db.prepare(`INSERT INTO sync_media_device_state(device_id,recording_id,object_sha256,verified_bytes,verified_at) VALUES(?,?,?,?,?)
    ON CONFLICT(device_id,recording_id) DO UPDATE SET object_sha256=excluded.object_sha256,verified_bytes=excluded.verified_bytes,verified_at=excluded.verified_at`)
    .run(deviceId, manifest.recording.id, manifest.sha256, manifest.totalBytes, now);
  return { recordingId: manifest.recording.id, serverVersion: version, serverCursor: cursor, verifiedBytes: manifest.totalBytes, idempotent: false };
}

function statSyncSafe(path) {
  try { return requireStatSync(path); } catch { return null; }
}

async function beginUpload(db, root, deviceId, manifest, manifestDigest, env) {
  return withPublishLock(async () => {
    const paths = mediaPaths(root), existingObject = await verifyObject(paths, manifest), currentUsage = await mediaDiskUsage(root), quota = mediaQuota(env);
    let conflict = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      requireApprovedNote(db, deviceId, manifest.recording.noteId);
      const prior = db.prepare('SELECT device_id deviceId,manifest_hash manifestHash,state,expires_at expiresAt FROM sync_media_uploads WHERE transfer_id=?').get(manifest.transferId);
      if (prior) {
        if (prior.manifestHash !== manifestDigest || prior.deviceId !== deviceId) throw new MediaError('audio_transfer_id_conflict', 409);
        if (prior.state === 'published') { db.exec('COMMIT'); return { alreadyCommitted: true, existing: true }; }
        if (prior.state === 'conflict') throw new MediaError('audio_metadata_conflict', 409);
        if (prior.state === 'expired' || prior.expiresAt <= Date.now()) {
          db.prepare("UPDATE sync_media_uploads SET state='expired',updated_at=? WHERE transfer_id=?").run(Date.now(), manifest.transferId);
          db.exec('COMMIT'); throw new MediaError('audio_upload_expired', 410);
        }
        const received = db.prepare('SELECT chunk_index chunkIndex FROM sync_media_upload_chunks WHERE transfer_id=? ORDER BY chunk_index').all(manifest.transferId).map(row => row.chunkIndex);
        db.exec('COMMIT'); return { received, resumed: true };
      }
      const check = checkMetadataConflict(db, deviceId, manifest);
      if (check.conflict) {
        const conflictId = saveConflict(db, deviceId, manifest.recording.id, manifest.baseServerVersion,
          { ...storedManifest(manifest), sourceObject: manifest.sha256 }, { ...JSON.parse(check.current.manifestJson), serverVersion: check.current.serverVersion });
        conflict = { conflictId, remote: JSON.parse(check.current.manifestJson), serverVersion: check.current.serverVersion };
        db.exec('COMMIT');
      } else if (check.idempotent) {
        db.exec('COMMIT'); return { alreadyCommitted: true, serverVersion: check.current.serverVersion, verifiedBytes: manifest.totalBytes };
      } else {
        const reserved = db.prepare(`SELECT COALESCE(SUM(MAX(0,u.reserved_bytes-COALESCE(c.chunk_bytes,0))),0) bytes FROM sync_media_uploads u
          LEFT JOIN (SELECT transfer_id,SUM(byte_length) chunk_bytes FROM sync_media_upload_chunks GROUP BY transfer_id) c ON c.transfer_id=u.transfer_id
          WHERE u.state IN ('receiving','publishing')`).get().bytes;
        const reserveBytes = existingObject ? 1 : manifest.totalBytes;
        if (currentUsage + reserved + reserveBytes > quota) throw new MediaError('audio_storage_quota_exceeded', 507);
        const deviceSessions = db.prepare("SELECT count(*) count FROM sync_media_uploads WHERE device_id=? AND state='receiving'").get(deviceId).count;
        const allSessions = db.prepare("SELECT count(*) count FROM sync_media_uploads WHERE state='receiving'").get().count;
        if (deviceSessions >= 2 || allSessions >= 8) throw new MediaError('audio_upload_capacity_reached', 429);
        const now = Date.now();
        db.prepare(`INSERT INTO sync_media_uploads(transfer_id,device_id,recording_id,note_id,manifest_json,manifest_hash,base_server_version,reserved_bytes,state,expires_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(manifest.transferId, deviceId, manifest.recording.id, manifest.recording.noteId, canonicalJson(manifest), manifestDigest, manifest.baseServerVersion, reserveBytes, 'receiving', now + AUDIO_SYNC_SESSION_TTL_MS, now, now);
        const received = existingObject ? manifest.chunks.map(row => row.index) : [];
        if (existingObject) for (const chunk of manifest.chunks) db.prepare('INSERT INTO sync_media_upload_chunks(transfer_id,chunk_index,sha256,byte_length) VALUES(?,?,?,?)').run(manifest.transferId, chunk.index, chunk.sha256, chunk.byteLength);
        db.exec('COMMIT');
        return { received, resumed: false, objectAlreadyPresent: existingObject };
      }
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    if (conflict) throw Object.assign(new MediaError('audio_metadata_conflict', 409), conflict);
    throw new MediaError('audio_metadata_conflict', 409);
  });
}

async function completeUpload(db, root, deviceId, transferId, env) {
  return withPublishLock(async () => {
    const row = db.prepare(`SELECT transfer_id transferId,device_id deviceId,recording_id recordingId,manifest_json manifestJson,state,expires_at expiresAt FROM sync_media_uploads WHERE transfer_id=? AND device_id=?`).get(transferId, deviceId);
    if (!row) throw new MediaError('audio_upload_not_found', 404);
    if (row.state === 'published') return { alreadyCommitted: true, recordingId: row.recordingId };
    if (row.state === 'expired' || row.expiresAt <= Date.now()) { db.prepare("UPDATE sync_media_uploads SET state='expired',updated_at=? WHERE transfer_id=?").run(Date.now(), transferId); throw new MediaError('audio_upload_expired', 410); }
    if (!['receiving','publishing'].includes(row.state)) throw new MediaError('audio_metadata_conflict', 409);
    const manifest = validateAudioManifest(JSON.parse(row.manifestJson), { transferId });
    requireApprovedNote(db, deviceId, manifest.recording.noteId);
    const paths = await ensureMediaDirectories(root);
    const quota = mediaQuota(env), usage = await mediaDiskUsage(root);
    const alreadyObject = await verifyObject(paths, manifest);
    transaction(db, () => {
      const current = db.prepare('SELECT state,expires_at expiresAt,reserved_bytes reservedBytes FROM sync_media_uploads WHERE transfer_id=? AND device_id=?').get(transferId, deviceId);
      if (!current || current.expiresAt <= Date.now() || !['receiving','publishing'].includes(current.state)) throw new MediaError('audio_upload_expired', 410);
      if (current.state === 'receiving') {
        const reservedOther = db.prepare(`SELECT COALESCE(SUM(MAX(0,u.reserved_bytes-COALESCE(c.chunk_bytes,0))),0) bytes FROM sync_media_uploads u
          LEFT JOIN (SELECT transfer_id,SUM(byte_length) chunk_bytes FROM sync_media_upload_chunks GROUP BY transfer_id) c ON c.transfer_id=u.transfer_id
          WHERE u.state IN ('receiving','publishing') AND u.transfer_id<>?`).get(transferId).bytes;
        const assemblyReservation = alreadyObject ? 0 : manifest.totalBytes;
        if (usage + reservedOther + assemblyReservation > quota) throw new MediaError('audio_storage_quota_exceeded', 507);
        db.prepare("UPDATE sync_media_uploads SET state='publishing',reserved_bytes=reserved_bytes+?,updated_at=? WHERE transfer_id=?").run(assemblyReservation, Date.now(), transferId);
      }
    });
    if (!alreadyObject) {
      const chunks = db.prepare('SELECT chunk_index chunkIndex,sha256,byte_length byteLength FROM sync_media_upload_chunks WHERE transfer_id=? ORDER BY chunk_index').all(transferId);
      if (chunks.length !== manifest.chunks.length || chunks.some((chunk, i) => chunk.chunkIndex !== i || chunk.sha256 !== manifest.chunks[i].sha256 || chunk.byteLength !== manifest.chunks[i].byteLength)) throw new MediaError('audio_upload_incomplete', 409);
      await assembleObject(paths, transferId, manifest);
    }
    const objectPath = paths.objectFile(manifest.sha256);
    if (!(await verifyObject(paths, manifest))) throw new MediaError('audio_object_digest_mismatch', 422);
    const result = transaction(db, () => {
      const commit = commitManifest(db, deviceId, manifest, objectPath);
      if (commit.conflict) {
        db.prepare("UPDATE sync_media_uploads SET state='conflict',updated_at=? WHERE transfer_id=?").run(Date.now(), transferId);
        return commit;
      }
      db.prepare("UPDATE sync_media_uploads SET state='published',updated_at=? WHERE transfer_id=?").run(Date.now(), transferId);
      return commit;
    });
    if (result.conflict) throw Object.assign(new MediaError('audio_metadata_conflict', 409), { conflictId: result.conflictId, remote: JSON.parse(result.current.manifestJson), serverVersion: result.current.serverVersion });
    return result;
  });
}

async function handleChanges(db, deviceId, body) {
  if (!body || Object.keys(body).sort().join(',') !== 'cursor,limit,protocolVersion' || body.protocolVersion !== 1 || !Number.isSafeInteger(body.cursor) || body.cursor < 0 || !Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 100) throw new MediaError('invalid_audio_cursor', 400);
  const meta = serverMeta(db);
  if (body.cursor > meta.serverCursor) return json({ error: 'cursor_ahead', ...meta }, 409);
  const events = db.prepare('SELECT server_cursor cursor,entity_type entityType,entity_id id,server_version serverVersion,event,record_json recordJson FROM sync_changelog WHERE server_cursor>? ORDER BY server_cursor LIMIT ?').all(body.cursor, body.limit);
  const changes = [];
  for (const event of events) {
    if (event.entityType !== 'recording' || event.event !== 'upsert') continue;
    let manifest;
    try { manifest = JSON.parse(event.recordJson); } catch { throw new MediaError('audio_metadata_unavailable', 503); }
    const approved = db.prepare('SELECT approved FROM sync_media_approvals WHERE device_id=? AND note_id=?').get(deviceId, manifest.recording?.noteId)?.approved === 1;
    if (!approved) continue;
    const row = findCurrent(db, event.id);
    if (row?.serverVersion === event.serverVersion) changes.push({ ...manifestForDevice(db, row, deviceId), cursor: event.cursor });
  }
  return json({ ...meta, changes, nextCursor: events.at(-1)?.cursor ?? body.cursor, hasMore: events.length === body.limit });
}

function handleDownload(db, root, deviceId, recordingId, index) {
  if (!validId(recordingId) || !Number.isSafeInteger(index) || index < 0) throw new MediaError('invalid_audio_download', 400);
  const row = findCurrent(db, recordingId);
  if (!row) throw new MediaError('audio_recording_not_found', 404);
  requireApprovedNote(db, deviceId, row.noteId);
  const manifest = JSON.parse(row.manifestJson), chunk = manifest.chunks[index];
  if (!chunk) throw new MediaError('audio_chunk_not_found', 404);
  const file = mediaPaths(root).objectFile(row.sha256), start = manifest.chunks.slice(0, index).reduce((sum, part) => sum + part.byteLength, 0), end = start + chunk.byteLength - 1;
  const body = Readable.toWeb(createReadStream(file, { start, end }));
  return new Response(body, { status: 200, headers: { ...responseHeaders, 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunk.byteLength), 'X-NoteOS-Chunk-SHA256': chunk.sha256, 'Content-Disposition': 'attachment' } });
}

function handleVerify(db, deviceId, body) {
  if (!body || Object.keys(body).sort().join(',') !== 'recordingId,sha256' || !validId(body.recordingId) || !validDigest(body.sha256)) throw new MediaError('invalid_audio_verification', 400);
  const row = findCurrent(db, body.recordingId);
  if (!row || row.sha256 !== body.sha256) throw new MediaError('audio_verification_mismatch', 409);
  requireApprovedNote(db, deviceId, row.noteId);
  db.prepare(`INSERT INTO sync_media_device_state(device_id,recording_id,object_sha256,verified_bytes,verified_at) VALUES(?,?,?,?,?)
    ON CONFLICT(device_id,recording_id) DO UPDATE SET object_sha256=excluded.object_sha256,verified_bytes=excluded.verified_bytes,verified_at=excluded.verified_at`)
    .run(deviceId, row.recordingId, row.sha256, row.totalBytes, Date.now());
  return json({ recordingId: row.recordingId, sha256: row.sha256, verifiedBytes: row.totalBytes, verifiedAt: Date.now() });
}

function handleMetadata(db, deviceId, body) {
  if (!body || Object.keys(body).sort().join(',') !== 'anchors,baseServerVersion,recordingId,recordingMetadata' || !validId(body.recordingId) || !Number.isSafeInteger(body.baseServerVersion) || body.baseServerVersion < 1 || !body.recordingMetadata || Array.isArray(body.recordingMetadata) || Object.keys(body.recordingMetadata).some(key => !['title','updatedAt'].includes(key)) || typeof body.recordingMetadata.title !== 'string' || !body.recordingMetadata.title.trim() || [...body.recordingMetadata.title].length > 120 || !Number.isSafeInteger(body.recordingMetadata.updatedAt) || body.recordingMetadata.updatedAt < 0) throw new MediaError('invalid_audio_metadata', 400);
  const current = findCurrent(db, body.recordingId);
  if (!current) throw new MediaError('audio_recording_not_found', 404);
  requireApprovedNote(db, deviceId, current.noteId);
  const previous = JSON.parse(current.manifestJson);
  const anchors = validateAudioAnchorSet(body.anchors, body.recordingId, { durationMs: previous.recording.durationMs, durationKnown: previous.recording.durationMs > 0 });
  const localManifest = { ...previous, recording: { ...previous.recording, ...body.recordingMetadata }, anchors };
  const metadataHash = audioMetadataHash(localManifest.recording, anchors, current.sha256, current.totalBytes);
  if (body.baseServerVersion !== current.serverVersion) {
    const conflictId = saveConflict(db, deviceId, body.recordingId, body.baseServerVersion, localManifest, { ...previous, serverVersion: current.serverVersion });
    return json({ error: 'audio_metadata_conflict', conflictId, remote: previous, serverVersion: current.serverVersion }, 409);
  }
  if (metadataHash === current.metadataHash) return json({ recordingId: current.recordingId, serverVersion: current.serverVersion, serverCursor: serverMeta(db).serverCursor, unchanged: true });
  const version = current.serverVersion + 1, now = Date.now(), stored = canonicalJson(localManifest);
  const cursor = transaction(db, () => {
    const nextCursor = appendChange(db, 'recording', body.recordingId, version, 'upsert', stored);
    db.prepare(`UPDATE sync_recording_media SET manifest_json=?,metadata_hash=?,server_version=?,updated_at=? WHERE recording_id=?`).run(stored, metadataHash, version, now, body.recordingId);
    db.prepare(`UPDATE sync_entities SET server_version=?,record_json=?,content_hash=?,committed_cursor=? WHERE entity_type='recording' AND id=?`).run(version, stored, metadataHash, nextCursor, body.recordingId);
    db.prepare('INSERT INTO sync_recording_versions(recording_id,server_version,device_id,metadata_json,metadata_hash,created_at) VALUES(?,?,?,?,?,?)').run(body.recordingId, version, deviceId, stored, metadataHash, now);
    return nextCursor;
  });
  return json({ recordingId: body.recordingId, serverVersion: version, serverCursor: cursor });
}

export async function handleAudioSync(request, action, env = process.env) {
  if (!featureEnabled(env)) return fail('audio_sync_disabled', 503);
  let db;
  try {
    const url = new URL(request.url);
    if (url.search) throw new MediaError('query_parameters_not_supported', 400);
    const origin = allowedOrigin(request, env);
    if (!origin) throw new MediaError('origin_denied', 403);
    const cookieName = responseCookieName(origin);
    db = openStore(env.NOTEOS_SYNC_STORAGE);
    const device = authenticatedDevice(db, request, cookieName);
    if (!device) throw new MediaError('authentication_required', 401);
    if (db.prepare('PRAGMA user_version').get().user_version === 2) {
      db.close();
      db = openStore(env.NOTEOS_SYNC_STORAGE, { audioSync: true });
      if (!authenticatedDevice(db, request, cookieName)) throw new MediaError('authentication_required', 401);
    }
    const root = env.NOTEOS_SYNC_STORAGE;
    const paths = await ensureMediaDirectories(root);
    await recoverStagedChunks(db, root);
    const quota = mediaQuota(env);

    if (action === 'media/status' && request.method === 'GET') {
      const bytesUsed = await mediaDiskUsage(root);
      return json({ enabled: true, protocolVersion: 1, chunkBytes: AUDIO_SYNC_CHUNK_BYTES, maxRecordingBytes: 512 * 1024 * 1024, quotaBytes: quota, bytesUsed, ...serverMeta(db) });
    }
    if (action === 'media/approve' && request.method === 'POST') {
      const body = await readJson(request);
      if (!body || Object.keys(body).sort().join(',') !== 'approved,noteId' || typeof body.approved !== 'boolean' || !validId(body.noteId)) throw new MediaError('invalid_audio_approval', 400);
      if (body.approved) requireApprovedNoteWithoutApproval(db, body.noteId);
      db.prepare(`INSERT INTO sync_media_approvals(device_id,note_id,approved,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(device_id,note_id) DO UPDATE SET approved=excluded.approved,updated_at=excluded.updated_at`).run(device.id, body.noteId, body.approved ? 1 : 0, Date.now());
      const recordings = body.approved ? db.prepare(`SELECT m.recording_id recordingId,m.server_version serverVersion,m.manifest_json manifestJson,m.total_bytes totalBytes,m.object_sha256 sha256,e.committed_cursor cursor
        FROM sync_recording_media m JOIN sync_entities e ON e.entity_type='recording' AND e.id=m.recording_id WHERE m.note_id=? ORDER BY m.recording_id`).all(body.noteId).map(row => manifestForDevice(db, row, device.id)) : [];
      return json({ noteId: body.noteId, approved: body.approved, recordings });
    }
    if (action === 'media/uploads' && request.method === 'POST') {
      const body = await readJson(request);
      if (!body || Object.keys(body).join(',') !== 'manifest') throw new MediaError('invalid_audio_manifest', 400);
      const manifest = validateAudioManifest(body.manifest);
      const result = await beginUpload(db, root, device.id, manifest, audioManifestHash(manifest), env);
      if (result.alreadyCommitted) return json({ alreadyCommitted: true, ...result });
      return json({ transferId: manifest.transferId, received: result.received, resumed: result.resumed, objectAlreadyPresent: result.objectAlreadyPresent ?? false });
    }
    const transferStatus = action.match(/^media\/uploads\/([0-9a-f-]{36})$/i);
    if (transferStatus && request.method === 'GET') {
      const transferId = transferStatus[1], row = db.prepare('SELECT manifest_json manifestJson,state,expires_at expiresAt FROM sync_media_uploads WHERE transfer_id=? AND device_id=?').get(transferId, device.id);
      if (!row) throw new MediaError('audio_upload_not_found', 404);
      if (row.expiresAt <= Date.now() || row.state === 'expired') throw new MediaError('audio_upload_expired', 410);
      const manifest = JSON.parse(row.manifestJson), received = db.prepare('SELECT chunk_index chunkIndex FROM sync_media_upload_chunks WHERE transfer_id=? ORDER BY chunk_index').all(transferId).map(chunk => chunk.chunkIndex);
      return json({ transferId, state: row.state, received, chunkCount: manifest.chunks.length });
    }
    const chunkUpload = action.match(/^media\/uploads\/([0-9a-f-]{36})\/chunks\/(\d+)$/i);
    if (chunkUpload && request.method === 'PUT') {
      if (request.headers.get('content-type') !== 'application/octet-stream' || request.headers.get('x-noteos-sync') !== '1') throw new MediaError('csrf_denied', 403);
      const transferId = chunkUpload[1], index = Number(chunkUpload[2]);
      const row = db.prepare('SELECT manifest_json manifestJson,state,expires_at expiresAt FROM sync_media_uploads WHERE transfer_id=? AND device_id=?').get(transferId, device.id);
      if (!row) throw new MediaError('audio_upload_not_found', 404);
      if (row.state !== 'receiving' || row.expiresAt <= Date.now()) throw new MediaError('audio_upload_expired', 410);
      const manifest = validateAudioManifest(JSON.parse(row.manifestJson), { transferId }), expected = manifest.chunks[index];
      if (!expected) throw new MediaError('audio_chunk_not_found', 404);
      requireApprovedNote(db, device.id, manifest.recording.noteId);
      const saved = db.prepare('SELECT sha256,byte_length byteLength FROM sync_media_upload_chunks WHERE transfer_id=? AND chunk_index=?').get(transferId, index);
      if (saved) {
        if (saved.sha256 !== expected.sha256 || saved.byteLength !== expected.byteLength) throw new MediaError('audio_chunk_conflict', 409);
        return new Response(null, { status: 204, headers: responseHeaders });
      }
      const destination = paths.chunkFile(transferId, index);
      await receiveChunkToFile(request, destination, { byteLength: expected.byteLength, sha256: expected.sha256, maxChunkBytes: AUDIO_SYNC_CHUNK_BYTES });
      transaction(db, () => {
        const current = db.prepare('SELECT state,expires_at expiresAt FROM sync_media_uploads WHERE transfer_id=? AND device_id=?').get(transferId, device.id);
        if (!current || current.state !== 'receiving' || current.expiresAt <= Date.now()) throw new MediaError('audio_upload_expired', 410);
        db.prepare('INSERT OR IGNORE INTO sync_media_upload_chunks(transfer_id,chunk_index,sha256,byte_length) VALUES(?,?,?,?)').run(transferId, index, expected.sha256, expected.byteLength);
        db.prepare('UPDATE sync_media_uploads SET updated_at=?,expires_at=? WHERE transfer_id=?').run(Date.now(), Date.now() + AUDIO_SYNC_SESSION_TTL_MS, transferId);
      });
      return new Response(null, { status: 204, headers: responseHeaders });
    }
    const complete = action.match(/^media\/uploads\/([0-9a-f-]{36})\/complete$/i);
    if (complete && request.method === 'POST') {
      const body = await readJson(request); if (!body || Array.isArray(body) || Object.keys(body).length) throw new MediaError('invalid_request', 400);
      const result = await completeUpload(db, root, device.id, complete[1], env);
      return json(result);
    }
    if (action === 'media/changes' && request.method === 'POST') return await handleChanges(db, device.id, await readJson(request));
    if (action === 'media/metadata' && request.method === 'POST') return handleMetadata(db, device.id, await readJson(request));
    if (action === 'media/verify' && request.method === 'POST') return handleVerify(db, device.id, await readJson(request));
    const download = action.match(/^media\/downloads\/([A-Za-z0-9_-]{1,128})\/chunks\/(\d+)$/);
    if (download && request.method === 'GET') return handleDownload(db, root, device.id, download[1], Number(download[2]));
    return fail('route_not_found', 404);
  } catch (error) {
    if (error instanceof MediaError) return error.status === 409 && (error.remote || error.conflictId) ? json({ error: error.code, conflictId: error.conflictId, remote: error.remote, serverVersion: error.serverVersion }, error.status) : fail(error.code, error.status);
    if (error?.status) return fail(error.code ?? 'audio_sync_conflict', error.status);
    if (error instanceof TypeError) return fail('invalid_audio_request', 400);
    return fail('audio_sync_unavailable', 503);
  } finally { db?.close(); }
}

function requireApprovedNoteWithoutApproval(db, noteId) {
  const row = db.prepare("SELECT record_json recordJson FROM sync_entities WHERE entity_type='note' AND id=?").get(noteId);
  const deleted = db.prepare("SELECT 1 FROM sync_tombstones WHERE entity_type='note' AND id=?").get(noteId);
  if (!row || deleted) throw new MediaError('note_not_available', 404);
  let note;
  try { note = JSON.parse(row.recordJson); } catch { throw new MediaError('note_not_available', 409); }
  if (!['PRIVATE_SERVER', 'CLOUD_ALLOWED'].includes(note.privacy)) throw new MediaError('audio_permission_required', 403);
  return note;
}
