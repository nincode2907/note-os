import { authenticate } from './auth.mjs';
import { allowedOrigin } from './http.mjs';
import { applyAiConsentOperation, consumeAiBridgeRateLimit, createAiAnalysisRequest, readAiConsent } from './ai-foundation.mjs';
import { openStore } from './storage.mjs';

const baseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const MAX_BODY_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(body, status = 200) {
  return Response.json(body, { status, headers: baseHeaders });
}

function fail(error, status) { return response({ error }, status); }

async function bodyJson(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json' || request.headers.get('x-noteos-ai') !== '1') {
    throw Object.assign(new Error(), { status: 403, code: 'csrf_denied' });
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw Object.assign(new Error(), { status: 413, code: 'payload_too_large' });
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error(), { status: 400, code: 'invalid_json' });
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw Object.assign(new Error(), { status: 413, code: 'payload_too_large' }); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error(), { status: 400, code: 'invalid_json' });
  }
}

function consentEnvelope(body, action) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (action === 'GRANT') return Object.keys(body).sort().join(',') === 'executionBoundary,expectedContentHash,expectedServerEpoch,expectedServerVersion,protocolVersion,requestId,scope' && body.protocolVersion === 1 && UUID.test(body.requestId ?? '') && body.scope === 'organize' && body.executionBoundary === 'MOCK' && typeof body.expectedServerEpoch === 'string' && body.expectedServerEpoch.length <= 128 && Number.isSafeInteger(body.expectedServerVersion) && /^[a-f0-9]{64}$/.test(body.expectedContentHash ?? '');
  return Object.keys(body).sort().join(',') === 'protocolVersion,requestId' && body.protocolVersion === 1 && UUID.test(body.requestId ?? '');
}

function analysisEnvelope(body) {
  const keys = ['consentEpoch','executionBoundary','expectedContentHash','expectedServerEpoch','expectedServerVersion','noteId','protocolVersion','requestId','scope'];
  return Boolean(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).sort().join(',') === keys.sort().join(',') &&
    body.protocolVersion === 1 && UUID.test(body.requestId ?? '') && typeof body.noteId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.noteId) &&
    typeof body.expectedServerEpoch === 'string' && body.expectedServerEpoch.length <= 128 && Number.isSafeInteger(body.expectedServerVersion) &&
    /^[a-f0-9]{64}$/.test(body.expectedContentHash ?? '') && Number.isSafeInteger(body.consentEpoch) && body.scope === 'organize' && body.executionBoundary === 'MOCK');
}

function migrationReady(db) {
  try { return db.prepare('SELECT 1 FROM ai_schema_migrations WHERE version=2').get() !== undefined; }
  catch { return false; }
}

function mapError(error) {
  const known = new Map([
    ['AI_DISABLED', 503], ['SYNC_REQUIRED', 409], ['STALE_REVISION', 409], ['SERVER_EPOCH_CHANGED', 409],
    ['CONSENT_REQUIRED', 403], ['CONSENT_CHANGED', 409], ['DEVICE_ONLY', 403], ['PRIVACY_REQUIRED', 403],
    ['PRIVACY_UNSUPPORTED', 403], ['NOTE_INACTIVE', 409], ['IDEMPOTENCY_CONFLICT', 409],
    ['RATE_LIMITED', 429], ['AI_REVOCATION_NOT_PERSISTED', 503], ['REVOCATION_PENDING', 409], ['AI_CONTROL_UNAVAILABLE', 503],
  ]);
  if (error?.code && known.has(error.code)) return fail(error.code, known.get(error.code));
  if (error?.status === 413) return fail('payload_too_large', 413);
  if (error?.status === 400) return fail('invalid_json', 400);
  if (error?.status === 403) return fail(error.code ?? 'csrf_denied', 403);
  if (error instanceof TypeError || error?.code === 'ERR_INVALID_ARG_TYPE') return fail('invalid_request', 400);
  return fail('ai_storage_unavailable', 503);
}

/** Independent authenticated AI API. It never claims or runs an AI job. */
export async function handleAi(request, action, env = process.env) {
  if (env.NOTEOS_SYNC_ENABLED !== '1' || env.NOTEOS_AI_ORGANIZE_ENABLED !== '1') return fail('ai_disabled', 503);
  let db;
  try {
    const url = new URL(request.url);
    if (url.search) return fail('query_parameters_not_supported', 400);
    const origin = allowedOrigin(request, env);
    if (!origin) return fail('origin_denied', 403);
    if (action === 'status') {
      if (request.method !== 'GET') return fail('method_not_allowed', 405);
      return response({ enabled: true, scope: 'organize', executionBoundary: 'MOCK', inferenceAvailable: false });
    }
    const consentMatch = action.match(/^consents\/([A-Za-z0-9_-]{1,128})$/);
    const requestMatch = action.match(/^analysis-requests\/([0-9a-f-]{36})$/i);
    const isCollection = action === 'analysis-requests' && request.method === 'POST';
    const isConsentRead = Boolean(consentMatch) && request.method === 'GET';
    const isConsentGrant = Boolean(consentMatch) && request.method === 'PUT';
    const isConsentRevoke = Boolean(consentMatch) && request.method === 'DELETE';
    const isRequestRead = Boolean(requestMatch) && request.method === 'GET';
    if (!(isCollection || isConsentRead || isConsentGrant || isConsentRevoke || isRequestRead)) return fail(consentMatch || requestMatch || action === 'analysis-requests' ? 'method_not_allowed' : 'route_not_found', consentMatch || requestMatch || action === 'analysis-requests' ? 405 : 404);

    const cookieName = origin.protocol === 'https:' ? '__Secure-noteos_ai' : 'noteos_ai_local';
    const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    db = openStore(env.NOTEOS_SYNC_STORAGE);
    const device = cookies.length === 1 ? authenticate(db, cookies[0].slice(cookieName.length + 1)) : null;
    if (!device) return fail('authentication_required', 401);
    if (!migrationReady(db)) return fail('ai_schema_unavailable', 503);
    consumeAiBridgeRateLimit(db, device.id);

    if (isConsentRead) return response({ consent: readAiConsent(db, consentMatch[1]), externalProviderAvailable: false, inferenceAvailable: false });
    if (isRequestRead) {
      const requestId = requestMatch[1];
      if (!UUID.test(requestId)) return fail('invalid_request_id', 400);
      const row = db.prepare(`SELECT request_id requestId,note_id noteId,server_version serverVersion,consent_epoch consentEpoch,scope,execution_boundary executionBoundary,job_id jobId
        FROM ai_analysis_requests WHERE request_id=?`).get(requestId);
      if (!row) return fail('request_not_found', 404);
      const job = db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(row.jobId);
      return response({ requestId: row.requestId, noteId: row.noteId, serverVersion: row.serverVersion, consentEpoch: row.consentEpoch, scope: row.scope, executionBoundary: row.executionBoundary, jobId: row.jobId, status: job?.status ?? 'UNKNOWN' });
    }

    const body = await bodyJson(request);
    if (isConsentGrant || isConsentRevoke) {
      const actionName = isConsentGrant ? 'GRANT' : 'REVOKE';
      if (!consentEnvelope(body, actionName)) return fail('invalid_consent_request', 400);
      const result = applyAiConsentOperation(db, consentMatch[1], { action: actionName, requestId: body.requestId, actorDeviceId: device.id, expectedServerEpoch: body.expectedServerEpoch, expectedServerVersion: body.expectedServerVersion, expectedContentHash: body.expectedContentHash, env });
      return response({ consent: result, externalProviderAvailable: false, inferenceAvailable: false });
    }
    if (!analysisEnvelope(body)) return fail('invalid_analysis_request', 400);
    const result = createAiAnalysisRequest(db, body, { actorDeviceId: device.id, env });
    return response({ ...result, inferenceAvailable: false });
  } catch (error) {
    return mapError(error);
  } finally { db?.close(); }
}
