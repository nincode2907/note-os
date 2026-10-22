import { openStore, serverMeta, transaction } from './storage.mjs';
import { authenticate, redeemPairingCode, revokeDevice } from './auth.mjs';
import { compareSummaries, validateSummaries, SYNC_LIMITS } from '../app/lib/sync-protocol.mjs';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function response(body, status = 200, extra = {}) { return Response.json(body, { status, headers: { ...headers, ...extra } }); }
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
    const cookie = token => `${cookieName}=${token}; Path=/api/v1/sync; HttpOnly; SameSite=Strict; Max-Age=${token ? 2592000 : 0}${origin.protocol === 'https:' ? '; Secure' : ''}`;
    if (!['status','pair','revoke','bootstrap/dry-run'].includes(action)) return fail('route_not_found', 404);
    if ((action === 'status' && req.method !== 'GET') || (action !== 'status' && req.method !== 'POST')) return fail('method_not_allowed', 405);
    db = openStore(env.NOTEOS_SYNC_STORAGE);
    if (action === 'pair') {
      const body = await bodyJson(req);
      if (!body || Object.keys(body).sort().join(',') !== 'code,label' || typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(body.code) || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80 || /[\x00-\x1f\x7f]/.test(body.label)) return fail('invalid_pairing_request', 400);
      const result = redeemPairingCode(db, body.code, body.label.trim());
      if (result.error) return fail(result.error, result.status);
      return response({ device: { id: result.id, label: result.label }, synchronizationActive: false }, 200, { 'Set-Cookie': cookie(result.token) });
    }
    const values = (req.headers.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(cookieName + '='));
    const device = values.length === 1 ? authenticate(db, values[0].slice(cookieName.length + 1)) : null;
    if (!device) return fail('authentication_required', 401);
    if (action === 'status') return response({ ...serverMeta(db), device: { id: device.id, label: device.label }, synchronizationActive: false, noteCount: db.prepare("SELECT count(*) n FROM sync_entities WHERE entity_type='note'").get().n });
    const body = await bodyJson(req);
    if (action === 'revoke') {
      if (!body || Object.keys(body).length) return fail('invalid_request', 400);
      revokeDevice(db, device.id);
      return response({ revoked: true }, 200, { 'Set-Cookie': cookie('') });
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
