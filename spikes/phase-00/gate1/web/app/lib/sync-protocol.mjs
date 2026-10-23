// Shared Web/native protocol v1. No note-save or synchronization side effects.
export const SYNC_LIMITS = Object.freeze({ maxRecords: 1000, maxBytes: 262144 });
export const OPERATION_LIMITS = Object.freeze({ maxOperations: 100, maxRecordBytes: 65536 });
export const AUDIO_SYNC_STATES = Object.freeze([
  'text-local', 'text-synced-audio-pending', 'metadata-synced-blob-pending',
  'fully-verified', 'conflict-review',
]);
export function assertHistoryContinuity(previous, next) {
  if (!next || typeof next.serverEpoch !== 'string' || !Number.isSafeInteger(next.serverCursor) || next.serverCursor < 0) throw new Error('Invalid server history');
  if (previous && (previous.serverEpoch !== next.serverEpoch || next.serverCursor < previous.serverCursor)) throw new Error('Server history changed. Stop and request recovery review.');
  return next;
}
export function canonicalJson(value, depth = 0) {
  if (depth > 64) throw new Error('Record nesting exceeds preview limit');
  if (value === null || typeof value !== 'object') {
    if (!['string','number','boolean'].includes(typeof value) && value !== null) throw new Error('Non-JSON record');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(v => canonicalJson(v, depth + 1)).join(',') + ']';
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Non-JSON record object');
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k], depth + 1)).join(',') + '}';
}
export function validateSummaries(body) {
  if (!body || Object.keys(body).sort().join(',') !== 'protocolVersion,records' || body.protocolVersion !== 1 || !Array.isArray(body.records) || body.records.length > SYNC_LIMITS.maxRecords) throw new Error('Invalid bootstrap envelope');
  const ids = new Set();
  for (const row of body.records) {
    if (!row || Object.keys(row).sort().join(',') !== 'contentHash,id,lifecycle,localRevision,recordingCount' ||
      typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) || ids.has(row.id) ||
      typeof row.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.contentHash) || !['active','archived','trashed'].includes(row.lifecycle) ||
      !Number.isSafeInteger(row.localRevision) || row.localRevision < 0 ||
      !Number.isSafeInteger(row.recordingCount) || row.recordingCount < 0 || row.recordingCount > 10000) throw new Error('Invalid or duplicate record summary');
    ids.add(row.id);
  }
  return body.records;
}
export function validateOperations(body) {
  if (!body || Object.keys(body).sort().join(',') !== 'operations,protocolVersion' || body.protocolVersion !== 1 || !Array.isArray(body.operations) || body.operations.length > OPERATION_LIMITS.maxOperations) throw new Error('Invalid operation envelope');
  const ids = new Set();
  return body.operations.map(op => {
    if (!op || Object.keys(op).sort().join(',') !== 'baseServerVersion,entityId,operationId,ownerApproved,recordJson,recordingCount,type' || op.ownerApproved !== true || op.type !== 'upsert' || typeof op.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(op.operationId) || ids.has(op.operationId) || typeof op.entityId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(op.entityId) || !Number.isSafeInteger(op.baseServerVersion) || op.baseServerVersion < 0 || op.recordingCount !== 0 || typeof op.recordJson !== 'string' || new TextEncoder().encode(op.recordJson).length > OPERATION_LIMITS.maxRecordBytes) throw new Error('Invalid operation');
    ids.add(op.operationId);
    let record;
    try { record = JSON.parse(op.recordJson); } catch { throw new Error('Invalid operation record'); }
    if (record?.id !== op.entityId || record.privacy === 'DEVICE_ONLY' || canonicalJson(record) !== op.recordJson || !['active','archived','trashed'].includes(record.lifecycle) || !Number.isSafeInteger(record.revision) || record.revision < 0 || !Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 1 || !record.document || typeof record.document !== 'object') throw new Error('Invalid operation record');
    return { ...op, record };
  });
}
export function compareSummaries(client, server, tombstones = []) {
  const remote = new Map(server.map(r => [r.id, r])), deleted = new Set(tombstones.map(r => r.id));
  const result = { toUpload: [], toDownload: [], identical: [], collidingIds: [], audioRequiresReview: [] };
  for (const row of client) {
    const other = remote.get(row.id);
    if (row.recordingCount || other?.recordingCount) result.audioRequiresReview.push(row.id);
    if (deleted.has(row.id)) result.collidingIds.push(row.id);
    else if (!other) result.toUpload.push(row.id);
    else if (!row.recordingCount && !other.recordingCount && other.contentHash === row.contentHash && other.lifecycle === row.lifecycle) result.identical.push(row.id);
    else result.collidingIds.push(row.id);
    remote.delete(row.id);
  }
  result.toDownload = [...remote.keys()].sort();
  for (const other of remote.values()) if (other.recordingCount) result.audioRequiresReview.push(other.id);
  for (const key of Object.keys(result)) result[key].sort();
  return result;
}
