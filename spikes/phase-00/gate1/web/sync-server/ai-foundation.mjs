import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertNoteRecord } from '../app/lib/note-validation.mjs';
import { normalizeTagLabel, tagKey } from '../app/lib/note-organization.mjs';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';
import { serverMeta, transaction } from './storage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, 'migrations/001-ai-foundation.sql');
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
const assertNoteId = noteId => {
  if (typeof noteId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(noteId)) throw new TypeError('Invalid note ID');
};

export function aiFeatureFlags(env = process.env) {
  return Object.freeze({
    organizeEnabled: env.NOTEOS_AI_ORGANIZE_ENABLED === '1',
    inferenceEnabled: env.NOTEOS_AI_INFERENCE_ENABLED === '1',
  });
}

/** Apply only when explicitly called by a reviewed migration path. openStore never calls this. */
export function applyAiSchema(db) {
  return transaction(db, () => {
    db.exec(readFileSync(MIGRATION, 'utf8'));
    const versions = db.prepare('SELECT version FROM ai_schema_migrations ORDER BY version').all().map(row => row.version);
    if (!versions.includes(1) || versions.some(version => version > 1)) throw new Error('AI migration ledger requires review');
    return versions.at(-1);
  });
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

export function grantNoteConsent(db, noteId, { state = 'APPROVED_LOCAL_ONLY', scopes = ['organize'], providerBoundary = 'MOCK', actorId = null, env = process.env, now = nowDefault() } = {}) {
  if (!aiFeatureFlags(env).organizeEnabled) throw new Error('AI organize is disabled');
  assertNoteId(noteId);
  if (!['APPROVED_LOCAL_ONLY','APPROVED_CLOUD_ALLOWED'].includes(state) || !['MOCK','STRICT_LOCAL','EXTERNAL_CLOUD'].includes(providerBoundary)) throw new TypeError('Invalid AI consent');
  const normalizedScopes = boundedScopes(scopes), scopesJson = canonicalJson(normalizedScopes);
  return transaction(db, () => {
    const noteRow = db.prepare("SELECT record_json recordJson,lifecycle FROM sync_entities WHERE entity_type='note' AND id=?").get(noteId);
    if (!noteRow || noteRow.lifecycle !== 'active' || JSON.parse(noteRow.recordJson).lifecycle !== 'active') throw new Error('Consent requires an existing active synced note');
    const previous = db.prepare('SELECT consent_epoch FROM ai_note_consent WHERE note_id=?').get(noteId);
    if (!previous && db.prepare('SELECT count(*) AS n FROM ai_note_consent').get().n >= MAX_CONSENT_ROWS) throw new Error('AI consent capacity reached');
    const consentEpoch = (previous?.consent_epoch ?? 0) + 1;
    db.prepare(`INSERT INTO ai_note_consent(note_id,state,scopes_json,provider_boundary,consent_epoch,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET state=excluded.state,scopes_json=excluded.scopes_json,
      provider_boundary=excluded.provider_boundary,consent_epoch=excluded.consent_epoch,updated_at=excluded.updated_at`)
      .run(noteId, state, scopesJson, providerBoundary, consentEpoch, now);
    audit(db, { action: 'CONSENT_GRANTED', noteId, actorId, reasonCode: 'explicit_grant', metadata: { state, scopes: normalizedScopes, providerBoundary, consentEpoch }, now });
    return { noteId, state, scopes: normalizedScopes, providerBoundary, consentEpoch };
  });
}

export function revokeNoteConsent(db, noteId, { actorId = null, reasonCode = 'owner_revoked', now = nowDefault() } = {}) {
  assertNoteId(noteId);
  return transaction(db, () => {
    const current = db.prepare('SELECT * FROM ai_note_consent WHERE note_id=?').get(noteId);
    if (!current && db.prepare('SELECT count(*) AS n FROM ai_note_consent').get().n >= MAX_CONSENT_ROWS) throw new Error('AI consent capacity reached');
    const consentEpoch = (current?.consent_epoch ?? 0) + 1;
    db.prepare(`INSERT INTO ai_note_consent(note_id,state,scopes_json,provider_boundary,consent_epoch,updated_at)
      VALUES(?,'REVOKED','[]','MOCK',?,?) ON CONFLICT(note_id) DO UPDATE SET state='REVOKED',scopes_json='[]',
      consent_epoch=excluded.consent_epoch,updated_at=excluded.updated_at`).run(noteId, consentEpoch, now);
    db.prepare(`UPDATE ai_jobs SET status='CANCELED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=?
      WHERE note_id=? AND status IN ('QUEUED','RUNNING')`).run(now, noteId);
    db.prepare("UPDATE ai_suggestions SET status='REVOKED',updated_at=? WHERE note_id=? AND status='PENDING_REVIEW'").run(now, noteId);
    audit(db, { action: 'CONSENT_REVOKED', noteId, actorId, reasonCode, metadata: { consentEpoch }, now });
    audit(db, { action: 'SUGGESTION_REVOKED', noteId, reasonCode: 'consent_revoked', metadata: { consentEpoch }, now });
    return { noteId, state: 'REVOKED', consentEpoch };
  });
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

export function enqueueAiJob(db, noteId, { serverVersion, env = process.env, analysisPolicyVersion = 'ai-policy-v1', promptSchemaVersion = 1, modelIdentity = 'mock-v1', scope = 'organize', now = nowDefault() } = {}) {
  assertNoteId(noteId);
  const flags = aiFeatureFlags(env);
  if (!flags.organizeEnabled) throw new Error('AI organize is disabled');
  if (!Number.isSafeInteger(serverVersion) || serverVersion < 1) throw new TypeError('A committed server version is required');
  return transaction(db, () => {
    const source = sourceForNote(db, noteId, serverVersion);
    const consent = parseConsent(db.prepare('SELECT * FROM ai_note_consent WHERE note_id=?').get(noteId));
    const policy = evaluateAiPolicy({ note: source.note, consent, scope, executionBoundary: 'MOCK' });
    if (!policy.allowed) throw Object.assign(new Error('AI policy rejected request'), { reason: policy.reason });
    const meta = serverMeta(db);
    const dedupeKey = sha256(canonicalJson({ noteId, serverEpoch: meta.serverEpoch, serverVersion, sourceCursor: source.sourceCursor, contentHash: source.contentHash, consentEpoch: policy.consentEpoch, scope, analysisPolicyVersion, promptSchemaVersion, modelIdentity, executionBoundary: 'MOCK' }));
    const prior = db.prepare('SELECT id,status FROM ai_jobs WHERE dedupe_key=?').get(dedupeKey);
    if (prior) return { id: prior.id, status: prior.status, reused: true };
    if (db.prepare("SELECT count(*) AS n FROM ai_jobs WHERE status IN ('QUEUED','RUNNING')").get().n >= MAX_QUEUE) throw new Error('AI queue capacity reached');
    if (db.prepare('SELECT count(*) AS n FROM ai_jobs').get().n >= MAX_JOB_ROWS) throw new Error('AI job retention capacity reached; owner review required');
    db.prepare("UPDATE ai_jobs SET status='SUPERSEDED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE note_id=? AND target_server_version<? AND status IN ('QUEUED','RUNNING')").run(now, noteId, serverVersion);
    const id = randomUUID();
    db.prepare(`INSERT INTO ai_jobs(id,note_id,server_epoch,source_cursor,target_server_version,content_sha256,consent_epoch,
      analysis_policy_version,prompt_schema_version,model_identity,execution_boundary,dedupe_key,scope,status,attempts,run_after,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'QUEUED',0,?,?,?)`).run(id,noteId,meta.serverEpoch,source.sourceCursor,serverVersion,source.contentHash,policy.consentEpoch,analysisPolicyVersion,promptSchemaVersion,modelIdentity,'MOCK',dedupeKey,scope,now,now,now);
    audit(db, { action: 'JOB_ENQUEUED', noteId, jobId: id, reasonCode: 'explicit_request', metadata: { serverVersion, sourceCursor: source.sourceCursor, contentHash: source.contentHash, consentEpoch: policy.consentEpoch, analysisPolicyVersion, promptSchemaVersion, modelIdentity }, now });
    return { id, status: 'QUEUED', reused: false };
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

function currentEligible(db, job, env) {
  const meta = serverMeta(db);
  if (meta.serverEpoch !== job.server_epoch) return { allowed: false, reason: 'server_epoch_changed' };
  let source;
  try { source = sourceForNote(db, job.note_id, job.target_server_version); }
  catch { return { allowed: false, reason: 'source_stale' }; }
  if (source.sourceCursor !== job.source_cursor || source.contentHash !== job.content_sha256) return { allowed: false, reason: 'source_stale' };
  const consent = parseConsent(db.prepare('SELECT * FROM ai_note_consent WHERE note_id=?').get(job.note_id));
  const decision = evaluateAiPolicy({ note: source.note, consent, scope: job.scope, executionBoundary: job.execution_boundary });
  if (!decision.allowed || decision.consentEpoch !== job.consent_epoch) return { allowed: false, reason: decision.allowed ? 'consent_epoch_changed' : decision.reason };
  if (!aiFeatureFlags(env).organizeEnabled || !aiFeatureFlags(env).inferenceEnabled) return { allowed: false, reason: 'feature_disabled' };
  return { allowed: true, note: source.note };
}

export function createMockProvider({ output, onInvoke = () => {} } = {}) {
  if (!output) throw new TypeError('Mock output is required');
  return Object.freeze({ identity: 'mock-v1', executionBoundary: 'MOCK', async analyze(input) { onInvoke(input); return structuredClone(output); } });
}

/** One manually/event-triggered job at a time. There is deliberately no polling loop. */
export async function runOneAiJob(db, { workerId, provider, env = process.env, now = nowDefault(), leaseMs = 30000 } = {}) {
  const flags = aiFeatureFlags(env);
  if (!flags.organizeEnabled || !flags.inferenceEnabled) return { status: 'disabled', invoked: false };
  if (env.NODE_ENV !== 'test') return { status: 'mock_provider_test_only', invoked: false };
  if (!provider || provider.identity !== 'mock-v1' || provider.executionBoundary !== 'MOCK' || typeof provider.analyze !== 'function') return { status: 'provider_rejected', invoked: false };
  const job = claimAiJob(db, workerId, { now, leaseMs });
  if (!job) return { status: 'idle', invoked: false };
  const before = currentEligible(db, job, env);
  if (!before.allowed) {
    transaction(db, () => {
      const changed = db.prepare("UPDATE ai_jobs SET status='CANCELED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND claim_token=?").run(now, job.id, job.claim_token).changes;
      if (changed) audit(db, { action: 'JOB_CANCELED', noteId: job.note_id, jobId: job.id, actorId: workerId, reasonCode: before.reason, metadata: {}, now });
    });
    return { status: 'canceled', reason: before.reason, invoked: false };
  }
  let result;
  try {
    // The provider boundary is checked again immediately before the only allowed adapter call.
    if (provider.identity !== job.model_identity || provider.executionBoundary !== job.execution_boundary) throw new Error('Provider identity or boundary mismatch');
    result = await provider.analyze(Object.freeze({ note: structuredClone(before.note), sourceVersion: job.target_server_version, contentHash: job.content_sha256 }));
  } catch {
    return retryAfterProviderFailure(db, job, now);
  }
  let validated;
  try { validated = validateAiSuggestion(result, before.note); }
  catch {
    transaction(db, () => {
      const changed = db.prepare("UPDATE ai_jobs SET status='FAILED_NEEDS_REVIEW',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND claim_token=?").run(now, job.id, job.claim_token).changes;
      if (changed) audit(db, { action: 'JOB_FAILED_NEEDS_REVIEW', noteId: job.note_id, jobId: job.id, actorId: workerId, reasonCode: 'invalid_provider_output', metadata: { attempt: job.attempts }, now });
    });
    return { status: 'FAILED_NEEDS_REVIEW', invoked: true, reason: 'invalid_provider_output' };
  }
  return transaction(db, () => {
    const eligible = currentEligible(db, job, env);
    const owned = db.prepare("SELECT 1 FROM ai_jobs WHERE id=? AND status='RUNNING' AND claim_token=? AND lease_until>?").get(job.id, job.claim_token, now);
    if (!eligible.allowed || !owned) {
      if (owned) db.prepare("UPDATE ai_jobs SET status='CANCELED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND claim_token=?").run(now, job.id, job.claim_token);
      return { status: 'discarded', invoked: true, reason: eligible.allowed ? 'lease_lost' : eligible.reason };
    }
    const suggestionId = randomUUID(), payload = canonicalJson(validated);
    db.prepare("INSERT INTO ai_suggestions(id,job_id,note_id,target_server_version,content_sha256,schema_version,status,payload_json,provider_identity,created_at,updated_at) VALUES(?,?,?,?,?,1,'PENDING_REVIEW',?,?,?,?)")
      .run(suggestionId,job.id,job.note_id,job.target_server_version,job.content_sha256,payload,provider.identity,now,now);
    db.prepare("UPDATE ai_jobs SET status='COMPLETED',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=? AND claim_token=?").run(now, job.id, job.claim_token);
    audit(db, { action: 'JOB_COMPLETED', noteId: job.note_id, jobId: job.id, actorId: workerId, reasonCode: 'suggestion_created', metadata: { suggestionId, provider: 'mock-v1', schemaVersion: 1 }, now });
    return { status: 'COMPLETED', invoked: true, suggestionId };
  });
}

function retryAfterProviderFailure(db, job, now) {
  return transaction(db, () => {
    const owned = db.prepare("SELECT 1 FROM ai_jobs WHERE id=? AND status='RUNNING' AND claim_token=?").get(job.id, job.claim_token);
    if (!owned) return { status: 'discarded', invoked: true, reason: 'lease_lost' };
    if (job.attempts >= MAX_ATTEMPTS) {
      db.prepare("UPDATE ai_jobs SET status='FAILED_NEEDS_REVIEW',lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=?").run(now, job.id);
      audit(db, { action: 'JOB_FAILED_NEEDS_REVIEW', noteId: job.note_id, jobId: job.id, reasonCode: 'attempt_limit', metadata: { attempts: job.attempts }, now });
      return { status: 'FAILED_NEEDS_REVIEW', invoked: true };
    }
    const delay = Math.min(300000, 1000 * (2 ** Math.max(0, job.attempts - 1)));
    db.prepare("UPDATE ai_jobs SET status='QUEUED',run_after=?,lease_until=NULL,worker_id=NULL,claim_token=NULL,updated_at=? WHERE id=?").run(now + delay, now, job.id);
    audit(db, { action: 'JOB_RETRIED', noteId: job.note_id, jobId: job.id, reasonCode: 'provider_timeout_or_error', metadata: { attempts: job.attempts, delayMs: delay }, now });
    return { status: 'QUEUED', invoked: true, runAfter: now + delay };
  });
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
