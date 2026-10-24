import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openStore, serverMeta, transaction, appendChange } from './storage.mjs';
import { handleSync } from './http.mjs';
import {
  aiFeatureFlags, applyAiSchema, claimAiJob, createMockProvider, enqueueAiJob,
  evaluateAiPolicy, grantNoteConsent, recoverExpiredAiJobs, relatedNoteCandidates,
  revokeNoteConsent, runOneAiJob, validateAiSuggestion,
} from './ai-foundation.mjs';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';

const ROOT = new URL('.', import.meta.url);
const enabled = { NOTEOS_AI_ORGANIZE_ENABLED: '1', NOTEOS_AI_INFERENCE_ENABLED: '1', NODE_ENV: 'test' };
const noteFixture = (id = 'note-1', { privacy = 'CLOUD_ALLOWED', lifecycle = 'active', title = 'Launch plan' } = {}) => ({
  id, title, document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Review the Q3 launch plan with the design team.' }] }] },
  schemaVersion: 1, createdAt: 10, updatedAt: 20, lifecycle, revision: 3, privacy, tags: ['Work'],
});
const resultFixture = (quote = 'Q3 launch plan') => ({
  schemaVersion: 1, categorySuggestion: null, tagCandidates: [{ label: 'Launch', sourceQuote: quote }],
  shortSummary: 'Review the launch plan.', taskCandidates: [{ text: 'Review launch plan', sourceQuote: quote }],
  relatedCandidates: [], insufficientContext: false, uncertainty: 0.2,
});
function setup(t, { version = 2, withAi = true, note = noteFixture() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'noteos-ai-foundation-'));
  const db = openStore(root, { initialize: true });
  if (version === 3) db.exec(readFileSync(new URL('./migrations/003-audio.sql', ROOT), 'utf8'));
  if (withAi) applyAiSchema(db);
  writeFileSync(join(root, '.sync-epoch'), serverMeta(db).serverEpoch, { mode: 0o600 });
  if (note) commitNote(db, note, 1);
  t.after(() => { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, db, note };
}
function commitNote(db, note, version) {
  return transaction(db, () => {
    const recordJson = canonicalJson(note), content = { ...note };
    delete content.revision; delete content.createdAt; delete content.updatedAt;
    const contentHash = createHash('sha256').update(canonicalJson(content)).digest('hex');
    const cursor = appendChange(db, 'note', note.id, version, 'upsert', recordJson);
    if (version === 1) db.prepare("INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES('note',?,?,?,?,?,0,?)").run(note.id, version, recordJson, contentHash, note.lifecycle, cursor);
    else db.prepare("UPDATE sync_entities SET server_version=?,record_json=?,content_hash=?,lifecycle=?,committed_cursor=? WHERE entity_type='note' AND id=?").run(version, recordJson, contentHash, note.lifecycle, cursor, note.id);
    return { cursor, contentHash };
  });
}
function grant(db, note, options = {}) {
  return grantNoteConsent(db, note.id, { state: 'APPROVED_CLOUD_ALLOWED', providerBoundary: 'MOCK', env: enabled, ...options });
}
function enqueue(db, note, options = {}) { return enqueueAiJob(db, note.id, { serverVersion: 1, env: enabled, now: 1000, ...options }); }
function snapshotSync(db) {
  const tables = ['sync_devices','sync_entities','sync_tombstones','sync_changelog','sync_operations'];
  for (const table of ['sync_media_approvals','sync_media_objects','sync_recording_media','sync_recording_versions']) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) tables.push(table);
  }
  return [db.prepare('SELECT singleton,server_epoch,server_cursor FROM sync_server_meta').all(), ...tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())];
}
function seedDevice(db, id = 'preserved-device') {
  db.prepare('INSERT OR IGNORE INTO sync_devices(id,label,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(id, 'Synthetic device', `${id}-token-hash`, 1, 9999999999999);
}
function seedAudioMetadata(db) {
  const objectHash = 'a'.repeat(64), metadataHash = 'b'.repeat(64);
  seedDevice(db);
  db.prepare('INSERT INTO sync_media_approvals(device_id,note_id,approved,updated_at) VALUES(?,?,1,?)').run('preserved-device', 'audio-note', 2);
  db.prepare('INSERT INTO sync_media_objects(sha256,byte_length,mime_type,created_at) VALUES(?,1,?,?)').run(objectHash, 'audio/wav', 2);
  db.prepare(`INSERT INTO sync_recording_media(recording_id,note_id,object_sha256,mime_type,total_bytes,chunk_size,chunk_count,server_version,manifest_json,metadata_hash,updated_at)
    VALUES(?,?,?,?,1,1,1,1,'{}',?,?)`).run('recording-1', 'audio-note', objectHash, 'audio/wav', metadataHash, 2);
  db.prepare(`INSERT INTO sync_recording_versions(recording_id,server_version,device_id,metadata_json,metadata_hash,created_at)
    VALUES(?,1,?,'{}',?,?)`).run('recording-1', 'preserved-device', metadataHash, 2);
}

test('AI flags default OFF and ordinary store initialization performs no AI migration', t => {
  const { db } = setup(t, { withAi: false });
  assert.deepEqual(aiFeatureFlags({}), { organizeEnabled: false, inferenceEnabled: false });
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%'").get().n, 0);
  assert.equal(serverMeta(db).schemaVersion, 2);
});

test('policy is separate from Sync and privacy and fails closed across consent/privacy states', () => {
  const base = noteFixture();
  const consent = { state: 'APPROVED_CLOUD_ALLOWED', scopes: ['organize'], provider_boundary: 'MOCK', consent_epoch: 1 };
  assert.equal(evaluateAiPolicy({ note: { ...base, privacy: undefined }, consent, executionBoundary: 'MOCK' }).reason, 'privacy_missing');
  assert.equal(evaluateAiPolicy({ note: { ...base, privacy: 'DEVICE_ONLY' }, consent, executionBoundary: 'MOCK' }).reason, 'device_only');
  assert.equal(evaluateAiPolicy({ note: { ...base, lifecycle: 'trashed' }, consent, executionBoundary: 'MOCK' }).reason, 'note_inactive');
  assert.equal(evaluateAiPolicy({ note: base, consent: null, executionBoundary: 'MOCK' }).reason, 'consent_missing');
  assert.equal(evaluateAiPolicy({ note: base, consent: { ...consent, state: 'REVOKED' }, executionBoundary: 'MOCK' }).reason, 'consent_revoked');
  assert.equal(evaluateAiPolicy({ note: base, consent, executionBoundary: 'EXTERNAL_CLOUD' }).reason, 'external_provider_disabled_in_09a');
  assert.equal(evaluateAiPolicy({ note: { ...base, privacy: 'PRIVATE_SERVER' }, consent, executionBoundary: 'MOCK' }).reason, 'private_server_requires_local_consent');
  assert.equal(evaluateAiPolicy({ note: { ...base, privacy: 'PRIVATE_SERVER' }, consent: { ...consent, state: 'APPROVED_LOCAL_ONLY' }, executionBoundary: 'STRICT_LOCAL', localExecutionAttested: false }).reason, 'local_execution_not_proven');
});

test('explicit consent grants and revocation advance consent epoch and cancel queued work', t => {
  const { db, note } = setup(t); const first = grant(db, note);
  assert.equal(first.consentEpoch, 1);
  const job = enqueue(db, note);
  const revoked = revokeNoteConsent(db, note.id, { now: 1100 });
  assert.equal(revoked.consentEpoch, 2);
  assert.equal(db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(job.id).status, 'CANCELED');
  assert.equal(db.prepare('SELECT count(*) n FROM ai_suggestions').get().n, 0);
  assert.deepEqual(db.prepare('SELECT action FROM ai_audit_log ORDER BY id').all().map(row => row.action), ['CONSENT_GRANTED','JOB_ENQUEUED','CONSENT_REVOKED','SUGGESTION_REVOKED']);
});

test('privacy policy rejection before enqueue produces zero provider invocations', t => {
  const privateNote = noteFixture('private-note', { privacy: 'PRIVATE_SERVER' });
  const { db } = setup(t, { note: privateNote });
  grant(db, privateNote, { state: 'APPROVED_CLOUD_ALLOWED' });
  let invocations = 0;
  const provider = createMockProvider({ output: resultFixture(), onInvoke: () => invocations++ });
  assert.throws(() => enqueue(db, privateNote), /policy rejected/);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_jobs').get().n, 0);
  assert.equal(invocations, 0);
  assert.equal(provider.executionBoundary, 'MOCK');
});

test('job, dedupe receipt and audit insert roll back together when durable audit capacity is exhausted', t => {
  const { db, note } = setup(t); grant(db, note);
  const insert = db.prepare("INSERT INTO ai_audit_log(action,reason_code,metadata_json,created_at) VALUES('JOB_ENQUEUED','synthetic_capacity','{}',?)");
  for (let index = 0; index < 9999; index++) insert.run(index + 1);
  assert.throws(() => enqueue(db, note), /audit capacity/);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_jobs').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_audit_log').get().n, 10000);
});

test('disabled organize flag blocks consent, enqueue and provider invocation with zero side effects', async t => {
  const { db, note } = setup(t);
  assert.throws(() => grantNoteConsent(db, note.id), /disabled/);
  assert.throws(() => enqueueAiJob(db, note.id, { serverVersion: 1 }), /disabled/);
  const called = { n: 0 };
  const result = await runOneAiJob(db, { workerId: 'worker-a', provider: createMockProvider({ output: resultFixture(), onInvoke: () => called.n++ }), env: {} });
  assert.deepEqual(result, { status: 'disabled', invoked: false }); assert.equal(called.n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_jobs').get().n, 0);
});

test('Mock Provider cannot run outside test mode even if both AI flags are set', async t => {
  const { db, note } = setup(t); grant(db, note); enqueue(db, note);
  let calls = 0;
  const result = await runOneAiJob(db, { workerId: 'worker-a', provider: createMockProvider({ output: resultFixture(), onInvoke: () => calls++ }), env: { NOTEOS_AI_ORGANIZE_ENABLED: '1', NOTEOS_AI_INFERENCE_ENABLED: '1', NODE_ENV: 'production' }, now: 2000 });
  assert.deepEqual(result, { status: 'mock_provider_test_only', invoked: false });
  assert.equal(calls, 0); assert.equal(db.prepare("SELECT status FROM ai_jobs").get().status, 'QUEUED');
});

test('enqueue deduplicates identical request, records no note text, and adds no job through normal Text Sync path', async t => {
  const { db, note, root } = setup(t); grant(db, note);
  const one = enqueue(db, note), duplicate = enqueue(db, note);
  assert.equal(duplicate.id, one.id); assert.equal(duplicate.reused, true);
  const jobColumns = db.prepare('PRAGMA table_info(ai_jobs)').all().map(row => row.name);
  assert.equal(jobColumns.some(name => /prompt_text|prompt_json|record_json|note_text|content_text/i.test(name)), false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM ai_jobs').all()).includes('Q3 launch'), false);
  const before = db.prepare('SELECT count(*) n FROM ai_jobs').get().n;
  const token = 'a'.repeat(43), deviceId = 'sync-device', syncOnlyNote = noteFixture('sync-only-note');
  db.prepare('INSERT INTO sync_devices(id,label,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(deviceId, 'Synthetic device', createHash('sha256').update(token).digest('hex'), 1, 9999999999999);
  const origin = 'http://127.0.0.1:15700';
  const op = { protocolVersion: 1, operations: [{ operationId: 'operation-0000001', entityId: syncOnlyNote.id, baseServerVersion: 0, ownerApproved: true, recordingCount: 0, type: 'upsert', recordJson: canonicalJson(syncOnlyNote) }] };
  const response = await handleSync(new Request(`${origin}/api/v1/sync/push`, { method: 'POST', headers: { host: '127.0.0.1:15700', origin, cookie: `noteos_sync_local=${token}`, 'content-type': 'application/json', 'x-noteos-sync': '1' }, body: JSON.stringify(op) }), 'push', { NOTEOS_SYNC_ENABLED: '1', NOTEOS_SYNC_STORAGE: root, NOTEOS_SYNC_ALLOWED_ORIGINS: origin });
  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_jobs').get().n, before);
});

test('changed policy, model and consent epoch each produce a different dedupe identity', t => {
  const { db, note } = setup(t); grant(db, note);
  const first = enqueue(db, note);
  const changedPolicy = enqueue(db, note, { analysisPolicyVersion: 'ai-policy-v2' });
  const changedModel = enqueue(db, note, { modelIdentity: 'mock-v2' });
  revokeNoteConsent(db, note.id, { now: 1100 }); grant(db, note, { now: 1200 });
  const changedConsent = enqueue(db, note, { now: 1300 });
  assert.equal(new Set([first.id, changedPolicy.id, changedModel.id, changedConsent.id]).size, 4);
});

test('new note revision supersedes older queued work and blocks enqueue for the stale version', t => {
  const { db, note } = setup(t); grant(db, note); const old = enqueue(db, note);
  const updated = { ...note, revision: 4, updatedAt: 30, title: 'Updated launch plan' };
  commitNote(db, updated, 2);
  assert.throws(() => enqueue(db, note, { now: 1200 }), /stale|inactive/);
  const current = enqueueAiJob(db, note.id, { serverVersion: 2, env: enabled, now: 1300 });
  assert.equal(db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(old.id).status, 'SUPERSEDED');
  assert.equal(db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(current.id).status, 'QUEUED');
});

test('concurrent workers atomically claim only one job', async t => {
  const { db, root, note } = setup(t); grant(db, note); enqueue(db, note);
  const script = `import {openStore} from './sync-server/storage.mjs'; import {claimAiJob} from './sync-server/ai-foundation.mjs'; const d=openStore(process.argv[1]); const j=claimAiJob(d,process.argv[2],{now:2000}); console.log(j?.id??'idle'); d.close();`;
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const run = promisify(execFile);
  const results = await Promise.all(['worker-a','worker-b'].map(worker => run(process.execPath, ['--input-type=module','-e',script,root,worker], { cwd: process.cwd() })));
  assert.equal(results.filter(result => result.stdout.trim() !== 'idle').length, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM ai_jobs WHERE status='RUNNING'").get().n, 1);
});

test('expired leases recover with bounded exponential backoff and eventually dead-letter', t => {
  const { db, note } = setup(t); grant(db, note); const job = enqueue(db, note);
  let claim = claimAiJob(db, 'worker-a', { now: 2000, leaseMs: 1000 });
  assert.equal(claim.status, 'RUNNING');
  assert.deepEqual(recoverExpiredAiJobs(db, { now: 3000 }), [{ id: job.id, status: 'QUEUED', runAfter: 4000 }]);
  claimAiJob(db, 'worker-a', { now: 4000, leaseMs: 1000 });
  db.prepare("UPDATE ai_jobs SET attempts=5,lease_until=5000 WHERE id=?").run(job.id);
  assert.deepEqual(recoverExpiredAiJobs(db, { now: 5000 }), [{ id: job.id, status: 'FAILED_NEEDS_REVIEW' }]);
});

test('late worker cannot publish after revocation during provider call', async t => {
  const { db, note } = setup(t); grant(db, note); enqueue(db, note);
  let finish; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = { identity: 'mock-v1', executionBoundary: 'MOCK', analyze: async () => { entered(); return new Promise(resolve => { finish = resolve; }); } };
  const work = runOneAiJob(db, { workerId: 'worker-a', provider: delayed, env: enabled, now: 2000, leaseMs: 10000 });
  await started; revokeNoteConsent(db, note.id, { now: 2100 }); finish(resultFixture());
  assert.equal((await work).status, 'discarded');
  assert.equal(db.prepare('SELECT count(*) n FROM ai_suggestions').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM ai_jobs').get().status, 'CANCELED');
});

test('late worker with expired fencing token cannot publish after reclaim', async t => {
  const { db, note } = setup(t); grant(db, note); const queued = enqueue(db, note);
  let finish; let entered; const started = new Promise(resolve => { entered = resolve; });
  const delayed = { identity: 'mock-v1', executionBoundary: 'MOCK', analyze: async () => { entered(); return new Promise(resolve => { finish = resolve; }); } };
  const oldWorker = runOneAiJob(db, { workerId: 'worker-a', provider: delayed, env: enabled, now: 2000, leaseMs: 1000 });
  await started; recoverExpiredAiJobs(db, { now: 3000 }); const newClaim = claimAiJob(db, 'worker-b', { now: 4000, leaseMs: 10000 });
  assert.equal(newClaim.id, queued.id); finish(resultFixture());
  assert.equal((await oldWorker).status, 'discarded'); assert.equal(db.prepare('SELECT claim_token FROM ai_jobs').get().claim_token, newClaim.claim_token);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_suggestions').get().n, 0);
});

test('server epoch change cancels an otherwise current job before provider dispatch', async t => {
  const { db, note } = setup(t); grant(db, note); enqueue(db, note);
  db.prepare('UPDATE sync_server_meta SET server_epoch=? WHERE singleton=1').run('new-server-epoch');
  let calls = 0;
  const provider = createMockProvider({ output: resultFixture(), onInvoke: () => calls++ });
  const result = await runOneAiJob(db, { workerId: 'worker-a', provider, env: enabled, now: 2000 });
  assert.equal(result.status, 'canceled'); assert.equal(result.reason, 'server_epoch_changed'); assert.equal(calls, 0);
});

test('provider timeout uses bounded retry and no automatic busy polling', async t => {
  const { db, note } = setup(t); grant(db, note); const job = enqueue(db, note);
  const failed = { identity: 'mock-v1', executionBoundary: 'MOCK', analyze: async () => { throw new Error('synthetic timeout'); } };
  const result = await runOneAiJob(db, { workerId: 'worker-a', provider: failed, env: enabled, now: 2000 });
  assert.deepEqual(result, { status: 'QUEUED', invoked: true, runAfter: 3000 });
  assert.equal(db.prepare('SELECT run_after FROM ai_jobs WHERE id=?').get(job.id).run_after, 3000);
  assert.deepEqual(await runOneAiJob(db, { workerId: 'worker-a', provider: failed, env: enabled, now: 2001 }), { status: 'idle', invoked: false });
});

test('invalid provider payload fails closed; a rejected policy never invokes the provider', async t => {
  const { db, note } = setup(t); grant(db, note); const job = enqueue(db, note);
  let calls = 0;
  const rejection = await runOneAiJob(db, { workerId: 'worker-a', provider: createMockProvider({ output: resultFixture(), onInvoke: () => calls++ }), env: { ...enabled, NOTEOS_AI_INFERENCE_ENABLED: '0' }, now: 2000 });
  assert.equal(rejection.status, 'disabled'); assert.equal(calls, 0);
  const bad = createMockProvider({ output: { ...resultFixture(), extra: true }, onInvoke: () => calls++ });
  const invalid = await runOneAiJob(db, { workerId: 'worker-a', provider: bad, env: enabled, now: 2000 });
  assert.equal(invalid.status, 'FAILED_NEEDS_REVIEW'); assert.equal(calls, 1);
  assert.equal(db.prepare("SELECT status FROM ai_jobs WHERE id=?").get(job.id).status, 'FAILED_NEEDS_REVIEW');
  assert.equal(db.prepare('SELECT count(*) n FROM ai_suggestions').get().n, 0);
});

test('verified output is published only as a sidecar and leaves Sync note state byte-for-byte unchanged', async t => {
  const { db, note } = setup(t); grant(db, note); enqueue(db, note);
  const before = snapshotSync(db);
  const result = await runOneAiJob(db, { workerId: 'worker-a', provider: createMockProvider({ output: resultFixture() }), env: enabled, now: 2000 });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(snapshotSync(db), before);
  const suggestion = db.prepare('SELECT status,payload_json,provider_identity,target_server_version,content_sha256 FROM ai_suggestions').get();
  assert.equal(suggestion.status, 'PENDING_REVIEW'); assert.equal(suggestion.provider_identity, 'mock-v1');
  assert.equal(suggestion.target_server_version, 1); assert.equal(suggestion.content_sha256.length, 64);
  assert.equal(JSON.parse(suggestion.payload_json).tagCandidates[0].sourceQuote, 'Q3 launch plan');
});

test('output verifier rejects unknown fields, fabricated quotes, duplicate tags, unsafe markup and URLs', () => {
  const note = noteFixture();
  assert.throws(() => validateAiSuggestion({ ...resultFixture(), unexpected: 1 }, note), /fields/);
  assert.throws(() => validateAiSuggestion({ ...resultFixture(), tagCandidates: [{ label: 'Task', sourceQuote: 'fabricated quote' }] }, note), /sourceQuote/);
  assert.throws(() => validateAiSuggestion({ ...resultFixture(), tagCandidates: [{ label: 'Work', sourceQuote: 'Q3 launch plan' }, { label: 'work', sourceQuote: 'Q3 launch plan' }] }, note), /Duplicate/);
  assert.throws(() => validateAiSuggestion({ ...resultFixture(), shortSummary: '<img src=x>' }, note), /summary/);
  assert.throws(() => validateAiSuggestion({ ...resultFixture(), shortSummary: 'See https://example.com' }, note), /summary/);
  assert.throws(() => validateAiSuggestion({ ...resultFixture(), shortSummary: 'bad\u0000text' }, note), /summary/);
  assert.throws(() => validateAiSuggestion({ ...resultFixture(), shortSummary: 'bad\uD800' }, note), /summary/);
  assert.throws(() => validateAiSuggestion({ ...resultFixture(), relatedCandidates: [{ id: 'invented', reason: 'title_match' }] }, note), /related-note/);
  assert.throws(() => validateAiSuggestion('{', note), /valid JSON/);
  assert.throws(() => validateAiSuggestion(JSON.stringify(resultFixture()).repeat(1000), note), /size limit/);
  let deep = { value: true }; for (let index = 0; index < 20; index++) deep = { child: deep };
  assert.throws(() => validateAiSuggestion(deep, note), /shape limits/);
});

test('short note and multilingual quote fixtures pass deterministic grounding', () => {
  for (const text of ['OK', 'Tôi sẽ kiểm tra bản phát hành.', '次の会議で計画を確認する']) {
    const note = { ...noteFixture(), document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } };
    const quote = text.slice(0, Math.min(10, text.length));
    assert.equal(validateAiSuggestion({ ...resultFixture(quote), tagCandidates: [], taskCandidates: [], relatedCandidates: [], categorySuggestion: null, shortSummary: null, insufficientContext: true }, note).insufficientContext, true);
  }
});

test('related-note matcher is deterministic, bounded and filters ineligible privacy/consent candidates', () => {
  const note = { id: 'source', title: 'Launch plan', tags: ['Work'], privacy: 'CLOUD_ALLOWED', lifecycle: 'active' };
  const candidates = [
    { id: 'b', title: 'other', tags: ['Work'], privacy: 'PRIVATE_SERVER', lifecycle: 'active' },
    { id: 'a', title: 'Launch plan', tags: [], privacy: 'CLOUD_ALLOWED', lifecycle: 'active' },
    { id: 'private', title: 'Launch plan', tags: [], privacy: 'DEVICE_ONLY', lifecycle: 'active' },
    { id: 'trash', title: 'Launch plan', tags: [], privacy: 'CLOUD_ALLOWED', lifecycle: 'trashed' },
  ];
  const matches = relatedNoteCandidates({ note, candidates, consentFor: candidate => candidate.id !== 'b' });
  assert.deepEqual(matches.map(item => item.id), ['a']);
});

test('AI schema coexists with Sync v2/v3 in both migration orders without changing Sync state', t => {
  for (const version of [2,3]) {
    const { db: direct } = setup(t, { version, withAi: false, note: noteFixture(`direct-v${version}`) });
    seedDevice(direct);
    if (version === 3) seedAudioMetadata(direct);
    const before = snapshotSync(direct), originalVersion = direct.prepare('PRAGMA user_version').get().user_version, originalMeta = serverMeta(direct);
    applyAiSchema(direct);
    assert.deepEqual(snapshotSync(direct), before); assert.equal(direct.prepare('PRAGMA user_version').get().user_version, originalVersion); assert.deepEqual(serverMeta(direct), originalMeta);
  }
  const fixtures = [];
  for (const first of ['ai','audio']) {
    const root = mkdtempSync(join(tmpdir(), `noteos-ai-order-${first}-`));
    const db = openStore(root, { initialize: true });
    const note = noteFixture(`order-${first}`); commitNote(db, note, 1);
    seedDevice(db);
    if (first === 'ai') {
      const before = snapshotSync(db); applyAiSchema(db);
      db.exec(readFileSync(new URL('./migrations/003-audio.sql', ROOT), 'utf8'));
      assert.deepEqual(snapshotSync(db).slice(0, before.length), before);
      seedAudioMetadata(db);
    } else {
      db.exec(readFileSync(new URL('./migrations/003-audio.sql', ROOT), 'utf8'));
      seedAudioMetadata(db); const before = snapshotSync(db);
      applyAiSchema(db); assert.deepEqual(snapshotSync(db), before);
    }
    assert.equal(serverMeta(db).schemaVersion, 3); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close(); rmSync(root, { recursive: true, force: true }); fixtures.push(first);
  }
  assert.deepEqual(fixtures, ['ai','audio']);
});

test('AI migrations do not change changelog entity constraints or apply audio data migration', t => {
  const { db } = setup(t);
  assert.throws(() => db.prepare("INSERT INTO sync_changelog(server_cursor,entity_type,entity_id,server_version,event,record_json) VALUES(999,'ai_suggestion','x',1,'upsert','{}')").run(), /CHECK/);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'sync_media_%'").get().n, 0);
});
