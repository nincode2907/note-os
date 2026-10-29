import { createHash } from 'node:crypto';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';
import { transaction } from './storage.mjs';

// Suggestions Inbox server contract. The server records owner decisions per item; it never
// edits a note. The client applies approved items through its SaveCoordinator and ordinary
// Sync, then records the decision with the resulting local revision.
const DECISIONS = new Set(['APPROVED', 'EDITED', 'REJECTED', 'DEFERRED', 'UNDONE']);
const MAX_DECISION_ROWS = 20000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const failure = (code, status = 409, extra = {}) => Object.assign(new Error(code), { code, status, ...extra });

/** Allowed transitions: an applied item can only be undone; anything else can be (re)decided. */
const TRANSITIONS = {
  NONE: ['APPROVED', 'EDITED', 'REJECTED', 'DEFERRED'],
  DEFERRED: ['APPROVED', 'EDITED', 'REJECTED', 'DEFERRED'],
  UNDONE: ['APPROVED', 'EDITED', 'REJECTED', 'DEFERRED'],
  APPROVED: ['UNDONE'],
  EDITED: ['UNDONE'],
  REJECTED: ['UNDONE'],
};

export function suggestionItemKeys(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const keys = [];
  if (payload.categorySuggestion) keys.push('category');
  if (payload.shortSummary) keys.push('summary');
  (payload.tagCandidates ?? []).forEach((_, index) => keys.push(`tag:${index}`));
  (payload.taskCandidates ?? []).forEach((_, index) => keys.push(`task:${index}`));
  (payload.relatedCandidates ?? []).forEach((_, index) => keys.push(`related:${index}`));
  return keys;
}

function itemStates(db, suggestionId) {
  return Object.fromEntries(db.prepare('SELECT item_key itemKey,decision,version,applied_local_revision appliedLocalRevision,actor_device_id actorDeviceId,updated_at updatedAt FROM ai_suggestion_item_state WHERE suggestion_id=?')
    .all(suggestionId).map(row => [row.itemKey, { decision: row.decision, version: row.version, appliedLocalRevision: row.appliedLocalRevision, actorDeviceId: row.actorDeviceId, updatedAt: row.updatedAt }]));
}

function liveVersion(db, noteId) {
  return db.prepare("SELECT server_version v,content_hash h,lifecycle FROM sync_entities WHERE entity_type='note' AND id=?").get(noteId) ?? null;
}

/** Metadata-only inbox across notes; payload text is only returned per note. */
export function listSuggestionInbox(db, { limit = 100 } = {}) {
  const rows = db.prepare(`SELECT s.id,s.note_id noteId,s.status,s.target_server_version targetServerVersion,s.provider_identity providerIdentity,s.created_at createdAt,s.payload_json payloadJson
    FROM ai_suggestions s JOIN ai_note_consent c ON c.note_id=s.note_id
    WHERE s.status='PENDING_REVIEW' AND c.state<>'REVOKED' ORDER BY s.created_at DESC,s.id LIMIT ?`).all(Math.min(Math.max(limit, 1), 200));
  return rows.map(row => {
    const keys = suggestionItemKeys(JSON.parse(row.payloadJson)), states = itemStates(db, row.id), live = liveVersion(db, row.noteId);
    return {
      id: row.id, noteId: row.noteId, status: row.status, providerIdentity: row.providerIdentity, createdAt: row.createdAt,
      targetServerVersion: row.targetServerVersion, currentServerVersion: live?.v ?? null, revisionChanged: live?.v !== row.targetServerVersion,
      itemCount: keys.length, pendingCount: keys.filter(key => !states[key] || ['DEFERRED', 'UNDONE'].includes(states[key].decision)).length,
    };
  });
}

export function listNoteSuggestions(db, noteId, { limit = 5 } = {}) {
  const consent = db.prepare('SELECT state FROM ai_note_consent WHERE note_id=?').get(noteId);
  if (!consent || consent.state === 'REVOKED') return [];
  const live = liveVersion(db, noteId);
  return db.prepare(`SELECT id,status,target_server_version targetServerVersion,content_sha256 contentHash,provider_identity providerIdentity,payload_json payloadJson,created_at createdAt,updated_at updatedAt
    FROM ai_suggestions WHERE note_id=? AND status IN ('PENDING_REVIEW','ACCEPTED','REJECTED') AND payload_json<>'{}' ORDER BY created_at DESC,id LIMIT ?`).all(noteId, limit)
    .map(row => ({
      id: row.id, noteId, status: row.status, providerIdentity: row.providerIdentity, createdAt: row.createdAt, updatedAt: row.updatedAt,
      targetServerVersion: row.targetServerVersion, contentHash: row.contentHash, currentServerVersion: live?.v ?? null,
      revisionChanged: !live || live.v !== row.targetServerVersion || live.h !== row.contentHash,
      payload: JSON.parse(row.payloadJson), items: itemStates(db, row.id),
    }));
}

export function validateDecisionEnvelope(body) {
  const keys = ['appliedLocalRevision', 'decision', 'expectedVersion', 'itemKey', 'protocolVersion', 'requestId'];
  return Boolean(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).sort().join(',') === keys.join(',') &&
    body.protocolVersion === 1 && UUID.test(body.requestId ?? '') && typeof body.itemKey === 'string' && /^(category|summary|(tag|task|related):\d{1,2})$/.test(body.itemKey) &&
    DECISIONS.has(body.decision) && Number.isSafeInteger(body.expectedVersion) && body.expectedVersion >= 0 &&
    (body.appliedLocalRevision === null || (Number.isSafeInteger(body.appliedLocalRevision) && body.appliedLocalRevision >= 0)));
}

/**
 * Record one owner decision with item-level compare-and-set. A second device acting on the
 * same item version receives DECISION_CONFLICT with the current state instead of a duplicate.
 */
export function decideSuggestionItem(db, suggestionId, body, { actorDeviceId, now = Date.now() } = {}) {
  if (!UUID.test(suggestionId ?? '') || !validateDecisionEnvelope(body) || typeof actorDeviceId !== 'string') throw new TypeError('Invalid suggestion decision');
  const requestHash = sha256(canonicalJson({ ...body, suggestionId, actorDeviceId }));
  return transaction(db, () => {
    const prior = db.prepare('SELECT request_hash requestHash,actor_device_id actorDeviceId,result_json resultJson FROM ai_suggestion_decisions WHERE request_id=?').get(body.requestId);
    if (prior) {
      if (prior.requestHash !== requestHash || prior.actorDeviceId !== actorDeviceId) throw failure('IDEMPOTENCY_CONFLICT');
      return { ...JSON.parse(prior.resultJson), replayed: true };
    }
    const suggestion = db.prepare('SELECT id,note_id noteId,status,payload_json payloadJson FROM ai_suggestions WHERE id=?').get(suggestionId);
    if (!suggestion) throw failure('SUGGESTION_NOT_FOUND', 404);
    const consent = db.prepare('SELECT state FROM ai_note_consent WHERE note_id=?').get(suggestion.noteId);
    if (suggestion.status === 'REVOKED' || suggestion.payloadJson === '{}' || !consent || consent.state === 'REVOKED') throw failure('SUGGESTION_REVOKED', 410);
    const keys = suggestionItemKeys(JSON.parse(suggestion.payloadJson));
    if (!keys.includes(body.itemKey)) throw failure('ITEM_NOT_FOUND', 404);
    const current = db.prepare('SELECT decision,version FROM ai_suggestion_item_state WHERE suggestion_id=? AND item_key=?').get(suggestionId, body.itemKey);
    const currentDecision = current?.decision ?? 'NONE', currentVersion = current?.version ?? 0;
    if (currentVersion !== body.expectedVersion) throw failure('DECISION_CONFLICT', 409, { current: { decision: currentDecision, version: currentVersion } });
    if (!TRANSITIONS[currentDecision].includes(body.decision)) throw failure('DECISION_NOT_ALLOWED', 409, { current: { decision: currentDecision, version: currentVersion } });
    if (['APPROVED', 'EDITED'].includes(body.decision) && body.appliedLocalRevision === null) throw new TypeError('An applied decision requires the resulting local revision');
    if (db.prepare('SELECT count(*) n FROM ai_suggestion_decisions').get().n >= MAX_DECISION_ROWS) throw failure('DECISION_CAPACITY_REACHED', 507);
    const version = currentVersion + 1;
    db.prepare(`INSERT INTO ai_suggestion_item_state(suggestion_id,item_key,decision,version,applied_local_revision,actor_device_id,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(suggestion_id,item_key) DO UPDATE SET decision=excluded.decision,version=excluded.version,applied_local_revision=excluded.applied_local_revision,actor_device_id=excluded.actor_device_id,updated_at=excluded.updated_at`)
      .run(suggestionId, body.itemKey, body.decision, version, body.appliedLocalRevision, actorDeviceId, now);
    const states = itemStates(db, suggestionId), decided = keys.map(key => states[key]?.decision);
    const status = decided.every(value => ['APPROVED', 'EDITED', 'REJECTED'].includes(value))
      ? (decided.some(value => value === 'APPROVED' || value === 'EDITED') ? 'ACCEPTED' : 'REJECTED') : 'PENDING_REVIEW';
    db.prepare('UPDATE ai_suggestions SET status=?,updated_at=? WHERE id=? AND status<>?').run(status, now, suggestionId, 'REVOKED');
    const result = { suggestionId, itemKey: body.itemKey, decision: body.decision, version, suggestionStatus: status };
    db.prepare(`INSERT INTO ai_suggestion_decisions(request_id,request_hash,suggestion_id,note_id,item_key,decision,prior_decision,item_version,applied_local_revision,actor_device_id,result_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(body.requestId, requestHash, suggestionId, suggestion.noteId, body.itemKey, body.decision, current?.decision ?? null, version, body.appliedLocalRevision, actorDeviceId, canonicalJson(result), now);
    return result;
  });
}
