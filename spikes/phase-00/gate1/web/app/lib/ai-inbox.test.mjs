import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotesRepository } from './local-notes.js';
import { createSaveCoordinator } from './save-coordinator.mjs';
import { canonicalJson } from './sync-protocol.mjs';
import {
  confidenceOf, deliverAiDecisions, fetchNoteSuggestions, fetchSuggestionInbox, itemApplicability, planApply, planUndo,
  previewItem, recordDecision, suggestionItems,
} from './ai-inbox.mjs';
import { openStore, serverMeta, transaction, appendChange } from '../../sync-server/storage.mjs';
import { issuePairingCode, redeemPairingCode } from '../../sync-server/auth.mjs';
import { applyAiSchema, createMockProvider, enqueueAiJob, grantNoteConsent, revokeNoteConsent, runOneAiJob } from '../../sync-server/ai-foundation.mjs';
import { handleAi } from '../../sync-server/ai-http.mjs';
import { handleSync } from '../../sync-server/http.mjs';

const origin = 'http://127.0.0.1:15700';
const doc = (...blocks) => ({ schemaVersion: 1, type: 'doc', content: blocks });
const para = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const baseNote = (id = 'inbox-note', extra = {}) => ({
  id, title: 'Kế hoạch ra mắt', document: doc(para('Họp với nhóm thiết kế vào thứ Hai.'), para('Cần đặt phòng họp cho buổi demo.')),
  schemaVersion: 1, createdAt: 1, updatedAt: 2, lifecycle: 'active', revision: 1, privacy: 'PRIVATE_SERVER', pinned: false, tags: ['Công việc'], ...extra,
});
const payload = {
  schemaVersion: 1, categorySuggestion: { label: 'Work', sourceQuote: 'nhóm thiết kế' }, shortSummary: 'Chuẩn bị buổi demo ra mắt.',
  tagCandidates: [{ label: 'demo', sourceQuote: 'buổi demo' }, { label: 'công việc', sourceQuote: 'Công việc' }],
  taskCandidates: [{ text: 'Đặt phòng họp', sourceQuote: 'Cần đặt phòng họp' }], relatedCandidates: [{ id: 'other-note', reason: 'tag_overlap' }], insufficientContext: false, uncertainty: 0.2,
};
const suggestion = (items = {}) => ({ id: '00000000-0000-4000-8000-000000000001', noteId: 'inbox-note', payload, items });
const journal = () => ({ value: null, isCurrent: () => true, write(value) { this.value = value; }, clear() { this.value = null; } });

test('items, confidence and previews are derived from the validated payload with stable keys', () => {
  const items = suggestionItems(suggestion());
  assert.deepEqual(items.map(item => item.key), ['category', 'summary', 'tag:0', 'tag:1', 'task:0', 'related:0']);
  assert.deepEqual(confidenceOf(payload), { value: 0.8, label: 'High' });
  assert.deepEqual(confidenceOf({ uncertainty: 0.6 }), { value: 0.4, label: 'Low' });
  assert.deepEqual(previewItem(items[4], baseNote()), { area: 'End of note · checklist', add: ['☐ Đặt phòng họp'] });
  assert.deepEqual(previewItem(items[5], baseNote(), { relatedTitle: 'Ngân sách' }).add, ['Related: Ngân sách']);
});

test('applicability: grounded items are ready; removed quotes are stale; existing effects are duplicates', () => {
  const note = baseNote(), items = Object.fromEntries(suggestionItems(suggestion()).map(item => [item.key, item]));
  assert.equal(itemApplicability(items['tag:0'], note).status, 'ready');
  assert.deepEqual(itemApplicability(items['tag:1'], note), { status: 'duplicate', reason: 'tag_present' }, 'tag keys compare case-insensitively');
  const edited = { ...note, document: doc(para('Họp với nhóm thiết kế vào thứ Hai.')) };
  assert.deepEqual(itemApplicability(items['task:0'], edited), { status: 'stale', reason: 'quote_missing' });
  assert.deepEqual(itemApplicability(items['related:0'], note), { status: 'unavailable', reason: 'related_note_missing' });
  assert.equal(itemApplicability({ ...items['tag:0'], state: { decision: 'APPROVED', version: 1 } }, note).status, 'applied');
  assert.equal(itemApplicability({ ...items['tag:0'], state: { decision: 'REJECTED', version: 1 } }, note).status, 'rejected');
  assert.deepEqual(itemApplicability(items['tag:0'], { ...note, tags: Array.from({ length: 20 }, (_, i) => `t${i}`) }), { status: 'unavailable', reason: 'tag_limit' });
  assert.equal(itemApplicability(items['tag:0'], { ...note, lifecycle: 'archived' }).reason, 'note_inactive');
});

test('apply plans produce validated documents with plain text only, and repeat applies are detected as duplicates', () => {
  const note = baseNote(), items = Object.fromEntries(suggestionItems(suggestion()).map(item => [item.key, item]));
  assert.deepEqual(planApply(items['tag:0'], note), { type: 'tags', label: 'demo', tags: ['Công việc', 'demo'] });
  assert.deepEqual(planApply(items.category, note, { value: 'Dự án' }).tags, ['Công việc', 'Dự án'], 'Edit applies the owner value');
  const task = planApply(items['task:0'], note);
  assert.deepEqual(task.document.content.at(-1), { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [para('Đặt phòng họp')] }] });
  const withTask = { ...note, document: task.document };
  assert.deepEqual(itemApplicability(items['task:0'], withTask), { status: 'duplicate', reason: 'task_present' });
  const second = planApply({ ...items['task:0'], key: 'task:1', value: 'Gửi lịch' }, withTask);
  assert.equal(second.document.content.at(-1).content.length, 2, 'a following task joins the trailing checklist');
  const summary = planApply(items.summary, note);
  assert.deepEqual(summary.document.content[0], { type: 'blockquote', content: [para('Chuẩn bị buổi demo ra mắt.')] });
  assert.equal(itemApplicability(items.summary, { ...note, document: summary.document }).status, 'duplicate');
  assert.deepEqual(planApply(items['related:0'], note, { relatedTitle: 'Ngân sách' }).document.content.at(-1), para('Related: Ngân sách'));
  assert.throws(() => planApply(items['task:0'], note, { value: 'bad\u0007value' }), error => error.code === 'invalid_text');
  assert.throws(() => planApply(items['tag:1'], note), error => error.code === 'tag_present');
});

test('undo: tags are removed semantically; document undo requires the note to be unchanged since apply', () => {
  const note = baseNote('inbox-note', { tags: ['Công việc', 'demo'], revision: 5 });
  assert.deepEqual(planUndo({ type: 'tags', label: 'DEMO' }, note), { type: 'tags', tags: ['Công việc'] });
  assert.deepEqual(planUndo({ type: 'tags', label: 'absent' }, note), { type: 'noop' });
  const before = doc(para('before'));
  assert.deepEqual(planUndo({ type: 'document', afterRevision: 5, beforeDocument: before }, note), { type: 'document', document: before });
  assert.throws(() => planUndo({ type: 'document', afterRevision: 4, beforeDocument: before }, note), error => error.code === 'note_changed');
  // After later edits, undo removes exactly the inserted node, or refuses if the owner edited it.
  const items = Object.fromEntries(suggestionItems(suggestion()).map(item => [item.key, item]));
  const applied = planApply(items['task:0'], baseNote());
  const later = { ...baseNote(), revision: 9, document: { ...applied.document, content: [para('Owner edit after apply'), ...applied.document.content] } };
  const semantic = planUndo({ type: 'document', afterRevision: 2, beforeDocument: baseNote().document, insertedNode: applied.insertedNode }, later);
  assert.deepEqual(semantic.document.content, [para('Owner edit after apply'), ...baseNote().document.content]);
  const editedTask = structuredClone(later); editedTask.document.content.at(-1).content[0].content[0].content[0].text = 'Owner reworded task';
  assert.throws(() => planUndo({ type: 'document', afterRevision: 2, insertedNode: applied.insertedNode }, editedTask), error => error.code === 'note_changed');
  assert.throws(() => planUndo({ type: 'tags', label: 'x', undoneAt: 1 }, note), error => error.code === 'nothing_to_undo');
});

// ---- Integration: real server handlers, real IndexedDB repository, SaveCoordinator ----

function serverHost(t) {
  const root = mkdtempSync(join(tmpdir(), 'noteos-ai-inbox-client-'));
  const db = openStore(root, { initialize: true }); applyAiSchema(db);
  writeFileSync(join(root, '.sync-epoch'), serverMeta(db).serverEpoch, { mode: 0o600 });
  const env = { NODE_ENV: 'test', NOTEOS_SYNC_ENABLED: '1', NOTEOS_AI_ORGANIZE_ENABLED: '1', NOTEOS_AI_INFERENCE_ENABLED: '1', NOTEOS_SYNC_ALLOWED_ORIGINS: origin, NOTEOS_SYNC_STORAGE: root };
  t.after(() => { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { db, env };
}

function commit(db, record) {
  transaction(db, () => {
    const json = canonicalJson(record), content = { ...record }; delete content.revision; delete content.createdAt; delete content.updatedAt;
    const hash = createHash('sha256').update(canonicalJson(content)).digest('hex');
    const cursor = appendChange(db, 'note', record.id, 1, 'upsert', json);
    db.prepare("INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES('note',?,1,?,?,?,0,?)").run(record.id, json, hash, record.lifecycle, cursor);
  });
}

/** A browser-like fetcher with a per-device cookie jar that calls the real route handlers. */
function browser(host, token, { offline = () => false } = {}) {
  const jar = new Map([['noteos_sync_local', token]]);
  return async (path, options = {}) => {
    if (offline()) throw new TypeError('Failed to fetch');
    const headers = new Headers({ host: '127.0.0.1:15700', origin, 'sec-fetch-site': 'same-origin', ...(options.headers ?? {}) });
    const scoped = path.startsWith('/api/v1/ai/') ? 'noteos_ai_local' : 'noteos_sync_local';
    if (jar.has(scoped)) headers.set('cookie', `${scoped}=${jar.get(scoped)}`);
    const request = new Request(`${origin}${path}`, { method: options.method ?? 'GET', headers, ...(options.body ? { body: options.body } : {}) });
    const response = path.startsWith('/api/v1/ai/') ? await handleAi(request, path.slice('/api/v1/ai/'.length), host.env) : await handleSync(request, path.slice('/api/v1/sync/'.length), host.env);
    for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const [name, value] = pair.split('='); jar.set(name, value); }
    return response;
  };
}

async function device(host, name, record) {
  const paired = redeemPairingCode(host.db, issuePairingCode(host.db), name);
  const repository = createNotesRepository(indexedDB, `noteos-ai-inbox-${name}-${crypto.randomUUID()}`);
  await repository.create(structuredClone(record));
  let current = await repository.get(record.id);
  const coordinator = createSaveCoordinator({ note: current, repository, journal: journal(), onChange: snapshot => { current = snapshot.note; } });
  return { repository, coordinator, fetcher: browser(host, paired.token), note: () => current };
}

async function publishSuggestion(host, record, output = payload) {
  grantNoteConsent(host.db, record.id, { state: 'APPROVED_LOCAL_ONLY', providerBoundary: 'MOCK', env: host.env });
  enqueueAiJob(host.db, record.id, { serverVersion: 1, env: host.env });
  assert.equal((await runOneAiJob(host.db, { workerId: 'w', provider: createMockProvider({ output: { ...output, relatedCandidates: [] } }), env: host.env })).status, 'COMPLETED');
}

async function approve(dev, suggestionRow, item, options = {}) {
  const note = dev.note(), plan = planApply(item, note, options);
  const result = plan.type === 'tags' ? await dev.coordinator.updateMetadata({ tags: plan.tags }) : (dev.coordinator.edit({ title: note.title, document: plan.document }), await dev.coordinator.flush());
  assert.equal(result.ok, true);
  await dev.repository.recordAiApplyReceipt({ suggestionId: suggestionRow.id, itemKey: item.key, noteId: note.id, type: plan.type, label: plan.label ?? null, beforeRevision: note.revision, afterRevision: result.note.revision, beforeDocument: plan.type === 'document' ? note.document : null });
  return recordDecision({ repository: dev.repository, fetcher: dev.fetcher, suggestion: suggestionRow, item, decision: options.value && options.value !== item.value ? 'EDITED' : 'APPROVED', appliedLocalRevision: result.note.revision });
}

test('integration: approve goes through SaveCoordinator + Sync outbox, decision CAS reaches the server, and undo is exact', async t => {
  const host = serverHost(t), record = baseNote(`it-${crypto.randomUUID().slice(0, 8)}`);
  commit(host.db, record); await publishSuggestion(host, record);
  const mac = await device(host, 'mac', record);
  await mac.repository.setSyncEnrollment([record.id], true);
  const [inboxRow] = await fetchSuggestionInbox({ fetcher: mac.fetcher });
  assert.equal(inboxRow.noteId, record.id); assert.equal(inboxRow.pendingCount, 5);
  let [current] = await fetchNoteSuggestions(record.id, { fetcher: mac.fetcher });
  const items = Object.fromEntries(suggestionItems(current).map(item => [item.key, item]));

  const tagged = await approve(mac, current, items['tag:0']);
  assert.equal(tagged.status, 'DELIVERED');
  assert.deepEqual(mac.note().tags, ['Công việc', 'demo']); assert.equal(mac.note().revision, 2);
  const outbox = await mac.repository.listSyncOutbox();
  assert.ok(outbox.some(operation => operation.id === record.id || operation.record?.id === record.id || JSON.stringify(operation).includes(record.id)), 'the apply is an ordinary Sync mutation');

  const tasked = await approve(mac, current, items['task:0'], { value: 'Đặt phòng họp tầng 3' });
  assert.equal(tasked.status, 'DELIVERED'); assert.equal(mac.note().revision, 3);
  [current] = await fetchNoteSuggestions(record.id, { fetcher: mac.fetcher });
  assert.equal(current.items['task:0'].decision, 'EDITED'); assert.equal(current.items['task:0'].appliedLocalRevision, 3);

  const receipts = Object.fromEntries((await mac.repository.listAiApplyReceipts(record.id)).map(row => [row.itemKey, row]));
  const undo = planUndo(receipts['task:0'], mac.note());
  mac.coordinator.edit({ title: mac.note().title, document: undo.document });
  const reverted = await mac.coordinator.flush();
  assert.deepEqual(reverted.note.document, record.document);
  await mac.repository.markAiApplyReceiptUndone(receipts['task:0'].id);
  const undone = await recordDecision({ repository: mac.repository, fetcher: mac.fetcher, suggestion: current, item: { ...items['task:0'], state: current.items['task:0'] }, decision: 'UNDONE' });
  assert.equal(undone.status, 'DELIVERED');
  [current] = await fetchNoteSuggestions(record.id, { fetcher: mac.fetcher });
  assert.equal(current.items['task:0'].decision, 'UNDONE');
  assert.equal(host.db.prepare("SELECT record_json FROM sync_entities WHERE id=?").get(record.id).record_json, canonicalJson(record), 'the server note is changed only by ordinary Sync, never by the inbox');
});

test('integration: a second device sees the item as applied; a stale concurrent decision is a CONFLICT, not a duplicate apply', async t => {
  const host = serverHost(t), record = baseNote(`cd-${crypto.randomUUID().slice(0, 8)}`);
  commit(host.db, record); await publishSuggestion(host, record);
  const mac = await device(host, 'mac', record), phone = await device(host, 'phone', record);
  const [phoneView] = await fetchNoteSuggestions(record.id, { fetcher: phone.fetcher });
  const [macView] = await fetchNoteSuggestions(record.id, { fetcher: mac.fetcher });
  const macItem = suggestionItems(macView).find(item => item.key === 'tag:0');
  assert.equal((await approve(mac, macView, macItem)).status, 'DELIVERED');
  const [phoneFresh] = await fetchNoteSuggestions(record.id, { fetcher: phone.fetcher });
  assert.equal(itemApplicability(suggestionItems(phoneFresh).find(item => item.key === 'tag:0'), phone.note()).status, 'applied');
  const staleItem = suggestionItems(phoneView).find(item => item.key === 'tag:0');
  const conflict = await recordDecision({ repository: phone.repository, fetcher: phone.fetcher, suggestion: phoneView, item: staleItem, decision: 'REJECTED' });
  assert.equal(conflict.status, 'CONFLICT'); assert.equal(conflict.error, 'DECISION_CONFLICT');
});

test('integration: offline decisions stay queued and deliver in order when the paired Mac is reachable', async t => {
  const host = serverHost(t), record = baseNote(`off-${crypto.randomUUID().slice(0, 8)}`);
  commit(host.db, record); await publishSuggestion(host, record);
  const paired = redeemPairingCode(host.db, issuePairingCode(host.db), 'offline-phone');
  let offline = false;
  const fetcher = browser(host, paired.token, { offline: () => offline });
  const repository = createNotesRepository(indexedDB, `noteos-ai-inbox-offline-${crypto.randomUUID()}`);
  const [view] = await fetchNoteSuggestions(record.id, { fetcher });
  offline = true;
  for (const key of ['summary', 'tag:0']) {
    const result = await recordDecision({ repository, fetcher, suggestion: view, item: suggestionItems(view).find(item => item.key === key), decision: key === 'summary' ? 'DEFERRED' : 'REJECTED' });
    assert.equal(result.status, 'PENDING');
  }
  assert.equal(host.db.prepare('SELECT count(*) n FROM ai_suggestion_decisions').get().n, 0);
  offline = false;
  assert.deepEqual(await deliverAiDecisions({ repository, fetcher }), { delivered: 2, conflicts: 0, waiting: 0, failed: 0 });
  assert.deepEqual(host.db.prepare('SELECT item_key k,decision d FROM ai_suggestion_item_state ORDER BY item_key').all().map(row => [row.k, row.d]), [['summary', 'DEFERRED'], ['tag:0', 'REJECTED']]);
  assert.deepEqual(await deliverAiDecisions({ repository, fetcher }), { delivered: 0, conflicts: 0, waiting: 0, failed: 0 }, 'delivery is idempotent');
});

test('integration: revocation removes suggestions from the inbox and a queued decision fails closed as FAILED', async t => {
  const host = serverHost(t), record = baseNote(`rv-${crypto.randomUUID().slice(0, 8)}`);
  commit(host.db, record); await publishSuggestion(host, record);
  const mac = await device(host, 'mac', record);
  const [view] = await fetchNoteSuggestions(record.id, { fetcher: mac.fetcher });
  revokeNoteConsent(host.db, record.id);
  assert.deepEqual(await fetchSuggestionInbox({ fetcher: mac.fetcher }), []);
  const result = await recordDecision({ repository: mac.repository, fetcher: mac.fetcher, suggestion: view, item: suggestionItems(view)[0], decision: 'REJECTED' });
  assert.equal(result.status, 'FAILED'); assert.equal(result.error, 'SUGGESTION_REVOKED');
});
