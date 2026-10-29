import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertNoteRecord } from '../app/lib/note-validation.mjs';
import { normalizeTagLabel, tagKey } from '../app/lib/note-organization.mjs';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';
import { serverMeta, transaction } from './storage.mjs';
import { aiExecutionProfile } from './ai-provider-gateway.mjs';
import {
  aiNoteKey, clearSatisfiedRevocationIntents, ensureAiControlPlane, inferenceBlockReason, listAiControlState,
  persistAutomaticInferenceStop, persistRevocationIntent, recordWorkerHeartbeat, removeRevocationIntent,
} from './ai-control.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, 'migrations/001-ai-foundation.sql');
const BRIDGE_MIGRATION = join(HERE, 'migrations/002-ai-consent-bridge.sql');
const LOCAL_BOUNDARY_MIGRATION = join(HERE, 'migrations/003-ai-local-boundary.sql');
const DECISIONS_MIGRATION = join(HERE, 'migrations/004-ai-suggestion-decisions.sql');
export const AI_SCHEMA_VERSION = 4;
const MAX_QUEUE = 1000;
const MAX_CONSENT_ROWS = 1000;
const MAX_JOB_ROWS = 10000;
const MAX_AUDIT = 10000;
const MAX_ATTEMPTS = 5;
const MAX_PAYLOAD_BYTES = 8192;
const ALLOWED_SCOPES = new Set(['organize']);
const OUTPUT_KEYS = ['categorySuggestion','insufficientContext','relatedCandidates','schemaVersion','shortSummary','tagCandidates','taskCandidates','uncertainty'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const nowDefault = () => Date.now();
const revocationFailClosedNotes = new Set();
const assertNoteId = noteId => {
  if (typeof noteId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(noteId)) throw new TypeError('Invalid note ID');
};

export function isAiRevocationFailClosed(noteId) {
  return revocationFailClosedNotes.has(noteId);
}

export function aiFeatureFlags(env = process.env) {
  return Object.freeze({
    organizeEnabled: env.NOTEOS_AI_ORGANIZE_ENABLED === '1',
    inferenceEnabled: env.NOTEOS_AI_INFERENCE_ENABLED === '1',
  });
}

/** Apply only when explicitly called by a reviewed migration path. openStore never calls this. */
export function applyAiSchema(db) {
  const version = transaction(db, () => {
    db.exec(readFileSync(MIGRATION, 'utf8'));
    const current = () => db.prepare('SELECT max(version) version FROM ai_schema_migrations').get().version ?? 0;
    if (current() === 1) db.exec(readFileSync(BRIDGE_MIGRATION, 'utf8'));
    if (current() === 2) db.exec(readFileSync(LOCAL_BOUNDARY_MIGRATION, 'utf8'));
    if (current() === 3) db.exec(readFileSync(DECISIONS_MIGRATION, 'utf8'));
    const versions = db.prepare('SELECT version FROM ai_schema_migrations ORDER BY version').all().map(row => row.version);
    if (versions.join(',') !== '1,2,3,4') throw new Error('AI migration ledger requires review');
    return versions.at(-1);
  });
  ensureAiControlPlane(db);
  return version;
}

function parseConsent(row) {
  if (!row) return null;
  try { return { ...row, scopes: JSON.parse(row.scopes_json) }; }
  catch { return null; }
}

/** Pure policy decision. This does not contact a provider or touch storage. */
export function evaluateAiPolicy({ note, consent, scope = 'organize', executionBoundary, localExecutionAttested = false, phase09a = true }) {
  const reject = reason => Object.freeze({ allowed: false, reason, consentEpoch: Number.isSafeInteger(consent?.consent_epoch) ? consent.consent_epoch : null });
  if (!note || typeof note.privacy !== 'string') return reject('privacy_missing');
  if (note.privacy === 'DEVICE_ONLY') return reject('device_only');
  if (!['PRIVATE_SERVER','CLOUD_ALLOWED'].includes(note.privacy)) return reject('privacy_unsupported');
  if (note.lifecycle !== 'active') return reject('note_inactive');
  if (!consent || !['APPROVED_LOCAL_ONLY','APPROVED_CLOUD_ALLOWED'].includes(consent.state)) return reject(consent?.state === 'REVOKED' ? 'consent_revoked' : 'consent_missing');
  if (!Number.isSafeInteger(consent.consent_epoch) || consent.consent_epoch < 1 || !['STRICT_LOCAL','EXTERNAL_CLOUD','MOCK'].includes(consent.provider_boundary)) return reject('consent_invalid');
  let scopes = consent.scopes;
  if (typeof scopes === 'string') { try { scopes = JSON.parse(scopes); } catch { return reject('consent_invalid'); } }
  if (!Array.isArray(scopes) || !scopes.includes(scope) || scopes.some(value => !ALLOWED_SCOPES.has(value))) return reject('scope_not_approved');
  if (note.privacy === 'PRIVATE_SERVER' && (consent.state !== 'APPROVED_LOCAL_ONLY' || executionBoundary === 'EXTERNAL_CLOUD')) return reject('private_server_requires_local_consent');
  if (executionBoundary === 'EXTERNAL_CLOUD') {
    if (phase09a) return reject('external_provider_disabled_in_09a');
    if (note.privacy !== 'CLOUD_ALLOWED' || consent.state !== 'APPROVED_CLOUD_ALLOWED' || consent.provider_boundary !== 'EXTERNAL_CLOUD') return reject('cloud_consent_required');
    return reject('external_provider_not_implemented');
  }
  if (executionBoundary === 'STRICT_LOCAL' && (!localExecutionAttested || consent.state !== 'APPROVED_LOCAL_ONLY' || consent.provider_boundary !== 'STRICT_LOCAL')) return reject('local_execution_not_proven');
  if (executionBoundary !== 'MOCK' && executionBoundary !== 'STRICT_LOCAL') return reject('provider_boundary_unknown');
  if (executionBoundary === 'MOCK' && consent.provider_boundary !== 'MOCK') return reject('provider_boundary_mismatch');
  return Object.freeze({ allowed: true, reason: 'eligible', consentEpoch: consent.consent_epoch });
}

function audit(db, { action, noteId = null, jobId = null, actorId = null, reasonCode, metadata = {}, now }) {
  if (db.prepare('SELECT count(*) AS n FROM ai_audit_log').get().n >= MAX_AUDIT) throw new Error('AI audit capacity reached; preservation required');
  const metadataJson = canonicalJson(metadata);
  if (Buffer.byteLength(metadataJson) > 1024) throw new Error('AI audit metadata exceeds limit');
  db.prepare('INSERT INTO ai_audit_log(action,note_id,job_id,actor_id,reason_code,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(action, noteId, jobId, actorId, reasonCode, metadataJson, now);
}

function boundedScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 1 || scopes.some(scope => !ALLOWED_SCOPES.has(scope))) throw new TypeError('Invalid AI consent scopes');
  return [...new Set(scopes)].sort();
}

function grantNoteConsentInTransaction(db, noteId, { state = 'APPROVED_LOCAL_ONLY', scopes = ['organize'], providerBoundary = 'MOCK', actorId = null, actorDeviceId = null, env = process.env, now = nowDefault() } = {}) {
  if (!aiFeatureFlags(env).organizeEnabled) throw new Error('AI organize is disabled');
  assertNoteId(noteId);
  if (isAiRevocationFailClosed(noteId)) throw bridgeFailure('REVOCATION_PENDING');
  const blocked = inferenceBlockReason(db, noteId);
  if (blocked === 'revocation_state_uncertain') throw bridgeFailure('REVOCATION_PENDING');
  if (blocked === 'control_plane_unavailable') throw bridgeFailure('AI_CONTROL_UNAVAILABLE', 503);
  if (!['APPROVED_LOCAL_ONLY','APPROVED_CLOUD_ALLOWED'].includes(state) || !['MOCK','STRICT_LOCAL','EXTERNAL_CLOUD'].includes(providerBoundary)) throw new TypeError('Invalid AI consent');
  const normalizedScopes = boundedScopes(scopes), scopesJson = canonicalJson(normalizedScopes);
  const noteRow = db.prepare("SELECT record_json recordJson,lifecycle FROM sync_entities WHERE entity_type='note' AND id=?").get(noteId);
  if (!noteRow || noteRow.lifecycle !== 'active' || JSON.parse(noteRow.recordJson).lifecycle !== 'active') throw new Error('Consent requires an existing active synced note');
  // Defense in depth: no consent row is ever created for an ineligible privacy class.
  const privacy = JSON.parse(noteRow.recordJson).privacy;
  if (privacy === 'DEVICE_ONLY') throw bridgeFailure('DEVICE_ONLY', 403);
  if (privacy === undefined || privacy === null) throw bridgeFailure('PRIVACY_REQUIRED', 403);
  if (!['PRIVATE_SERVER','CLOUD_ALLOWED'].includes(privacy)) throw bridgeFailure('PRIVACY_UNSUPPORTED', 403);
  const previous = db.prepare('SELECT consent_epoch,state FROM ai_note_consent WHERE note_id=?').get(noteId);
  if (!previous && db.prepare('SELECT count(*) AS n FROM ai_note_consent').get().n >= MAX_CONSENT_ROWS) throw new Error('AI consent capacity reached');
  // Controlled pilot: an optional owner-set cap on how many notes may hold an active grant at once.
  const pilotCap = Number(env.NOTEOS_AI_PILOT_MAX_NOTES || 0);
  if (pilotCap > 0 && !String(previous?.state ?? '').startsWith('APPROVED') && db.prepare("SELECT count(*) AS n FROM ai_note_consent WHERE state IN ('APPROVED_LOCAL_ONLY','APPROVED_CLOUD_ALLOWED')").get().n >= pilotCap) throw bridgeFailure('PILOT_NOTE_LIMIT');
  const consentEpoch = (previous?.consent_epoch ?? 0) + 1;
  db.prepare(`INSERT INTO ai_note_consent(note_id,state,scopes_json,provider_boundary,consent_epoch,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET state=excluded.state,scopes_json=excluded.scopes_json,
    provider_boundary=excluded.provider_boundary,consent_epoch=excluded.consent_epoch,updated_at=excluded.updated_at`)
    .run(noteId, state, scopesJson, providerBoundary, consentEpoch, now);
  audit(db, { action: 'CONSENT_GRANTED', noteId, actorId, reasonCode: 'explicit_grant', metadata: { state, scopes: normalizedScopes, providerBoundary, consentEpoch, ...(actorDeviceId ? { actorDeviceId } : {}) }, now });
  return { noteId, state, scopes: normalizedScopes, providerBoundary, consentEpoch };
}

export function grantNoteConsent(db, noteId, options = {}) {
  assertNoteId(noteId);
  return transaction(db, () => grantNoteConsentInTransaction(db, noteId, options));
}

function revokeNoteConsentInTransaction(db, noteId, { actorId = null, actorDeviceId = null, reasonCode = 'owner_revoked', now = nowDefault() } = {}) {
      const current = db.prepare('SELECT * FROM ai_note_consent WHERE note_id=?').get(noteId);
      if (!current && db.prepare('SELECT count(*) AS n FROM ai_note_consent').get().n >= MAX_CONSENT_ROWS) throw new Error('AI consent capacity reached');
      const alreadyRevoked = current?.state === 'REVOKED';
      const consentEpoch = (current?.consent_epoch ?? 0) + (alreadyRevoked ? 0 : 1);
      const revokedAt = alreadyRevoked ? current.updated_at : now;
      db.prepare(`INSERT INTO ai_note_consent(note_id,state,scopes_json,provider_boundary,consent_epoch,updated_at)
        VALUES(?,'REVOKED','[]','MOCK',?,?) ON CONFLICT(note_id) DO UPDATE SET state='REVOKED',scopes_json='[]',
        consent_epoch=excluded.consent_epoch,updated_at=excluded.updated_at`).run(noteId, consentEpoch, revokedAt);
      const canceledJobs = db.prepare(`UPDATE ai_jobs SET status='CANCELED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=?
        WHERE note_id=? AND status IN ('QUEUED','RUNNING')`).run(now, noteId).changes;
      const purgedSuggestions = db.prepare(`UPDATE ai_suggestions SET
        status=CASE WHEN status IN ('PENDING_REVIEW','STALE') THEN 'REVOKED' ELSE status END,
        payload_json='{}',updated_at=? WHERE note_id=? AND (payload_json<>'{}' OR status IN ('PENDING_REVIEW','STALE'))`).run(now, noteId).changes;

      // ai_note_consent is the durable minimal marker. The general audit is best-effort
      // under its logical quota and remains in this transaction when capacity exists.
      if (!alreadyRevoked && db.prepare('SELECT count(*) AS n FROM ai_audit_log').get().n < MAX_AUDIT) {
        audit(db, { action: 'CONSENT_REVOKED', noteId, actorId, reasonCode, metadata: { consentEpoch, canceledJobs, purgedSuggestions, ...(actorDeviceId ? { actorDeviceId } : {}) }, now });
      }
      return { noteId, state: 'REVOKED', consentEpoch, canceledJobs, purgedSuggestions, alreadyRevoked };
}

/**
 * Cross-process revocation: a durable write-ahead intent marker is created before the
 * SQLite transaction. Every process blocks dispatch/publication while a marker exists,
 * so a failed or interrupted commit stays fail-closed until a retry or reconcile commits.
 */
function persistRevocation(db, noteId, commit, { onIntentPersisted } = {}) {
  const wasLatched = revocationFailClosedNotes.has(noteId);
  revocationFailClosedNotes.add(noteId);
  let intent = null;
  try { intent = persistRevocationIntent(db, noteId); } catch { intent = null; }
  if (intent) onIntentPersisted?.(intent);
  let result;
  try { result = commit(); }
  catch (cause) {
    if (cause?.code === 'IDEMPOTENCY_CONFLICT' || cause instanceof TypeError) {
      // A rejected caller request rolled back before any write: restore the prior state exactly.
      if (!wasLatched) revocationFailClosedNotes.delete(noteId);
      if (intent) { try { removeRevocationIntent(db, intent); } catch { /* over-blocks until reconcile */ } }
      throw cause;
    }
    // Keep this process latched. Without a per-note intent, stop all inference globally.
    let controlPlane = intent ? 'revocation_intent_persisted' : 'unavailable';
    if (!intent) { try { persistAutomaticInferenceStop(db); controlPlane = 'global_stop_persisted'; } catch { /* reported below */ } }
    throw Object.assign(new Error('AI consent revocation was not persisted; inference is paused'), { code: 'AI_REVOCATION_NOT_PERSISTED', controlPlane, cause });
  }
  revocationFailClosedNotes.delete(noteId);
  // The committed REVOKED row is authoritative; a marker that cannot be removed only over-blocks.
  try { clearSatisfiedRevocationIntents(db, noteId, Date.now()); } catch { /* reconcile retries */ }
  return result;
}

export function revokeNoteConsent(db, noteId, options = {}) {
  assertNoteId(noteId);
  return persistRevocation(db, noteId, () => transaction(db, () => revokeNoteConsentInTransaction(db, noteId, options)), options);
}

/** Complete durable revocation intents left by a crash or failed commit. Safe to repeat. */
export function reconcileAiRevocationIntents(db, { now = nowDefault() } = {}) {
  const { pendingRevocationKeys } = listAiControlState(db);
  if (!pendingRevocationKeys.length) return { completed: [], unmatched: [] };
  const known = new Map();
  for (const sql of ['SELECT note_id id FROM ai_note_consent', 'SELECT DISTINCT note_id id FROM ai_jobs', "SELECT id FROM sync_entities WHERE entity_type='note'"]) {
    for (const row of db.prepare(sql).all()) known.set(aiNoteKey(row.id), row.id);
  }
  const completed = [], unmatched = [];
  for (const key of pendingRevocationKeys) {
    const noteId = known.get(key);
    if (!noteId) { unmatched.push(key); continue; }
    transaction(db, () => revokeNoteConsentInTransaction(db, noteId, { reasonCode: 'recovered_revocation_intent', now }));
    revocationFailClosedNotes.delete(noteId);
    clearSatisfiedRevocationIntents(db, noteId, Date.now());
    completed.push(noteId);
  }
  return { completed, unmatched };
}

function requestIdentity(requestId) {
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new TypeError('Invalid AI request ID');
}

function bridgeFailure(code, status = 409) {
  return Object.assign(new Error(code), { code, status });
}

export function readAiConsent(db, noteId) {
  assertNoteId(noteId);
  const row = db.prepare('SELECT note_id noteId,state,scopes_json scopesJson,provider_boundary providerBoundary,consent_epoch consentEpoch,updated_at updatedAt FROM ai_note_consent WHERE note_id=?').get(noteId);
  if (!row) return { noteId, state: 'NONE', scopes: [], providerBoundary: null, consentEpoch: null, updatedAt: null };
  let scopes;
  try { scopes = JSON.parse(row.scopesJson); } catch { throw new Error('AI consent record is invalid'); }
  return { noteId: row.noteId, state: row.state, scopes, providerBoundary: row.providerBoundary, consentEpoch: row.consentEpoch, updatedAt: row.updatedAt };
}

/** Atomically apply a device-scoped, replay-safe consent operation and its receipt. */
export function applyAiConsentOperation(db, noteId, { action, requestId, actorDeviceId, expectedServerEpoch, expectedServerVersion, expectedContentHash, env = process.env, now = nowDefault(), onIntentPersisted } = {}) {
  assertNoteId(noteId); requestIdentity(requestId);
  if (!['GRANT','REVOKE'].includes(action) || typeof actorDeviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actorDeviceId)) throw new TypeError('Invalid AI consent operation');
  const operation = { action, noteId, actorDeviceId, protocolVersion: 1, ...(action === 'GRANT' ? { scope: 'organize', executionBoundary: aiExecutionProfile(env).executionBoundary, expectedServerEpoch, expectedServerVersion, expectedContentHash } : {}) };
  const requestHash = sha256(canonicalJson(operation));
  const commit = () => transaction(db, () => {
      const prior = db.prepare('SELECT request_hash requestHash,actor_device_id actorDeviceId,result_json resultJson FROM ai_consent_operations WHERE request_id=?').get(requestId);
      if (prior) {
        if (prior.requestHash !== requestHash || prior.actorDeviceId !== actorDeviceId) throw bridgeFailure('IDEMPOTENCY_CONFLICT');
        return { ...JSON.parse(prior.resultJson), replayed: true };
      }
      let value;
      if (action === 'GRANT') {
        const current = db.prepare("SELECT record_json recordJson,lifecycle FROM sync_entities WHERE entity_type='note' AND id=?").get(noteId);
        if (!current) throw bridgeFailure('SYNC_REQUIRED');
        const meta = serverMeta(db);
        const live = db.prepare("SELECT server_version serverVersion,content_hash contentHash FROM sync_entities WHERE entity_type='note' AND id=?").get(noteId);
        if (expectedServerEpoch !== meta.serverEpoch || !Number.isSafeInteger(expectedServerVersion) || !/^[a-f0-9]{64}$/.test(expectedContentHash ?? '')) throw new TypeError('Invalid consent revision envelope');
        if (live.serverVersion !== expectedServerVersion || live.contentHash !== expectedContentHash) throw bridgeFailure(live.serverVersion < expectedServerVersion ? 'SYNC_REQUIRED' : 'STALE_REVISION');
        const note = JSON.parse(current.recordJson);
        if (current.lifecycle !== 'active' || note.lifecycle !== 'active') throw bridgeFailure('NOTE_INACTIVE');
        if (note.privacy === undefined || note.privacy === null) throw bridgeFailure('PRIVACY_REQUIRED');
        if (note.privacy === 'DEVICE_ONLY') throw bridgeFailure('DEVICE_ONLY');
        if (!['PRIVATE_SERVER','CLOUD_ALLOWED'].includes(note.privacy)) throw bridgeFailure('PRIVACY_UNSUPPORTED');
        value = grantNoteConsentInTransaction(db, noteId, { state: 'APPROVED_LOCAL_ONLY', scopes: ['organize'], providerBoundary: aiExecutionProfile(env).executionBoundary, actorId: actorDeviceId, actorDeviceId, env, now });
      } else {
        const current = db.prepare('SELECT state FROM ai_note_consent WHERE note_id=?').get(noteId);
        value = current ? revokeNoteConsentInTransaction(db, noteId, { actorId: actorDeviceId, actorDeviceId, now }) : { noteId, state: 'NONE', consentEpoch: null, alreadyRevoked: true };
      }
      db.prepare('INSERT INTO ai_consent_operations(request_id,request_hash,actor_device_id,note_id,action,result_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(requestId, requestHash, actorDeviceId, noteId, action, canonicalJson(value), now);
      return value;
    });
  if (action !== 'REVOKE') return commit();
  return persistRevocation(db, noteId, commit, { onIntentPersisted });
}

function sourceForNote(db, noteId, serverVersion) {
  const event = db.prepare(`SELECT server_cursor sourceCursor,entity_id noteId,server_version serverVersion,event,record_json recordJson
    FROM sync_changelog WHERE entity_type='note' AND entity_id=? AND server_version=?`).get(noteId, serverVersion);
  const live = db.prepare("SELECT server_version serverVersion,record_json recordJson,content_hash contentHash,lifecycle,committed_cursor committedCursor FROM sync_entities WHERE entity_type='note' AND id=?").get(noteId);
  if (!event || event.event !== 'upsert' || !event.recordJson || !live) throw new Error('Committed active note revision not found');
  const note = JSON.parse(event.recordJson);
  assertNoteRecord(note);
  if (note.lifecycle !== 'active' || live.lifecycle !== 'active' || live.serverVersion !== serverVersion || live.committedCursor !== event.sourceCursor) throw new Error('Note revision is stale or inactive');
  const content = { ...note };
  delete content.revision; delete content.createdAt; delete content.updatedAt;
  const contentHash = sha256(canonicalJson(content));
  if (contentHash !== live.contentHash) throw new Error('Committed note hash mismatch');
  return { note, sourceCursor: event.sourceCursor, contentHash };
}

function enqueueAiJobInTransaction(db, noteId, { serverVersion, env = process.env, analysisPolicyVersion = 'ai-policy-v1', promptSchemaVersion = 1, modelIdentity: requestedModel, scope = 'organize', actorDeviceId = null, now = nowDefault() } = {}) {
  const profile = aiExecutionProfile(env), { executionBoundary } = profile;
  // Synthetic MOCK jobs may name a test model; an attested local job always uses the configured identity.
  const modelIdentity = executionBoundary === 'MOCK' && requestedModel !== undefined ? requestedModel : profile.modelIdentity;
  assertNoteId(noteId);
  if (isAiRevocationFailClosed(noteId) || inferenceBlockReason(db, noteId) === 'revocation_state_uncertain') throw bridgeFailure('REVOCATION_PENDING');
  const flags = aiFeatureFlags(env);
  if (!flags.organizeEnabled) throw new Error('AI organize is disabled');
  if (!Number.isSafeInteger(serverVersion) || serverVersion < 1) throw new TypeError('A committed server version is required');
  const source = sourceForNote(db, noteId, serverVersion);
  const consent = parseConsent(db.prepare('SELECT * FROM ai_note_consent WHERE note_id=?').get(noteId));
  const policy = evaluateAiPolicy({ note: source.note, consent, scope, executionBoundary, localExecutionAttested: profile.localExecutionAttested });
  if (!policy.allowed) throw Object.assign(new Error('AI policy rejected request'), { reason: policy.reason });
  const meta = serverMeta(db);
  const dedupeKey = sha256(canonicalJson({ noteId, serverEpoch: meta.serverEpoch, serverVersion, sourceCursor: source.sourceCursor, contentHash: source.contentHash, consentEpoch: policy.consentEpoch, scope, analysisPolicyVersion, promptSchemaVersion, modelIdentity, executionBoundary }));
  const prior = db.prepare('SELECT id,status FROM ai_jobs WHERE dedupe_key=?').get(dedupeKey);
  if (prior) return { id: prior.id, status: prior.status, reused: true };
  if (db.prepare("SELECT count(*) AS n FROM ai_jobs WHERE status IN ('QUEUED','RUNNING')").get().n >= MAX_QUEUE) throw new Error('AI queue capacity reached');
  if (db.prepare('SELECT count(*) AS n FROM ai_jobs').get().n >= MAX_JOB_ROWS) throw new Error('AI job retention capacity reached; owner review required');
  db.prepare("UPDATE ai_jobs SET status='SUPERSEDED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE note_id=? AND target_server_version<? AND status IN ('QUEUED','RUNNING')").run(now, noteId, serverVersion);
  const id = randomUUID();
  db.prepare(`INSERT INTO ai_jobs(id,note_id,server_epoch,source_cursor,target_server_version,content_sha256,consent_epoch,
    analysis_policy_version,prompt_schema_version,model_identity,execution_boundary,dedupe_key,scope,status,attempts,run_after,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'QUEUED',0,?,?,?)`).run(id,noteId,meta.serverEpoch,source.sourceCursor,serverVersion,source.contentHash,policy.consentEpoch,analysisPolicyVersion,promptSchemaVersion,modelIdentity,executionBoundary,dedupeKey,scope,now,now,now);
  audit(db, { action: 'JOB_ENQUEUED', noteId, jobId: id, actorId: actorDeviceId, reasonCode: 'explicit_request', metadata: { serverVersion, sourceCursor: source.sourceCursor, contentHash: source.contentHash, consentEpoch: policy.consentEpoch, analysisPolicyVersion, promptSchemaVersion, modelIdentity, ...(actorDeviceId ? { actorDeviceId } : {}) }, now });
  return { id, status: 'QUEUED', reused: false };
}

export function enqueueAiJob(db, noteId, options = {}) {
  return transaction(db, () => enqueueAiJobInTransaction(db, noteId, options));
}

export function createAiAnalysisRequest(db, envelope, { actorDeviceId, env = process.env, now = nowDefault() } = {}) {
  requestIdentity(envelope?.requestId);
  assertNoteId(envelope?.noteId);
  if (typeof actorDeviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actorDeviceId)) throw new TypeError('Invalid AI request actor');
  const requestHash = sha256(canonicalJson({ ...envelope, actorDeviceId }));
  return transaction(db, () => {
    const prior = db.prepare('SELECT request_hash requestHash,actor_device_id actorDeviceId,result_json resultJson FROM ai_analysis_requests WHERE request_id=?').get(envelope.requestId);
    if (prior) {
      if (prior.requestHash !== requestHash || prior.actorDeviceId !== actorDeviceId) throw bridgeFailure('IDEMPOTENCY_CONFLICT');
      return { ...JSON.parse(prior.resultJson), replayed: true };
    }
    if (!aiFeatureFlags(env).organizeEnabled) throw bridgeFailure('AI_DISABLED', 503);
    if (envelope.protocolVersion !== 1 || envelope.scope !== 'organize' || envelope.executionBoundary !== aiExecutionProfile(env).executionBoundary ||
      typeof envelope.expectedServerEpoch !== 'string' || envelope.expectedServerEpoch.length < 1 || envelope.expectedServerEpoch.length > 128 ||
      !Number.isSafeInteger(envelope.expectedServerVersion) || envelope.expectedServerVersion < 1 ||
      !/^[a-f0-9]{64}$/.test(envelope.expectedContentHash ?? '') || !Number.isSafeInteger(envelope.consentEpoch) || envelope.consentEpoch < 1) throw new TypeError('Invalid AI analysis request');
    const meta = serverMeta(db);
    if (meta.serverEpoch !== envelope.expectedServerEpoch) throw bridgeFailure('SERVER_EPOCH_CHANGED');
    const live = db.prepare("SELECT server_version serverVersion,record_json recordJson,content_hash contentHash,lifecycle FROM sync_entities WHERE entity_type='note' AND id=?").get(envelope.noteId);
    if (!live || live.serverVersion < envelope.expectedServerVersion) throw bridgeFailure('SYNC_REQUIRED');
    if (live.serverVersion > envelope.expectedServerVersion) throw bridgeFailure('STALE_REVISION');
    let source;
    try { source = sourceForNote(db, envelope.noteId, envelope.expectedServerVersion); }
    catch { throw bridgeFailure('STALE_REVISION'); }
    if (source.contentHash !== envelope.expectedContentHash || live.contentHash !== envelope.expectedContentHash) throw bridgeFailure('STALE_REVISION');
    if (source.note.privacy === undefined || source.note.privacy === null) throw bridgeFailure('PRIVACY_REQUIRED');
    if (source.note.privacy === 'DEVICE_ONLY') throw bridgeFailure('DEVICE_ONLY');
    if (!['PRIVATE_SERVER','CLOUD_ALLOWED'].includes(source.note.privacy)) throw bridgeFailure('PRIVACY_UNSUPPORTED');
    const consent = parseConsent(db.prepare('SELECT * FROM ai_note_consent WHERE note_id=?').get(envelope.noteId));
    if (!consent || consent.state === 'REVOKED') throw bridgeFailure('CONSENT_REQUIRED');
    if (consent.consent_epoch !== envelope.consentEpoch || consent.provider_boundary !== envelope.executionBoundary) throw bridgeFailure('CONSENT_CHANGED');
    const policy = evaluateAiPolicy({ note: source.note, consent, scope: envelope.scope, executionBoundary: envelope.executionBoundary, localExecutionAttested: aiExecutionProfile(env).localExecutionAttested });
    if (!policy.allowed) throw bridgeFailure(policy.reason === 'device_only' ? 'DEVICE_ONLY' : 'CONSENT_REQUIRED');
    const job = enqueueAiJobInTransaction(db, envelope.noteId, { serverVersion: envelope.expectedServerVersion, scope: envelope.scope, actorDeviceId, env, now });
    const result = { requestId: envelope.requestId, jobId: job.id, status: job.status, reused: job.reused };
    db.prepare(`INSERT INTO ai_analysis_requests(request_id,request_hash,actor_device_id,note_id,server_epoch,server_version,content_sha256,
      consent_epoch,scope,execution_boundary,job_id,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(envelope.requestId, requestHash, actorDeviceId, envelope.noteId, meta.serverEpoch, envelope.expectedServerVersion, source.contentHash,
        envelope.consentEpoch, envelope.scope, envelope.executionBoundary, job.id, canonicalJson(result), now);
    return result;
  });
}

export function consumeAiBridgeRateLimit(db, deviceId, now = nowDefault()) {
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId) || !Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid AI API rate-limit input');
  return transaction(db, () => {
    const prior = db.prepare('SELECT window_started_at windowStartedAt,request_count requestCount FROM ai_bridge_rate_limits WHERE device_id=?').get(deviceId);
    if (prior && now >= prior.windowStartedAt && now - prior.windowStartedAt < 60000 && prior.requestCount >= 60) throw bridgeFailure('RATE_LIMITED', 429);
    const withinWindow = prior && now >= prior.windowStartedAt && now - prior.windowStartedAt < 60000;
    db.prepare(`INSERT INTO ai_bridge_rate_limits(device_id,window_started_at,request_count) VALUES(?,?,1)
      ON CONFLICT(device_id) DO UPDATE SET window_started_at=excluded.window_started_at,
      request_count=CASE WHEN ? THEN ai_bridge_rate_limits.request_count+1 ELSE 1 END`)
      .run(deviceId, withinWindow ? prior.windowStartedAt : now, withinWindow ? 1 : 0);
    return { remaining: 60 - (withinWindow ? prior.requestCount + 1 : 1) };
  });
}

export function claimAiJob(db, workerId, { now = nowDefault(), leaseMs = 30000 } = {}) {
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(workerId) || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new TypeError('Invalid worker claim');
  return transaction(db, () => {
    const job = db.prepare("SELECT * FROM ai_jobs WHERE status='QUEUED' AND run_after<=? ORDER BY run_after,created_at,id LIMIT 1").get(now);
    if (!job) return null;
    const claimToken = randomUUID(), attempts = job.attempts + 1;
    db.prepare("UPDATE ai_jobs SET status='RUNNING',attempts=?,lease_until=?,worker_id=?,claim_token=?,updated_at=? WHERE id=? AND status='QUEUED'")
      .run(attempts, now + leaseMs, workerId, claimToken, now, job.id);
    audit(db, { action: 'JOB_CLAIMED', noteId: job.note_id, jobId: job.id, actorId: workerId, reasonCode: 'lease_acquired', metadata: { attempt: attempts }, now });
    return { ...job, status: 'RUNNING', attempts, lease_until: now + leaseMs, worker_id: workerId, claim_token: claimToken };
  });
}

export function recoverExpiredAiJobs(db, { now = nowDefault() } = {}) {
  return transaction(db, () => {
    const expired = db.prepare("SELECT * FROM ai_jobs WHERE status='RUNNING' AND lease_until<=? ORDER BY lease_until,id").all(now);
    const recovered = [];
    for (const job of expired) {
      const consent = parseConsent(db.prepare('SELECT * FROM ai_note_consent WHERE note_id=?').get(job.note_id));
      const current = db.prepare("SELECT server_version serverVersion,lifecycle,content_hash contentHash,committed_cursor committedCursor FROM sync_entities WHERE entity_type='note' AND id=?").get(job.note_id);
      if (controlBlock(db, job.note_id) === 'revocation_state_uncertain') {
        db.prepare("UPDATE ai_jobs SET status='CANCELED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=?").run(now, job.id);
        recovered.push({ id: job.id, status: 'CANCELED' });
        continue;
      }
      const valid = serverMeta(db).serverEpoch === job.server_epoch && consent?.consent_epoch === job.consent_epoch && consent.state !== 'REVOKED' && current?.serverVersion === job.target_server_version && current?.committedCursor === job.source_cursor && current?.lifecycle === 'active' && current?.contentHash === job.content_sha256;
      if (!valid) {
        db.prepare("UPDATE ai_jobs SET status='SUPERSEDED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=?").run(now, job.id);
        audit(db, { action: 'JOB_SUPERSEDED', noteId: job.note_id, jobId: job.id, reasonCode: 'expired_lease_stale_source', metadata: {}, now });
        recovered.push({ id: job.id, status: 'SUPERSEDED' });
      } else if (job.attempts >= MAX_ATTEMPTS) {
        db.prepare("UPDATE ai_jobs SET status='FAILED_NEEDS_REVIEW',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=?").run(now, job.id);
        audit(db, { action: 'JOB_FAILED_NEEDS_REVIEW', noteId: job.note_id, jobId: job.id, reasonCode: 'attempt_limit', metadata: { attempts: job.attempts }, now });
        recovered.push({ id: job.id, status: 'FAILED_NEEDS_REVIEW' });
      } else {
        const delay = Math.min(300000, 1000 * (2 ** Math.max(0, job.attempts - 1)));
        db.prepare("UPDATE ai_jobs SET status='QUEUED',run_after=?,lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=?").run(now + delay, now, job.id);
        audit(db, { action: 'JOB_RETRIED', noteId: job.note_id, jobId: job.id, reasonCode: 'lease_expired', metadata: { attempts: job.attempts, delayMs: delay }, now });
        recovered.push({ id: job.id, status: 'QUEUED', runAfter: now + delay });
      }
    }
    return recovered;
  });
}

function textFromDocument(value, output = [], depth = 0) {
  if (depth > 64 || !value || typeof value !== 'object') return output;
  if (Array.isArray(value)) { for (const child of value) textFromDocument(child, output, depth + 1); return output; }
  if (value.type === 'text' && typeof value.text === 'string') output.push(value.text);
  for (const [key, child] of Object.entries(value)) if (key !== 'text') textFromDocument(child, output, depth + 1);
  return output;
}

function assertJsonBounds(value, depth = 0, state = { nodes: 0 }) {
  if (depth > 16 || ++state.nodes > 1000) throw new TypeError('AI output exceeds shape limits');
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_PAYLOAD_BYTES) throw new TypeError('AI output exceeds size limit');
  } else if (Array.isArray(value)) {
    if (value.length > 100) throw new TypeError('AI output array exceeds limit');
    for (const item of value) assertJsonBounds(item, depth + 1, state);
  } else if (value && typeof value === 'object') {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('AI output is not plain JSON');
    for (const [key, child] of Object.entries(value)) {
      if (Buffer.byteLength(key) > 128) throw new TypeError('AI output key exceeds limit');
      assertJsonBounds(child, depth + 1, state);
    }
  } else if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('AI output has invalid number');
  else if (!['string','number','boolean'].includes(typeof value) && value !== null) throw new TypeError('AI output is not JSON');
}

export function extractAiSourceText(note) {
  return [note.title, ...(Array.isArray(note.tags) ? note.tags : []), ...textFromDocument(note.document)].filter(value => typeof value === 'string' && value.length).join('\n');
}

function safeText(value, maxLength, field) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) || /https?:\/\/|www\.|<[^>]*>|!?\[[^\]]*\]\([^)]*\)/iu.test(value)) throw new TypeError(`Invalid ${field}`);
  return value.trim().normalize('NFC');
}

function validateQuote(quote, sourceText) {
  const value = safeText(quote, 240, 'sourceQuote');
  if (!sourceText.includes(value)) throw new TypeError('Unsupported sourceQuote');
  return value;
}

export function validateAiSuggestion(value, note, { authorizedRelatedIds = [] } = {}) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_PAYLOAD_BYTES) throw new TypeError('AI output exceeds size limit');
    try { value = JSON.parse(value); } catch { throw new TypeError('AI output is not valid JSON'); }
  }
  assertJsonBounds(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...OUTPUT_KEYS].sort().join(',')) throw new TypeError('Invalid AI output fields');
  if (value.schemaVersion !== 1 || typeof value.insufficientContext !== 'boolean' || !Number.isFinite(value.uncertainty) || value.uncertainty < 0 || value.uncertainty > 1) throw new TypeError('Invalid AI output metadata');
  const sourceText = extractAiSourceText(note);
  let categorySuggestion = null;
  if (value.categorySuggestion !== null) {
    const item = value.categorySuggestion;
    if (!item || Object.keys(item).sort().join(',') !== 'label,sourceQuote') throw new TypeError('Invalid category suggestion');
    categorySuggestion = { label: safeText(item.label, 80, 'category'), sourceQuote: validateQuote(item.sourceQuote, sourceText) };
  }
  if (!Array.isArray(value.tagCandidates) || value.tagCandidates.length > 20) throw new TypeError('Invalid tag candidates');
  const seenTags = new Set();
  const tagCandidates = value.tagCandidates.map(item => {
    if (!item || Object.keys(item).sort().join(',') !== 'label,sourceQuote') throw new TypeError('Invalid tag candidate');
    const label = normalizeTagLabel(safeText(item.label, 32, 'tag'));
    const key = tagKey(label);
    if (seenTags.has(key)) throw new TypeError('Duplicate tag candidate');
    seenTags.add(key);
    return { label, sourceQuote: validateQuote(item.sourceQuote, sourceText) };
  });
  if (value.shortSummary !== null && typeof value.shortSummary !== 'string') throw new TypeError('Invalid summary');
  const shortSummary = value.shortSummary === null ? null : safeText(value.shortSummary, 280, 'summary');
  if (!Array.isArray(value.taskCandidates) || value.taskCandidates.length > 20) throw new TypeError('Invalid task candidates');
  const taskCandidates = value.taskCandidates.map(item => {
    if (!item || Object.keys(item).sort().join(',') !== 'sourceQuote,text') throw new TypeError('Invalid task candidate');
    return { text: safeText(item.text, 240, 'task'), sourceQuote: validateQuote(item.sourceQuote, sourceText) };
  });
  if (!Array.isArray(value.relatedCandidates) || value.relatedCandidates.length > 20 || !Array.isArray(authorizedRelatedIds)) throw new TypeError('Invalid related-note candidates');
  const authorizedIds = new Set(authorizedRelatedIds);
  const seenRelated = new Set();
  const relatedCandidates = value.relatedCandidates.map(item => {
    if (!item || Object.keys(item).sort().join(',') !== 'id,reason' || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || !authorizedIds.has(item.id) || seenRelated.has(item.id) || !['title_match','tag_overlap'].includes(item.reason)) throw new TypeError('Invalid related-note candidate');
    seenRelated.add(item.id);
    return { id: item.id, reason: item.reason };
  });
  if (value.insufficientContext && (categorySuggestion || tagCandidates.length || shortSummary || taskCandidates.length || relatedCandidates.length)) throw new TypeError('Insufficient context cannot contain proposals');
  const output = { schemaVersion: 1, categorySuggestion, tagCandidates, shortSummary, taskCandidates, relatedCandidates, insufficientContext: value.insufficientContext, uncertainty: value.uncertainty };
  if (Buffer.byteLength(canonicalJson(output)) > MAX_PAYLOAD_BYTES) throw new TypeError('AI output exceeds size limit');
  return output;
}

function controlBlock(db, noteId) {
  return isAiRevocationFailClosed(noteId) ? 'revocation_state_uncertain' : inferenceBlockReason(db, noteId);
}

function currentEligible(db, job, env) {
  const blocked = controlBlock(db, job.note_id);
  if (blocked) return { allowed: false, reason: blocked };
  const meta = serverMeta(db);
  if (meta.serverEpoch !== job.server_epoch) return { allowed: false, reason: 'server_epoch_changed' };
  let source;
  try { source = sourceForNote(db, job.note_id, job.target_server_version); }
  catch { return { allowed: false, reason: 'source_stale' }; }
  if (source.sourceCursor !== job.source_cursor || source.contentHash !== job.content_sha256) return { allowed: false, reason: 'source_stale' };
  const consent = parseConsent(db.prepare('SELECT * FROM ai_note_consent WHERE note_id=?').get(job.note_id));
  const profile = aiExecutionProfile(env);
  const localExecutionAttested = job.execution_boundary === 'STRICT_LOCAL' && profile.localExecutionAttested && profile.modelIdentity === job.model_identity;
  const decision = evaluateAiPolicy({ note: source.note, consent, scope: job.scope, executionBoundary: job.execution_boundary, localExecutionAttested });
  if (!decision.allowed || decision.consentEpoch !== job.consent_epoch) return { allowed: false, reason: decision.allowed ? 'consent_epoch_changed' : decision.reason };
  if (!aiFeatureFlags(env).organizeEnabled || !aiFeatureFlags(env).inferenceEnabled) return { allowed: false, reason: 'feature_disabled' };
  return { allowed: true, note: source.note };
}

function readClock(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid AI worker clock');
  return value;
}

function hasLiveClaim(db, job, workerId, now) {
  return Boolean(db.prepare(`SELECT 1 FROM ai_jobs WHERE id=? AND status='RUNNING' AND worker_id=? AND claim_token=? AND lease_until>?`)
    .get(job.id, workerId, job.claim_token, now));
}

export function createMockProvider({ output, onInvoke = () => {} } = {}) {
  if (!output) throw new TypeError('Mock output is required');
  return Object.freeze({ identity: 'mock-v1', executionBoundary: 'MOCK', async analyze(input) { onInvoke(input); return structuredClone(output); } });
}

/** One manually/event-triggered job at a time. There is deliberately no polling loop. */
/**
 * Only two provider lanes exist: the in-process Mock (tests only) and an attested
 * STRICT_LOCAL gateway backend matching the configured profile. Anything else,
 * including every EXTERNAL_CLOUD provider, is refused before a job is claimed.
 */
function admitProvider(provider, env) {
  if (provider?.executionBoundary === 'MOCK') {
    if (env.NODE_ENV !== 'test') return 'mock_provider_test_only';
    return provider.identity === 'mock-v1' && typeof provider.analyze === 'function' ? null : 'provider_rejected';
  }
  if (provider?.executionBoundary === 'STRICT_LOCAL') {
    const profile = aiExecutionProfile(env);
    return profile.localExecutionAttested && provider.localExecutionAttested === true && provider.identity === profile.modelIdentity && typeof provider.analyze === 'function' ? null : 'local_execution_not_proven';
  }
  return 'provider_rejected';
}

const CANCEL_ON_STOP = new Set(['revocation_state_uncertain', 'consent_changed']);

/** Best-effort cancellation of a job this worker still owns; storage failure leaves lease expiry to recover it. */
function cancelOwnedJob(db, job, workerId, reason, clock) {
  if (!CANCEL_ON_STOP.has(reason)) return 0;
  try {
    return transaction(db, () => {
      const at = readClock(clock);
      const changed = db.prepare("UPDATE ai_jobs SET status='CANCELED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND status='RUNNING' AND worker_id=? AND claim_token=?")
        .run(at, job.id, workerId, job.claim_token).changes;
      if (changed && db.prepare('SELECT count(*) AS n FROM ai_audit_log').get().n < MAX_AUDIT) audit(db, { action: 'JOB_CANCELED', noteId: job.note_id, jobId: job.id, actorId: workerId, reasonCode: reason, metadata: {}, now: at });
      return changed;
    });
  } catch { return 0; }
}

/** Polls the control plane and job/consent rows while a provider call is in flight; aborts on any doubt. */
function watchDispatchedJob(db, job, workerId, clock, stop, intervalMs) {
  const timer = setInterval(() => {
    let reason = null;
    try {
      reason = controlBlock(db, job.note_id);
      if (!reason) {
        const row = db.prepare('SELECT status,worker_id workerId,claim_token claimToken,lease_until leaseUntil FROM ai_jobs WHERE id=?').get(job.id);
        const consent = db.prepare('SELECT state,consent_epoch consentEpoch FROM ai_note_consent WHERE note_id=?').get(job.note_id);
        if (!row || row.status !== 'RUNNING' || row.workerId !== workerId || row.claimToken !== job.claim_token) reason = 'job_no_longer_owned';
        else if (!(row.leaseUntil > readClock(clock))) reason = 'lease_expired_or_lost';
        else if (!consent || consent.state === 'REVOKED' || consent.consentEpoch !== job.consent_epoch) reason = 'consent_changed';
      }
    } catch { reason = 'control_check_failed'; }
    if (reason) stop(reason);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function runOneAiJob(db, { workerId, provider, env = process.env, now = nowDefault(), clock = nowDefault, leaseMs = 30000, timeoutMs = 60000, watchdogMs = 100 } = {}) {
  const flags = aiFeatureFlags(env);
  if (!flags.organizeEnabled || !flags.inferenceEnabled) return { status: 'disabled', invoked: false };
  const admission = admitProvider(provider, env);
  if (admission) return { status: admission, invoked: false };
  let job;
  try { job = claimAiJob(db, workerId, { now, leaseMs }); }
  catch { return { status: 'blocked', reason: 'claim_not_persisted', invoked: false }; }
  if (!job) return { status: 'idle', invoked: false };
  let dispatch;
  try {
    dispatch = transaction(db, () => {
      const eligible = currentEligible(db, job, env);
      const dispatchNow = readClock(clock);
      if (!hasLiveClaim(db, job, workerId, dispatchNow)) return { allowed: false, reason: 'lease_expired_or_lost' };
      if (!eligible.allowed) {
        const changed = db.prepare("UPDATE ai_jobs SET status='CANCELED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND worker_id=? AND claim_token=?")
          .run(dispatchNow, job.id, workerId, job.claim_token).changes;
        if (changed) audit(db, { action: 'JOB_CANCELED', noteId: job.note_id, jobId: job.id, actorId: workerId, reasonCode: eligible.reason, metadata: {}, now: dispatchNow });
        return { allowed: false, reason: eligible.reason };
      }
      // Durable dispatch fence: both the SQLite write and the control-plane heartbeat
      // must commit before any provider call, so a store that cannot persist a
      // revocation cannot dispatch inference either.
      db.prepare('UPDATE ai_jobs SET updated_at=? WHERE id=? AND worker_id=? AND claim_token=?').run(dispatchNow, job.id, workerId, job.claim_token);
      recordWorkerHeartbeat(db, workerId, dispatchNow);
      return { allowed: true, note: eligible.note };
    });
  } catch {
    return { status: 'blocked', reason: 'dispatch_not_persisted', invoked: false };
  }
  if (!dispatch.allowed) return { status: dispatch.reason === 'lease_expired_or_lost' ? 'discarded' : 'canceled', reason: dispatch.reason, invoked: false };
  // Re-read the cross-process control plane after the fence committed and before the call.
  const preInvoke = controlBlock(db, job.note_id);
  if (preInvoke) {
    cancelOwnedJob(db, job, workerId, preInvoke, clock);
    return { status: 'aborted', reason: preInvoke, invoked: false };
  }
  let result;
  const controller = new AbortController();
  let stopReason = null;
  const stop = reason => { if (!stopReason) { stopReason = reason; controller.abort(Object.assign(new Error(reason), { code: reason })); } };
  const stopWatch = watchDispatchedJob(db, job, workerId, clock, stop, watchdogMs);
  const timer = setTimeout(() => stop('provider_timeout'), timeoutMs);
  timer.unref?.();
  try {
    // The provider boundary is checked again immediately before the only allowed adapter call.
    if (provider.identity !== job.model_identity || provider.executionBoundary !== job.execution_boundary) throw new Error('Provider identity or boundary mismatch');
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    aborted.catch(() => {});
    result = await Promise.race([
      provider.analyze(Object.freeze({ note: structuredClone(dispatch.note), sourceVersion: job.target_server_version, contentHash: job.content_sha256 }), { signal: controller.signal }),
      aborted,
    ]);
  } catch (error) {
    if (stopReason && stopReason !== 'provider_timeout') {
      cancelOwnedJob(db, job, workerId, stopReason, clock);
      return { status: 'aborted', reason: stopReason, invoked: true };
    }
    return retryAfterProviderFailure(db, job, workerId, clock, env, { permanent: error?.permanent === true && !stopReason });
  } finally { stopWatch(); clearTimeout(timer); }
  if (stopReason) {
    cancelOwnedJob(db, job, workerId, stopReason, clock);
    return { status: 'aborted', reason: stopReason, invoked: true };
  }
  let validated;
  try {
    const related = serverRelatedCandidates(db, job, dispatch.note);
    if (result && typeof result === 'object' && !Array.isArray(result)) result = { ...result, relatedCandidates: related };
    validated = validateAiSuggestion(result, dispatch.note, { authorizedRelatedIds: related.map(item => item.id) });
  }
  catch {
    return transaction(db, () => {
      const eligible = currentEligible(db, job, env);
      const publishNow = readClock(clock);
      if (!hasLiveClaim(db, job, workerId, publishNow)) return { status: 'discarded', invoked: true, reason: 'lease_expired_or_lost' };
      if (!eligible.allowed) {
        db.prepare("UPDATE ai_jobs SET status='CANCELED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND worker_id=? AND claim_token=?")
          .run(publishNow, job.id, workerId, job.claim_token);
        return { status: 'discarded', invoked: true, reason: eligible.reason };
      }
      const changed = db.prepare("UPDATE ai_jobs SET status='FAILED_NEEDS_REVIEW',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND worker_id=? AND claim_token=?")
        .run(publishNow, job.id, workerId, job.claim_token).changes;
      if (changed) audit(db, { action: 'JOB_FAILED_NEEDS_REVIEW', noteId: job.note_id, jobId: job.id, actorId: workerId, reasonCode: 'invalid_provider_output', metadata: { attempt: job.attempts }, now: publishNow });
      return { status: changed ? 'FAILED_NEEDS_REVIEW' : 'discarded', invoked: true, ...(changed ? { reason: 'invalid_provider_output' } : { reason: 'lease_lost' }) };
    });
  }
  return transaction(db, () => {
    const eligible = currentEligible(db, job, env);
    const publishNow = readClock(clock);
    const owned = hasLiveClaim(db, job, workerId, publishNow);
    if (!eligible.allowed || !owned) {
      if (owned && !eligible.allowed) db.prepare("UPDATE ai_jobs SET status='CANCELED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND worker_id=? AND claim_token=?").run(publishNow, job.id, workerId, job.claim_token);
      return { status: 'discarded', invoked: true, reason: !eligible.allowed ? eligible.reason : 'lease_expired_or_lost' };
    }
    const suggestionId = randomUUID(), payload = canonicalJson(validated);
    db.prepare("INSERT INTO ai_suggestions(id,job_id,note_id,target_server_version,content_sha256,schema_version,status,payload_json,provider_identity,created_at,updated_at) VALUES(?,?,?,?,?,1,'PENDING_REVIEW',?,?,?,?)")
      .run(suggestionId,job.id,job.note_id,job.target_server_version,job.content_sha256,payload,provider.identity,publishNow,publishNow);
    db.prepare("UPDATE ai_jobs SET status='COMPLETED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND worker_id=? AND claim_token=?").run(publishNow, job.id, workerId, job.claim_token);
    audit(db, { action: 'JOB_COMPLETED', noteId: job.note_id, jobId: job.id, actorId: workerId, reasonCode: 'suggestion_created', metadata: { suggestionId, provider: provider.identity, schemaVersion: 1 }, now: publishNow });
    return { status: 'COMPLETED', invoked: true, suggestionId };
  });
}

function retryAfterProviderFailure(db, job, workerId, clock, env, { permanent = false } = {}) {
  return transaction(db, () => {
    const eligible = currentEligible(db, job, env);
    const publishNow = readClock(clock);
    if (!hasLiveClaim(db, job, workerId, publishNow)) return { status: 'discarded', invoked: true, reason: 'lease_expired_or_lost' };
    if (!eligible.allowed) {
      db.prepare("UPDATE ai_jobs SET status='CANCELED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND worker_id=? AND claim_token=?")
        .run(publishNow, job.id, workerId, job.claim_token);
      return { status: 'discarded', invoked: true, reason: eligible.reason };
    }
    if (permanent || job.attempts >= MAX_ATTEMPTS) {
      db.prepare("UPDATE ai_jobs SET status='FAILED_NEEDS_REVIEW',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND worker_id=? AND claim_token=?").run(publishNow, job.id, workerId, job.claim_token);
      audit(db, { action: 'JOB_FAILED_NEEDS_REVIEW', noteId: job.note_id, jobId: job.id, reasonCode: permanent ? 'provider_permanent_error' : 'attempt_limit', metadata: { attempts: job.attempts }, now: publishNow });
      return { status: 'FAILED_NEEDS_REVIEW', invoked: true, ...(permanent ? { reason: 'provider_permanent_error' } : {}) };
    }
    const delay = Math.min(300000, 1000 * (2 ** Math.max(0, job.attempts - 1)));
    db.prepare("UPDATE ai_jobs SET status='QUEUED',run_after=?,lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND worker_id=? AND claim_token=?").run(publishNow + delay, publishNow, job.id, workerId, job.claim_token);
    audit(db, { action: 'JOB_RETRIED', noteId: job.note_id, jobId: job.id, reasonCode: 'provider_timeout_or_error', metadata: { attempts: job.attempts, delayMs: delay }, now: publishNow });
    return { status: 'QUEUED', invoked: true, runAfter: publishNow + delay };
  });
}

/**
 * Related notes are proposed by noteOS, never by the model: only active, eligible notes
 * whose own consent is currently approved for the same boundary can be named, and only
 * their IDs plus a reason code are stored.
 */
function serverRelatedCandidates(db, job, note) {
  const rows = db.prepare(`SELECT e.id,e.record_json recordJson FROM sync_entities e JOIN ai_note_consent c ON c.note_id=e.id
    WHERE e.entity_type='note' AND e.lifecycle='active' AND e.id<>? AND c.state='APPROVED_LOCAL_ONLY' AND c.provider_boundary=? LIMIT 2000`).all(job.note_id, job.execution_boundary);
  const candidates = [];
  for (const row of rows) {
    if (controlBlock(db, row.id)) continue;
    try { const record = JSON.parse(row.recordJson); candidates.push({ id: row.id, title: record.title, tags: record.tags, lifecycle: record.lifecycle, privacy: record.privacy }); } catch { /* skip unreadable rows */ }
  }
  return relatedNoteCandidates({ note, candidates, consentFor: () => true, limit: 5 }).map(({ id, reason }) => ({ id, reason }));
}

export function relatedNoteCandidates({ note, candidates = [], consentFor = () => false, limit = 20 } = {}) {
  if (!note || !Array.isArray(candidates) || !Number.isSafeInteger(limit) || limit < 0 || limit > 20) throw new TypeError('Invalid related-note query');
  const sourceTags = new Set((note.tags ?? []).map(tagKey));
  const normalizedTitle = String(note.title ?? '').normalize('NFC').toLowerCase().trim();
  return candidates.filter(candidate => candidate?.id !== note.id && candidate?.lifecycle === 'active' && ['PRIVATE_SERVER','CLOUD_ALLOWED'].includes(candidate?.privacy) && consentFor(candidate) === true)
    .filter(candidate => typeof candidate.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate.id))
    .map(candidate => {
      const title = String(candidate.title ?? '').normalize('NFC').toLowerCase().trim();
      const overlap = [...new Set((candidate.tags ?? []).map(tagKey))].filter(tag => sourceTags.has(tag)).length;
      return { id: candidate.id, score: (title && title === normalizedTitle ? 100 : 0) + overlap, reason: title === normalizedTitle ? 'title_match' : overlap ? 'tag_overlap' : null };
    }).filter(row => row.reason).sort((a,b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
