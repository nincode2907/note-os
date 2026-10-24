import { appendChange, openStore, serverMeta, transaction } from './storage.mjs';
import { authenticate, redeemPairingCode, revokeDevice } from './auth.mjs';
import { canonicalJson, compareSummaries, validateSummaries, validateOperations, SYNC_LIMITS, OPERATION_LIMITS } from '../app/lib/sync-protocol.mjs';
import { createHash } from 'node:crypto';
import { assertNoteRecord } from '../app/lib/note-validation.mjs';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function response(body, status = 200, extra = {}) {
  const responseHeaders = new Headers(headers);
  for (const [name, value] of Object.entries(extra)) {
    for (const entry of Array.isArray(value) ? value : [value]) responseHeaders.append(name, entry);
  }
  return Response.json(body, { status, headers: responseHeaders });
}
function fail(error, status) { return response({ error }, status); }

export function allowedOrigin(req, env) {
  const allowed = (env.NOTEOS_SYNC_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean).map(value => {
    const url = new URL(value.trim());
    if (url.origin !== value.trim() || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new Error('Invalid origin configuration');
    return url;
  });
  const host = req.headers.get('host');
  const site = req.headers.get('sec-fetch-site');
  if (site && !['same-origin','none'].includes(site)) return null;
  const origin = req.headers.get('origin');
  // A POST must prove its exact origin; Host selects the configured cookie security mode.
  const match = allowed.find(url => url.host === host && (!origin || url.origin === origin));
  if (!match || (req.method !== 'GET' && origin !== match.origin)) return null;
  return match;
}

async function bodyJson(req) {
  if (req.headers.get('content-type')?.split(';')[0] !== 'application/json' || req.headers.get('x-noteos-sync') !== '1') throw Object.assign(new Error(), { status: 403 });
  if (Number(req.headers.get('content-length') ?? 0) > SYNC_LIMITS.maxBytes) throw Object.assign(new Error(), { status: 413 });
  const reader = req.body?.getReader();
  if (!reader) throw Object.assign(new Error(), { status: 400 });
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > SYNC_LIMITS.maxBytes) { await reader.cancel(); throw Object.assign(new Error(), { status: 413 }); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (error.status) throw error; throw Object.assign(new Error(), { status: 400 }); }
}

export async function handleSync(req, action, env = process.env) {
  if (env.NOTEOS_SYNC_ENABLED !== '1') return fail('sync_disabled', 503);
  let db;
  try {
    if (new URL(req.url).search) return fail('query_parameters_not_supported', 400);
    const origin = allowedOrigin(req, env);
    if (!origin) return fail('origin_denied', 403);
    const cookieName = origin.protocol === 'https:' ? '__Secure-noteos_sync' : 'noteos_sync_local';
    const aiCookieName = origin.protocol === 'https:' ? '__Secure-noteos_ai' : 'noteos_ai_local';
    const cookie = token => `${cookieName}=${token}; Path=/api/v1/sync; HttpOnly; SameSite=Strict; Max-Age=${token ? 2592000 : 0}${origin.protocol === 'https:' ? '; Secure' : ''}`;
    const aiCookie = token => `${aiCookieName}=${token}; Path=/api/v1/ai; HttpOnly; SameSite=Strict; Max-Age=${token ? 2592000 : 0}${origin.protocol === 'https:' ? '; Secure' : ''}`;
    if (!['status','pair','ai-session','revoke','bootstrap/dry-run','bootstrap/commit','push','pull'].includes(action)) return fail('route_not_found', 404);
    if ((action === 'status' && req.method !== 'GET') || (action !== 'status' && req.method !== 'POST')) return fail('method_not_allowed', 405);
    db = openStore(env.NOTEOS_SYNC_STORAGE);
    if (action === 'pair') {
      const body = await bodyJson(req);
      if (!body || Object.keys(body).sort().join(',') !== 'code,label' || typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(body.code) || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80 || /[\x00-\x1f\x7f]/.test(body.label)) return fail('invalid_pairing_request', 400);
      const result = redeemPairingCode(db, body.code, body.label.trim());
      if (result.error) return fail(result.error, result.status);
      return response({ device: { id: result.id, label: result.label }, synchronizationActive: false }, 200, { 'Set-Cookie': [cookie(result.token), aiCookie(result.token)] });
    }
    const values = (req.headers.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(cookieName + '='));
    const device = values.length === 1 ? authenticate(db, values[0].slice(cookieName.length + 1)) : null;
    if (!device) return fail('authentication_required', 401);
    if (action === 'status') return response({ ...serverMeta(db), device: { id: device.id, label: device.label }, synchronizationActive: false, noteCount: db.prepare("SELECT count(*) n FROM sync_entities WHERE entity_type='note'").get().n });
    const body = await bodyJson(req);
    if (action === 'ai-session') {
      if (!body || Object.keys(body).length) return fail('invalid_request', 400);
      return response({ aiSession: true }, 200, { 'Set-Cookie': aiCookie(values[0].slice(cookieName.length + 1)) });
    }
    if (action === 'revoke') {
      if (!body || Object.keys(body).length) return fail('invalid_request', 400);
      revokeDevice(db, device.id);
      return response({ revoked: true }, 200, { 'Set-Cookie': [cookie(''), aiCookie('')] });
    }
    if (action === 'pull') {
      if (!body || Object.keys(body).sort().join(',') !== 'cursor,limit,protocolVersion' || body.protocolVersion !== 1 || !Number.isSafeInteger(body.cursor) || body.cursor < 0 || !Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 100) return fail('invalid_pull_request', 400);
      const meta = serverMeta(db);
      if (body.cursor > meta.serverCursor) return response({ error: 'cursor_ahead', ...meta }, 409);
      const events = db.prepare('SELECT server_cursor cursor,entity_type entityType,entity_id id,server_version serverVersion,event,record_json recordJson FROM sync_changelog WHERE server_cursor>? ORDER BY server_cursor LIMIT ?').all(body.cursor, body.limit);
      const changes = events.filter(event => event.entityType === 'note').map(event => {
        if (event.event === 'tombstone') return { ...event, serverEpoch: meta.serverEpoch, contentHash: null, lifecycle: 'trashed' };
        const record = JSON.parse(event.recordJson ?? 'null');
        if (!record || record.id !== event.id) throw new Error('Invalid event snapshot');
        const content = { ...record }; delete content.revision; delete content.createdAt; delete content.updatedAt;
        return { ...event, serverEpoch: meta.serverEpoch, contentHash: createHash('sha256').update(canonicalJson(content)).digest('hex'), lifecycle: record.lifecycle };
      });
      return response({ ...meta, changes, nextCursor: events.at(-1)?.cursor ?? body.cursor, hasMore: events.length === body.limit });
    }
    if (action === 'push') {
      let operations;
      try { operations = validateOperations(body); for (const operation of operations) assertNoteRecord(operation.record); } catch { return fail('invalid_operations', 400); }
      let result;
      try { result = transaction(db, () => {
        const acknowledgements = [];
        for (const op of operations) {
          const { record, ...requestBody } = op;
          const requestHash = createHash('sha256').update(canonicalJson(requestBody)).digest('hex');
          const prior = db.prepare('SELECT request_hash requestHash,result_json resultJson FROM sync_operations WHERE device_id=? AND operation_id=?').get(device.id, op.operationId);
          if (prior) {
            if (prior.requestHash !== requestHash) throw Object.assign(new Error(), { status: 409, conflict: { operationId: op.operationId, reason: 'operation_id_reused' } });
            acknowledgements.push(JSON.parse(prior.resultJson)); continue;
          }
          const current = db.prepare("SELECT server_version serverVersion,recording_count recordingCount FROM sync_entities WHERE entity_type='note' AND id=?").get(op.entityId);
          const tombstone = db.prepare("SELECT server_version serverVersion FROM sync_tombstones WHERE entity_type='note' AND id=?").get(op.entityId);
          const actualVersion = current?.serverVersion ?? tombstone?.serverVersion ?? 0;
          if (current?.recordingCount > 0 || tombstone || actualVersion !== op.baseServerVersion) {
            const remote = db.prepare("SELECT server_version serverVersion,record_json recordJson,content_hash contentHash,lifecycle FROM sync_entities WHERE entity_type='note' AND id=?").get(op.entityId);
            throw Object.assign(new Error(), { status: 409, conflict: { operationId: op.operationId, id: op.entityId, actualVersion, remote: remote ? { ...remote, record: JSON.parse(remote.recordJson) } : null, tombstoned: Boolean(tombstone) } });
          }
          const version = actualVersion + 1, recordJson = canonicalJson(op.record), content = { ...op.record };
          delete content.revision; delete content.createdAt; delete content.updatedAt;
          const contentHash = createHash('sha256').update(canonicalJson(content)).digest('hex');
          const cursor = appendChange(db, 'note', op.entityId, version, 'upsert', recordJson);
          if (current) db.prepare('UPDATE sync_entities SET server_version=?,record_json=?,content_hash=?,lifecycle=?,recording_count=0,committed_cursor=? WHERE entity_type=\'note\' AND id=?').run(version,recordJson,contentHash,op.record.lifecycle,cursor,op.entityId);
          else db.prepare('INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES(\'note\',?,?,?,?,?,0,?)').run(op.entityId,version,recordJson,contentHash,op.record.lifecycle,cursor);
          const ack = { operationId: op.operationId, id: op.entityId, serverVersion: version, serverCursor: cursor, contentHash, lifecycle: op.record.lifecycle, localRevision: op.record.revision };
          db.prepare('INSERT INTO sync_operations VALUES(?,?,?,?,?)').run(device.id,op.operationId,requestHash,canonicalJson(ack),cursor);
          acknowledgements.push(ack);
        }
        return { acknowledgements, ...serverMeta(db) };
      }); } catch (error) {
        if (error.status === 409) return response({ error: error.conflict?.reason ?? 'conflict', conflict: error.conflict, ...serverMeta(db) }, 409);
        throw error;
      }
      return response(result);
    }
    if (action === 'bootstrap/commit') {
      if (!body || Object.keys(body).sort().join(',') !== 'protocolVersion,records' || body.protocolVersion !== 1 || !Array.isArray(body.records) || body.records.length > OPERATION_LIMITS.maxOperations) return fail('invalid_bootstrap',400);
      const parsed = [];
      try {
        const ids = new Set();
        for (const item of body.records) {
          if (!item || Object.keys(item).sort().join(',') !== 'note,recordingCount' || item.recordingCount !== 0 || !item.note || Buffer.byteLength(canonicalJson(item.note)) > OPERATION_LIMITS.maxRecordBytes || item.note.privacy === 'DEVICE_ONLY' || ids.has(item.note.id)) throw new Error();
          assertNoteRecord(item.note);
          ids.add(item.note.id);
          parsed.push(item.note);
        }
      } catch { return fail('invalid_bootstrap',400); }
      try {
        const committed = transaction(db, () => {
          const inserted=[];
          for (const note of parsed) {
            if (db.prepare("SELECT 1 FROM sync_entities WHERE entity_type='note' AND id=? UNION SELECT 1 FROM sync_tombstones WHERE entity_type='note' AND id=?").get(note.id,note.id)) throw Object.assign(new Error(),{status:409});
            const recordJson=canonicalJson(note), content={...note};delete content.revision;delete content.createdAt;delete content.updatedAt;
            const contentHash=createHash('sha256').update(canonicalJson(content)).digest('hex'), cursor=appendChange(db,'note',note.id,1,'upsert',recordJson);
            db.prepare("INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES('note',?,1,?,?,?,0,?)").run(note.id,recordJson,contentHash,note.lifecycle,cursor);
            inserted.push({id:note.id,serverVersion:1,serverCursor:cursor,contentHash,lifecycle:note.lifecycle,localRevision:note.revision});
          }
          return {inserted,...serverMeta(db)};
        });
        return response(committed);
      } catch(error) { return fail(error.status===409?'bootstrap_collision':'sync_storage_unavailable',error.status??503); }
    }
    let records;
    try { records = validateSummaries(body); } catch { return fail('invalid_bootstrap_summaries', 400); }
    // One read transaction gives a consistent server snapshot. No preview session or note writes.
    const preview = transaction(db, () => {
      const count = db.prepare("SELECT count(*) n FROM sync_entities WHERE entity_type='note'").get().n;
      const tombstoneCount = db.prepare("SELECT count(*) n FROM sync_tombstones WHERE entity_type='note'").get().n;
      if (count + tombstoneCount > SYNC_LIMITS.maxRecords) throw Object.assign(new Error(), { status: 409 });
      const server = db.prepare("SELECT id,content_hash contentHash,lifecycle,recording_count recordingCount FROM sync_entities WHERE entity_type='note' ORDER BY id").all();
      const tombstones = db.prepare("SELECT id FROM sync_tombstones WHERE entity_type='note' ORDER BY id").all();
      return { ...serverMeta(db), serverEmpty: count === 0 && tombstoneCount === 0, serverNoteCount: count, ...compareSummaries(records, server, tombstones), synchronizationActive: false, previewOnly: true };
    }, 'DEFERRED');
    return response(preview);
  } catch (error) {
    // Never include request bodies, labels, hashes, tokens, SQL, or filesystem details in errors/logs.
    return fail(error.status === 413 ? 'payload_too_large' : error.status === 400 ? 'invalid_json' : error.status === 403 ? 'csrf_denied' : error.status === 409 ? 'preview_capacity_exceeded' : 'sync_storage_unavailable', error.status ?? 503);
  } finally { db?.close(); }
}
