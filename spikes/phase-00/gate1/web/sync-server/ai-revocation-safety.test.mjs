import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openStore, serverMeta, transaction, appendChange } from './storage.mjs';
import {
  applyAiSchema, claimAiJob, createMockProvider, enqueueAiJob, grantNoteConsent, isAiRevocationFailClosed,
  reconcileAiRevocationIntents, recoverExpiredAiJobs, revokeNoteConsent, runOneAiJob, applyAiConsentOperation,
} from './ai-foundation.mjs';
import {
  OPERATOR_STOP_FILE, aiControlDir, aiNoteKey, clearAutomaticInferenceStops, inferenceBlockReason, listAiControlState,
  persistAutomaticInferenceStop, persistRevocationIntent,
} from './ai-control.mjs';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';

const CHILD = new URL('./test-fixtures/ai-safety-child.mjs', import.meta.url).pathname;
const enabled = { NOTEOS_AI_ORGANIZE_ENABLED: '1', NOTEOS_AI_INFERENCE_ENABLED: '1', NODE_ENV: 'test' };
const output = { schemaVersion: 1, categorySuggestion: null, tagCandidates: [], shortSummary: 'Synthetic summary.', taskCandidates: [], relatedCandidates: [], insufficientContext: false, uncertainty: 0.5 };
const FAIL_REVOKE_TRIGGER = "CREATE TRIGGER ai_test_fail_revoke BEFORE UPDATE ON ai_note_consent BEGIN SELECT RAISE(ABORT,'synthetic revoke failure'); END";

const noteFixture = id => ({
  id, title: `Synthetic ${id}`, document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic revocation safety body.' }] }] },
  schemaVersion: 1, createdAt: 1, updatedAt: 2, lifecycle: 'active', revision: 1, privacy: 'PRIVATE_SERVER', tags: [],
});

function commitNote(db, note) {
  transaction(db, () => {
    const json = canonicalJson(note), content = { ...note };
    delete content.revision; delete content.createdAt; delete content.updatedAt;
    const hash = createHash('sha256').update(canonicalJson(content)).digest('hex');
    const cursor = appendChange(db, 'note', note.id, 1, 'upsert', json);
    db.prepare("INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES('note',?,1,?,?,?,0,?)").run(note.id, json, hash, note.lifecycle, cursor);
  });
}

let sequence = 0;
function setup(t, ids = [`safety-note-${++sequence}`]) {
  const root = mkdtempSync(join(tmpdir(), 'noteos-ai-safety-'));
  const db = openStore(root, { initialize: true }); applyAiSchema(db);
  writeFileSync(join(root, '.sync-epoch'), serverMeta(db).serverEpoch, { mode: 0o600 });
  for (const id of ids) { commitNote(db, noteFixture(id)); grantNoteConsent(db, id, { state: 'APPROVED_LOCAL_ONLY', providerBoundary: 'MOCK', env: enabled }); }
  t.after(() => {
    try { chmodSync(join(root, 'ai-control'), 0o700); } catch {}
    try { db.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db, noteId: ids[0] };
}

const enqueue = (db, noteId) => enqueueAiJob(db, noteId, { serverVersion: 1, env: enabled });

function child(mode, root, args = [], extraEnv = {}) {
  const proc = spawn(process.execPath, [CHILD, mode, root, ...args], { cwd: process.cwd(), env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [], waiters = [];
  let buffer = '', stderr = '';
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const event = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      events.push(event);
      for (const waiter of [...waiters]) if (waiter.match(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
    }
  });
  proc.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => proc.on('exit', code => resolve({ code, events, stderr })));
  const waitFor = (name, timeoutMs = 60000) => {
    const prior = events.find(event => event.event === name);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}; stderr=${stderr}; events=${JSON.stringify(events)}`)), timeoutMs);
      waiters.push({ match: event => event.event === name, resolve: event => { clearTimeout(timer); resolve(event); } });
    });
  };
  return { proc, events, waitFor, exited };
}

test('a revoke that cannot commit in one process aborts an in-flight provider call in another process', async t => {
  const { root, db, noteId } = setup(t); enqueue(db, noteId);
  const worker = child('worker', root, [noteId, 'worker-a']);
  await worker.waitFor('invoked');
  db.exec(FAIL_REVOKE_TRIGGER);
  const startedAt = Date.now();
  assert.throws(() => revokeNoteConsent(db, noteId), error => error.code === 'AI_REVOCATION_NOT_PERSISTED' && error.controlPlane === 'revocation_intent_persisted');
  const aborted = await worker.waitFor('provider_aborted');
  const { result } = await worker.waitFor('result');
  await worker.exited;
  assert.deepEqual(result, { status: 'aborted', reason: 'revocation_state_uncertain', invoked: true });
  assert.ok(Date.now() - startedAt < 2000, 'cross-process abort must complete promptly');
  assert.ok(aborted.afterMs >= 0);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_suggestions').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM ai_jobs').get().status, 'CANCELED');
  assert.equal(db.prepare('SELECT state FROM ai_note_consent WHERE note_id=?').get(noteId).state, 'APPROVED_LOCAL_ONLY', 'the failed revoke did not commit');
  db.exec('DROP TRIGGER ai_test_fail_revoke');
  assert.equal(revokeNoteConsent(db, noteId).state, 'REVOKED');
  assert.equal(inferenceBlockReason(db, noteId), null);
  assert.deepEqual(listAiControlState(db).pendingRevocationKeys, []);
});

test('a new worker process does not dispatch while a failed revocation is pending', async t => {
  const { root, db, noteId } = setup(t); enqueue(db, noteId);
  db.exec(FAIL_REVOKE_TRIGGER);
  assert.throws(() => revokeNoteConsent(db, noteId), error => error.code === 'AI_REVOCATION_NOT_PERSISTED');
  const worker = child('worker', root, [noteId, 'worker-b']);
  const { result } = await worker.waitFor('result');
  await worker.exited;
  assert.deepEqual(result, { status: 'canceled', reason: 'revocation_state_uncertain', invoked: false });
  assert.equal(worker.events.some(event => event.event === 'invoked'), false);
});

test('a crash after the durable intent and before commit stays fail-closed and reconcile completes it after restart', async t => {
  const { root, db, noteId } = setup(t); enqueue(db, noteId);
  const crasher = child('revoke-crash', root, [noteId]);
  await crasher.waitFor('intent_persisted');
  assert.equal((await crasher.exited).code, 86);
  assert.equal(db.prepare('SELECT state FROM ai_note_consent WHERE note_id=?').get(noteId).state, 'APPROVED_LOCAL_ONLY');
  assert.equal(inferenceBlockReason(db, noteId), 'revocation_state_uncertain');
  assert.throws(() => grantNoteConsent(db, noteId, { providerBoundary: 'MOCK', env: enabled }), error => error.code === 'REVOCATION_PENDING');
  assert.throws(() => enqueue(db, noteId), error => error.code === 'REVOCATION_PENDING');

  const worker = child('worker', root, [noteId, 'worker-c']);
  assert.equal((await worker.waitFor('result')).result.invoked, false);
  await worker.exited;

  const reconcile = child('reconcile', root);
  const { result } = await reconcile.waitFor('result');
  await reconcile.exited;
  assert.deepEqual(result, { completed: [noteId], unmatched: [] });
  const consent = db.prepare('SELECT state,consent_epoch epoch FROM ai_note_consent WHERE note_id=?').get(noteId);
  assert.deepEqual({ ...consent }, { state: 'REVOKED', epoch: 2 });
  assert.equal(db.prepare("SELECT reason_code reason FROM ai_audit_log WHERE action='CONSENT_REVOKED'").get().reason, 'recovered_revocation_intent');
  assert.equal(inferenceBlockReason(db, noteId), null);
  assert.equal(grantNoteConsent(db, noteId, { providerBoundary: 'MOCK', env: enabled }).consentEpoch, 3, 'a new explicit grant is possible after reconcile');
  assert.deepEqual(reconcileAiRevocationIntents(db), { completed: [], unmatched: [] }, 'reconcile is idempotent');
});

test('a real SQLite read-only connection cannot revoke or dispatch; the intent blocks other processes until reconcile', async t => {
  const { root, db, noteId } = setup(t); enqueue(db, noteId);
  const revoker = child('revoke-readonly', root, [noteId]);
  const failed = await revoker.waitFor('revoke_failed');
  await revoker.exited;
  assert.equal(failed.code, 'AI_REVOCATION_NOT_PERSISTED');
  assert.equal(failed.controlPlane, 'revocation_intent_persisted');
  assert.match(failed.cause, /readonly/i);

  const readonlyWorker = child('worker-readonly', root, [noteId, 'worker-ro']);
  const readonlyResult = await readonlyWorker.waitFor('result');
  await readonlyWorker.exited;
  assert.deepEqual(readonlyResult.result, { status: 'blocked', reason: 'claim_not_persisted', invoked: false });
  assert.equal(readonlyResult.invoked, 0);

  const worker = child('worker', root, [noteId, 'worker-rw']);
  assert.equal((await worker.waitFor('result')).result.reason, 'revocation_state_uncertain');
  await worker.exited;
  assert.deepEqual(reconcileAiRevocationIntents(db).completed, [noteId]);
  assert.equal(db.prepare('SELECT state FROM ai_note_consent WHERE note_id=?').get(noteId).state, 'REVOKED');
});

test('the dispatch fence must commit: storage that turns read-only after claim never reaches the provider', async t => {
  const { db, noteId } = setup(t); enqueue(db, noteId);
  let invoked = 0, reads = 0;
  const result = await runOneAiJob(db, {
    workerId: 'worker-fence', env: enabled,
    provider: createMockProvider({ output, onInvoke: () => invoked++ }),
    clock: () => { if (reads++ === 0) db.exec('PRAGMA query_only=ON'); return Date.now(); },
  });
  db.exec('PRAGMA query_only=OFF');
  assert.deepEqual(result, { status: 'blocked', reason: 'dispatch_not_persisted', invoked: false });
  assert.equal(invoked, 0);
});

test('an unwritable control plane blocks dispatch in this process and in a separate worker process', async t => {
  const { root, db, noteId } = setup(t); enqueue(db, noteId);
  chmodSync(aiControlDir(db), 0o500);
  let invoked = 0;
  const local = await runOneAiJob(db, { workerId: 'worker-local', env: enabled, provider: createMockProvider({ output, onInvoke: () => invoked++ }) });
  assert.deepEqual(local, { status: 'blocked', reason: 'dispatch_not_persisted', invoked: false });
  db.prepare("UPDATE ai_jobs SET status='QUEUED',lease_until=NULL,worker_id=NULL,claim_token=NULL").run();
  const worker = child('worker', root, [noteId, 'worker-d']);
  assert.deepEqual((await worker.waitFor('result')).result, { status: 'blocked', reason: 'dispatch_not_persisted', invoked: false });
  await worker.exited;
  assert.equal(invoked, 0);
});

test('when neither the intent marker nor SQLite can persist, revoke reports it and every process stays blocked', async t => {
  const { root, db, noteId } = setup(t); enqueue(db, noteId);
  db.exec(FAIL_REVOKE_TRIGGER);
  chmodSync(aiControlDir(db), 0o500);
  assert.throws(() => revokeNoteConsent(db, noteId), error => error.code === 'AI_REVOCATION_NOT_PERSISTED' && error.controlPlane === 'unavailable');
  assert.equal(isAiRevocationFailClosed(noteId), true, 'the serving process is latched');
  const worker = child('worker', root, [noteId, 'worker-e']);
  assert.deepEqual((await worker.waitFor('result')).result, { status: 'blocked', reason: 'dispatch_not_persisted', invoked: false });
  await worker.exited;
  chmodSync(aiControlDir(db), 0o700);
  db.exec('DROP TRIGGER ai_test_fail_revoke');
  assert.equal(revokeNoteConsent(db, noteId).state, 'REVOKED');
  assert.equal(isAiRevocationFailClosed(noteId), false);
});

test('if the intent marker cannot be written but SQLite commits, the durable REVOKED row is authoritative', t => {
  const { db, noteId } = setup(t); enqueue(db, noteId);
  chmodSync(aiControlDir(db), 0o500);
  const result = revokeNoteConsent(db, noteId);
  chmodSync(aiControlDir(db), 0o700);
  assert.equal(result.state, 'REVOKED');
  assert.equal(result.canceledJobs, 1);
  assert.deepEqual(listAiControlState(db), { operatorStop: false, automaticStops: 0, pendingRevocationKeys: [] });
});

test('operator and automatic stops block all notes, abort in-flight work and leave recovery to lease expiry', async t => {
  const { root, db, noteId } = setup(t, ['stop-a', 'stop-b']); enqueue(db, 'stop-a');
  const worker = child('worker', root, ['stop-a', 'worker-f']);
  await worker.waitFor('invoked');
  writeFileSync(join(aiControlDir(db), OPERATOR_STOP_FILE), '');
  assert.deepEqual((await worker.waitFor('result')).result, { status: 'aborted', reason: 'inference_stopped', invoked: true });
  await worker.exited;
  assert.equal(db.prepare('SELECT status FROM ai_jobs').get().status, 'RUNNING', 'a stop is not a revocation; the lease expires and is retried later');
  const expiresAt = db.prepare('SELECT lease_until l FROM ai_jobs').get().l;
  assert.equal(recoverExpiredAiJobs(db, { now: expiresAt })[0].status, 'QUEUED');
  assert.equal(inferenceBlockReason(db, 'stop-b'), 'inference_stopped');
  rmSync(join(aiControlDir(db), OPERATOR_STOP_FILE));

  persistAutomaticInferenceStop(db);
  assert.equal(inferenceBlockReason(db, noteId), 'inference_stopped');
  assert.equal(revokeNoteConsent(db, noteId).state, 'REVOKED');
  assert.equal(inferenceBlockReason(db, 'stop-b'), 'inference_stopped', 'a later successful revoke never clears an automatic global stop');
  assert.equal(clearAutomaticInferenceStops(db), 1);
  assert.equal(inferenceBlockReason(db, 'stop-b'), null);
});

test('a successful revoke clears intents up to its commit but keeps a newer concurrent intent', t => {
  const { db, noteId } = setup(t);
  persistRevocationIntent(db, noteId);
  const future = `r-${aiNoteKey(noteId)}.${String(Date.now() + 60000).padStart(15, '0')}-abcdefabcdef`;
  writeFileSync(join(aiControlDir(db), future), '');
  revokeNoteConsent(db, noteId);
  assert.deepEqual(readdirSync(aiControlDir(db)).filter(name => name.startsWith('r-')), [future]);
  assert.equal(inferenceBlockReason(db, noteId), 'revocation_state_uncertain');
});

test('note IDs that differ only by case never share a marker on case-insensitive filesystems', t => {
  const { db } = setup(t, ['CaseNote', 'casenote']); // unique to this test
  db.exec(FAIL_REVOKE_TRIGGER);
  assert.throws(() => revokeNoteConsent(db, 'CaseNote'), error => error.code === 'AI_REVOCATION_NOT_PERSISTED');
  assert.equal(inferenceBlockReason(db, 'CaseNote'), 'revocation_state_uncertain');
  assert.equal(inferenceBlockReason(db, 'casenote'), null);
});

test('consent API revocation is replay-safe through the control plane and a pending intent rejects grant/request', t => {
  const { db, noteId } = setup(t);
  db.prepare("INSERT INTO sync_devices(id,label,token_hash,created_at,expires_at) VALUES('device-1','synthetic','h',1,9999999999999)").run();
  db.exec(FAIL_REVOKE_TRIGGER);
  const requestId = crypto.randomUUID();
  assert.throws(() => applyAiConsentOperation(db, noteId, { action: 'REVOKE', requestId, actorDeviceId: 'device-1', env: enabled }), error => error.code === 'AI_REVOCATION_NOT_PERSISTED');
  db.exec('DROP TRIGGER ai_test_fail_revoke');
  const live = db.prepare("SELECT server_version v,content_hash h FROM sync_entities WHERE id=?").get(noteId);
  assert.throws(() => applyAiConsentOperation(db, noteId, { action: 'GRANT', requestId: crypto.randomUUID(), actorDeviceId: 'device-1', expectedServerEpoch: serverMeta(db).serverEpoch, expectedServerVersion: live.v, expectedContentHash: live.h, env: enabled }), error => error.code === 'REVOCATION_PENDING');
  const retried = applyAiConsentOperation(db, noteId, { action: 'REVOKE', requestId, actorDeviceId: 'device-1', env: enabled });
  assert.equal(retried.state, 'REVOKED');
  assert.equal(applyAiConsentOperation(db, noteId, { action: 'REVOKE', requestId, actorDeviceId: 'device-1', env: enabled }).replayed, true);
  assert.throws(() => applyAiConsentOperation(db, noteId, { action: 'REVOKE', requestId, actorDeviceId: 'other-device', env: enabled }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(inferenceBlockReason(db, noteId), null);
});

test('stress: repeated cross-process revoke races never publish after a revoke attempt', async t => {
  const iterations = Number(process.env.NOTEOS_AI_SAFETY_ITERATIONS ?? 12);
  const ids = Array.from({ length: iterations }, (_, index) => `stress-${index}`);
  const { root, db } = setup(t, ids);
  const latencies = [];
  for (const [index, noteId] of ids.entries()) {
    enqueue(db, noteId);
    const worker = child('worker', root, [noteId, `stress-worker-${index}`]);
    await worker.waitFor('invoked');
    const failing = index % 2 === 0;
    if (failing) db.exec(FAIL_REVOKE_TRIGGER);
    const started = performance.now();
    try { revokeNoteConsent(db, noteId); assert.equal(failing, false); }
    catch (error) { assert.equal(failing, true); assert.equal(error.code, 'AI_REVOCATION_NOT_PERSISTED'); }
    const { result } = await worker.waitFor('result');
    latencies.push(performance.now() - started);
    await worker.exited;
    if (failing) db.exec('DROP TRIGGER ai_test_fail_revoke');
    assert.equal(result.status, 'aborted');
    assert.ok(['revocation_state_uncertain', 'job_no_longer_owned', 'consent_changed'].includes(result.reason), result.reason);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM ai_suggestions').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM ai_jobs WHERE status IN ('RUNNING','COMPLETED')").get().n, 0);
  assert.deepEqual(reconcileAiRevocationIntents(db).completed.sort(), ids.filter((_, index) => index % 2 === 0).sort());
  latencies.sort((a, b) => a - b);
  const pct = p => latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)];
  t.diagnostic(`revoke→worker-result latency ms (n=${latencies.length}, watchdog 50ms): p50=${pct(0.5).toFixed(1)} p95=${pct(0.95).toFixed(1)} max=${latencies.at(-1).toFixed(1)}`);
});

test('a claimed job is not dispatched when claim fencing itself cannot persist', async t => {
  const { db, noteId } = setup(t); enqueue(db, noteId);
  db.exec('PRAGMA query_only=ON');
  let invoked = 0;
  const result = await runOneAiJob(db, { workerId: 'worker-q', env: enabled, provider: createMockProvider({ output, onInvoke: () => invoked++ }) });
  db.exec('PRAGMA query_only=OFF');
  assert.deepEqual(result, { status: 'blocked', reason: 'claim_not_persisted', invoked: false });
  assert.equal(invoked, 0);
  assert.equal(claimAiJob(db, 'worker-q', {}).status, 'RUNNING', 'the queued job remains available once storage recovers');
});
