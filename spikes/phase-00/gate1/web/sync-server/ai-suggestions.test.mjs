import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, serverMeta, transaction, appendChange } from './storage.mjs';
import { issuePairingCode, redeemPairingCode } from './auth.mjs';
import { applyAiSchema, createMockProvider, enqueueAiJob, grantNoteConsent, revokeNoteConsent, runOneAiJob } from './ai-foundation.mjs';
import { decideSuggestionItem, listNoteSuggestions, listSuggestionInbox } from './ai-suggestions.mjs';
import { handleAi } from './ai-http.mjs';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';

const origin = 'http://127.0.0.1:15700';
const env = { NODE_ENV: 'test', NOTEOS_AI_ORGANIZE_ENABLED: '1', NOTEOS_AI_INFERENCE_ENABLED: '1', NOTEOS_SYNC_ENABLED: '1', NOTEOS_SYNC_ALLOWED_ORIGINS: origin };
let sequence = 0;
const note = (id, title, tags = ['Launch'], privacy = 'PRIVATE_SERVER') => ({
  id, title, document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Review the Q3 launch plan with the design team.' }] }] },
  schemaVersion: 1, createdAt: 1, updatedAt: 2, lifecycle: 'active', revision: 1, privacy, tags,
});
const output = {
  schemaVersion: 1, categorySuggestion: { label: 'Work', sourceQuote: 'launch plan' }, tagCandidates: [{ label: 'Design', sourceQuote: 'design team' }],
  shortSummary: 'Synthetic launch review summary.', taskCandidates: [{ text: 'Review the launch plan', sourceQuote: 'Review the Q3 launch plan' }], relatedCandidates: [], insufficientContext: false, uncertainty: 0.2,
};

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'noteos-ai-inbox-'));
  const db = openStore(root, { initialize: true }); applyAiSchema(db);
  writeFileSync(join(root, '.sync-epoch'), serverMeta(db).serverEpoch, { mode: 0o600 });
  const commit = (record, version = 1) => transaction(db, () => {
    const json = canonicalJson(record), content = { ...record }; delete content.revision; delete content.createdAt; delete content.updatedAt;
    const hash = createHash('sha256').update(canonicalJson(content)).digest('hex');
    const cursor = appendChange(db, 'note', record.id, version, 'upsert', json);
    if (version === 1) db.prepare("INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES('note',?,1,?,?,?,0,?)").run(record.id, json, hash, record.lifecycle, cursor);
    else db.prepare("UPDATE sync_entities SET server_version=?,record_json=?,content_hash=?,lifecycle=?,committed_cursor=? WHERE entity_type='note' AND id=?").run(version, json, hash, record.lifecycle, cursor, record.id);
  });
  const pair = label => redeemPairingCode(db, issuePairingCode(db), label);
  t.after(() => { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, db, commit, pair, env: { ...env, NOTEOS_SYNC_STORAGE: root } };
}

async function publish(db, target) {
  grantNoteConsent(db, target.id, { state: 'APPROVED_LOCAL_ONLY', providerBoundary: 'MOCK', env });
  enqueueAiJob(db, target.id, { serverVersion: 1, env });
  const result = await runOneAiJob(db, { workerId: 'inbox-worker', provider: createMockProvider({ output }), env });
  assert.equal(result.status, 'COMPLETED');
  return db.prepare('SELECT id FROM ai_suggestions WHERE note_id=?').get(target.id).id;
}

const decision = (itemKey, decisionName, expectedVersion, appliedLocalRevision = null) => ({ protocolVersion: 1, requestId: crypto.randomUUID(), itemKey, decision: decisionName, expectedVersion, appliedLocalRevision });

test('related notes are proposed by the server only from notes with current consent at the same boundary', async t => {
  const host = setup(t);
  const source = note(`src-${++sequence}`, 'Launch plan'), consented = note(`ok-${sequence}`, 'Launch plan'), revoked = note(`rev-${sequence}`, 'Launch plan'), unconsented = note(`no-${sequence}`, 'Launch plan'), deviceOnly = note(`dev-${sequence}`, 'Launch plan', ['Launch'], 'DEVICE_ONLY');
  for (const record of [source, consented, revoked, unconsented, deviceOnly]) host.commit(record);
  grantNoteConsent(host.db, consented.id, { state: 'APPROVED_LOCAL_ONLY', providerBoundary: 'MOCK', env });
  grantNoteConsent(host.db, revoked.id, { state: 'APPROVED_LOCAL_ONLY', providerBoundary: 'MOCK', env }); revokeNoteConsent(host.db, revoked.id);
  const id = await publish(host.db, source);
  const payload = JSON.parse(host.db.prepare('SELECT payload_json p FROM ai_suggestions WHERE id=?').get(id).p);
  assert.deepEqual(payload.relatedCandidates, [{ id: consented.id, reason: 'title_match' }]);
});

test('inbox listing is metadata only; note listing carries payload and per-item state; revocation hides both', async t => {
  const host = setup(t), target = note(`inbox-${++sequence}`, 'Inbox'); host.commit(target);
  const id = await publish(host.db, target);
  const inbox = listSuggestionInbox(host.db);
  assert.equal(inbox.length, 1); assert.equal(inbox[0].itemCount, 4); assert.equal(inbox[0].pendingCount, 4);
  assert.equal(JSON.stringify(inbox).includes('Synthetic launch review summary'), false);
  const [detail] = listNoteSuggestions(host.db, target.id);
  assert.equal(detail.id, id); assert.equal(detail.payload.shortSummary, 'Synthetic launch review summary.'); assert.deepEqual(detail.items, {}); assert.equal(detail.revisionChanged, false);
  host.commit({ ...target, title: 'Inbox changed', revision: 2 }, 2);
  assert.equal(listNoteSuggestions(host.db, target.id)[0].revisionChanged, true);
  assert.equal(listSuggestionInbox(host.db)[0].revisionChanged, true);
  revokeNoteConsent(host.db, target.id);
  assert.deepEqual(listSuggestionInbox(host.db), []);
  assert.deepEqual(listNoteSuggestions(host.db, target.id), []);
});

test('item decisions use compare-and-set: a second device cannot approve the same item version twice', async t => {
  const host = setup(t), target = note(`cas-${++sequence}`, 'CAS'); host.commit(target);
  const phone = host.pair('phone'), mac = host.pair('mac');
  const id = await publish(host.db, target);
  const first = decideSuggestionItem(host.db, id, decision('tag:0', 'APPROVED', 0, 2), { actorDeviceId: mac.id });
  assert.deepEqual({ decision: first.decision, version: first.version, status: first.suggestionStatus }, { decision: 'APPROVED', version: 1, status: 'PENDING_REVIEW' });
  assert.throws(() => decideSuggestionItem(host.db, id, decision('tag:0', 'APPROVED', 0, 5), { actorDeviceId: phone.id }), error => error.code === 'DECISION_CONFLICT' && error.current.decision === 'APPROVED' && error.current.version === 1);
  assert.throws(() => decideSuggestionItem(host.db, id, decision('tag:0', 'REJECTED', 1), { actorDeviceId: phone.id }), error => error.code === 'DECISION_NOT_ALLOWED');
  assert.equal(decideSuggestionItem(host.db, id, decision('tag:0', 'UNDONE', 1), { actorDeviceId: phone.id }).version, 2);
  assert.throws(() => decideSuggestionItem(host.db, id, decision('tag:0', 'APPROVED', 2, null), { actorDeviceId: phone.id }), TypeError, 'an applied decision must name the resulting local revision');
  assert.equal(decideSuggestionItem(host.db, id, decision('tag:0', 'EDITED', 2, 4), { actorDeviceId: phone.id }).decision, 'EDITED');
  assert.throws(() => decideSuggestionItem(host.db, id, decision('task:7', 'REJECTED', 0), { actorDeviceId: mac.id }), error => error.code === 'ITEM_NOT_FOUND');
});

test('decisions are idempotent by request ID and the suggestion status rolls up from item states', async t => {
  const host = setup(t), target = note(`roll-${++sequence}`, 'Rollup'); host.commit(target);
  const mac = host.pair('mac');
  const id = await publish(host.db, target);
  const approve = decision('category', 'APPROVED', 0, 2);
  decideSuggestionItem(host.db, id, approve, { actorDeviceId: mac.id });
  assert.equal(decideSuggestionItem(host.db, id, approve, { actorDeviceId: mac.id }).replayed, true);
  assert.throws(() => decideSuggestionItem(host.db, id, { ...approve, decision: 'REJECTED', appliedLocalRevision: null }, { actorDeviceId: mac.id }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  decideSuggestionItem(host.db, id, decision('summary', 'DEFERRED', 0), { actorDeviceId: mac.id });
  for (const key of ['tag:0', 'task:0']) decideSuggestionItem(host.db, id, decision(key, 'REJECTED', 0), { actorDeviceId: mac.id });
  assert.equal(host.db.prepare('SELECT status FROM ai_suggestions WHERE id=?').get(id).status, 'PENDING_REVIEW', 'a deferred item keeps the suggestion open');
  const final = decideSuggestionItem(host.db, id, decision('summary', 'REJECTED', 1), { actorDeviceId: mac.id });
  assert.equal(final.suggestionStatus, 'ACCEPTED');
  assert.equal(decideSuggestionItem(host.db, id, decision('category', 'UNDONE', 1), { actorDeviceId: mac.id }).suggestionStatus, 'PENDING_REVIEW');
});

test('revocation purges text and blocks decisions; the decision log keeps keys and states only', async t => {
  const host = setup(t), target = note(`purge-${++sequence}`, 'Purge'); host.commit(target);
  const mac = host.pair('mac');
  const id = await publish(host.db, target);
  decideSuggestionItem(host.db, id, decision('summary', 'APPROVED', 0, 2), { actorDeviceId: mac.id });
  revokeNoteConsent(host.db, target.id);
  assert.throws(() => decideSuggestionItem(host.db, id, decision('tag:0', 'APPROVED', 0, 3), { actorDeviceId: mac.id }), error => error.code === 'SUGGESTION_REVOKED');
  const stored = JSON.stringify([host.db.prepare('SELECT * FROM ai_suggestion_decisions').all(), host.db.prepare('SELECT * FROM ai_suggestion_item_state').all(), host.db.prepare('SELECT payload_json FROM ai_suggestions').all()]);
  for (const text of ['Synthetic launch review summary', 'design team', 'Design', 'Review the launch plan']) assert.equal(stored.includes(text), false, text);
});

test('HTTP inbox routes require the paired AI session and validate decision envelopes', async t => {
  const host = setup(t), target = note(`http-${++sequence}`, 'HTTP inbox'); host.commit(target);
  const device = host.pair('browser');
  const id = await publish(host.db, target);
  const call = (path, { method = 'GET', body, token = device.token } = {}) => {
    const headers = new Headers({ host: '127.0.0.1:15700', origin, 'sec-fetch-site': 'same-origin' });
    if (token) headers.set('cookie', `noteos_ai_local=${token}`);
    if (body !== undefined) { headers.set('content-type', 'application/json'); headers.set('x-noteos-ai', '1'); }
    return handleAi(new Request(`${origin}/api/v1/ai/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path, host.env);
  };
  assert.equal((await call('suggestions', { token: null })).status, 401);
  const inbox = await (await call('suggestions')).json();
  assert.equal(inbox.suggestions[0].id, id);
  const detail = await (await call(`suggestions/notes/${target.id}`)).json();
  assert.equal(detail.suggestions[0].payload.categorySuggestion.label, 'Work');
  assert.equal((await call(`suggestions/${id}/decisions`, { method: 'POST', body: { ...decision('tag:0', 'APPROVED', 0, 2), extra: 1 } })).status, 400);
  const ok = await call(`suggestions/${id}/decisions`, { method: 'POST', body: decision('tag:0', 'APPROVED', 0, 2) });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).version, 1);
  const conflict = await call(`suggestions/${id}/decisions`, { method: 'POST', body: decision('tag:0', 'APPROVED', 0, 3) });
  assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { error: 'DECISION_CONFLICT', current: { decision: 'APPROVED', version: 1 } });
  assert.equal((await call(`suggestions/${id}/decisions`, { method: 'GET' })).status, 405);
});

test('09F: meaning-based related notes come only from currently consented notes and disappear after revocation', async t => {
  const host = setup(t);
  const { SYNTHETIC_NOTES, syntheticNoteRecord } = await import('./ai-eval/synthetic-notes.mjs');
  const pick = id => syntheticNoteRecord(SYNTHETIC_NOTES.find(row => row.id === id));
  const source = pick('vi-02'), similar = pick('ja-02'), unconsented = pick('en-02');
  for (const record of [source, similar, unconsented]) host.commit(record);
  grantNoteConsent(host.db, similar.id, { state: 'APPROVED_LOCAL_ONLY', providerBoundary: 'MOCK', env });
  const budget = { ...output, categorySuggestion: null, tagCandidates: [], taskCandidates: [], shortSummary: 'Synthetic budget summary.' };
  const publishWith = async () => {
    enqueueAiJob(host.db, source.id, { serverVersion: 1, env, analysisPolicyVersion: `p-${crypto.randomUUID().slice(0, 8)}` });
    assert.equal((await runOneAiJob(host.db, { workerId: 'w', provider: createMockProvider({ output: budget }), env })).status, 'COMPLETED');
    return JSON.parse(host.db.prepare('SELECT payload_json p FROM ai_suggestions WHERE note_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(source.id).p).relatedCandidates;
  };
  grantNoteConsent(host.db, source.id, { state: 'APPROVED_LOCAL_ONLY', providerBoundary: 'MOCK', env });
  assert.deepEqual(await publishWith(), [{ id: similar.id, reason: 'similar_content' }], 'Vietnamese budget note relates to the Japanese household-budget note, not to the unconsented English one');
  revokeNoteConsent(host.db, similar.id);
  assert.deepEqual(await publishWith(), []);
});
