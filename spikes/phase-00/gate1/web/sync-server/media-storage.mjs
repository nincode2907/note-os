import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, lstat, stat, link, unlink, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class MediaError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'MediaError'; this.code = code; this.status = status; }
}

export function mediaPaths(root) {
  const base = join(root, 'media');
  return {
    base,
    staging: join(base, 'staging'),
    objects: join(base, 'objects', 'sha256'),
    stageDirectory: transferId => join(base, 'staging', transferId),
    chunkFile: (transferId, index) => join(base, 'staging', transferId, `${index}.chunk`),
    objectFile: sha => join(base, 'objects', 'sha256', sha.slice(0, 2), sha),
  };
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new MediaError('media_storage_unavailable', 503);
  await chmod(path, 0o700);
}

export async function ensureMediaDirectories(root) {
  const paths = mediaPaths(root);
  for (const path of [paths.base, paths.staging, paths.objects]) await ensurePrivateDirectory(path);
  return paths;
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!result.bytesWritten) throw new MediaError('media_storage_unavailable', 503);
    offset += result.bytesWritten;
  }
}
async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Streams one bounded request body to a private staging file and durably flushes it. */
export async function receiveChunkToFile(request, destination, { byteLength, sha256, maxChunkBytes }) {
  if (!request.body) throw new MediaError('invalid_audio_chunk', 400);
  const announced = request.headers.get('content-length');
  if (announced && (!/^\d+$/.test(announced) || Number(announced) !== byteLength || Number(announced) > maxChunkBytes)) throw new MediaError('invalid_audio_chunk', 400);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  const hash = createHash('sha256');
  const reader = request.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > byteLength || size > maxChunkBytes) { await reader.cancel(); throw new MediaError('invalid_audio_chunk', 413); }
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      hash.update(bytes);
      await writeAll(handle, bytes);
    }
    if (size !== byteLength || hash.digest('hex') !== sha256) throw new MediaError('audio_chunk_digest_mismatch', 422);
    await handle.sync();
    await handle.close();
    try { await link(temporary, destination); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await hashFile(destination).catch(() => null);
      if (!current || current.byteLength !== byteLength || current.sha256 !== sha256) throw new MediaError('audio_chunk_conflict', 409);
    }
    await syncDirectory(dirname(destination));
    await unlink(temporary);
    return { byteLength: size, sha256 };
  } catch (error) {
    await handle.close().catch(() => {});
    // Keep a corrupt/partial staging file for explicit recovery review and quota accounting.
    throw error;
  }
}

export async function hashFile(path) {
  const hash = createHash('sha256'); let byteLength = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); byteLength += chunk.byteLength; }
  return { sha256: hash.digest('hex'), byteLength };
}

/** Assemble with bounded buffers; the source chunks remain intact until metadata commits. */
export async function assembleObject(paths, transferId, manifest) {
  const temporary = join(paths.staging, `${transferId}.publish.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600), wholeHash = createHash('sha256');
  let totalBytes = 0;
  try {
    for (const chunk of manifest.chunks) {
      const chunkPath = paths.chunkFile(transferId, chunk.index);
      const actual = await hashFile(chunkPath).catch(() => null);
      if (!actual || actual.byteLength !== chunk.byteLength || actual.sha256 !== chunk.sha256) throw new MediaError('audio_chunk_digest_mismatch', 422);
      for await (const data of createReadStream(chunkPath)) {
        totalBytes += data.byteLength;
        if (totalBytes > manifest.totalBytes) throw new MediaError('audio_manifest_mismatch', 422);
        wholeHash.update(data);
        await writeAll(handle, data);
      }
    }
    if (totalBytes !== manifest.totalBytes || wholeHash.digest('hex') !== manifest.sha256) throw new MediaError('audio_object_digest_mismatch', 422);
    await handle.sync(); await handle.close();
    const destination = paths.objectFile(manifest.sha256);
    await ensurePrivateDirectory(dirname(destination));
    try { await link(temporary, destination); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await hashFile(destination).catch(() => null);
      if (!current || current.byteLength !== manifest.totalBytes || current.sha256 !== manifest.sha256) throw new MediaError('audio_object_digest_mismatch', 422);
    }
    await syncDirectory(dirname(destination));
    await unlink(temporary).catch(() => {});
    return destination;
  } catch (error) {
    await handle.close().catch(() => {});
    // Incomplete assembled files are intentionally retained and counted against quota.
    throw error;
  }
}

export async function verifyObject(paths, manifest) {
  const path = paths.objectFile(manifest.sha256);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== manifest.totalBytes) return false;
  const digest = await hashFile(path);
  return digest.byteLength === manifest.totalBytes && digest.sha256 === manifest.sha256;
}

/** Counts actual media files, including partial uploads and crash orphans. */
export async function mediaDiskUsage(root) {
  const paths = mediaPaths(root);
  const visit = async path => {
    const info = await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) return 0;
    if (info.isSymbolicLink()) throw new MediaError('media_storage_unavailable', 503);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) throw new MediaError('media_storage_unavailable', 503);
    let total = 0;
    for (const name of await readdir(path)) total += await visit(join(path, name));
    return total;
  };
  return visit(paths.base);
}

/** Reconcile the crash window: durable chunk rename completed, SQLite row did not. */
export async function recoverStagedChunks(db, root) {
  const paths = await ensureMediaDirectories(root);
  const sessions = db.prepare("SELECT transfer_id transferId,manifest_json manifestJson FROM sync_media_uploads WHERE state='receiving'").all();
  let recovered = 0;
  for (const session of sessions) {
    const manifest = JSON.parse(session.manifestJson);
    const existing = new Set(db.prepare('SELECT chunk_index chunkIndex FROM sync_media_upload_chunks WHERE transfer_id=?').all(session.transferId).map(row => row.chunkIndex));
    for (const expected of manifest.chunks) {
      if (existing.has(expected.index)) continue;
      const path = paths.chunkFile(session.transferId, expected.index);
      const actual = await hashFile(path).catch(() => null);
      if (!actual || actual.byteLength !== expected.byteLength || actual.sha256 !== expected.sha256) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR IGNORE INTO sync_media_upload_chunks(transfer_id,chunk_index,sha256,byte_length) VALUES(?,?,?,?)').run(session.transferId, expected.index, expected.sha256, expected.byteLength);
        db.exec('COMMIT'); recovered++;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }
  return { recoveredChunks: recovered, paths };
}
