import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, serverMeta, transaction, appendChange } from './storage.mjs';
import { issuePairingCode, redeemPairingCode } from './auth.mjs';
import { handleSync } from './http.mjs';
import { handleAi } from './ai-http.mjs';
import { applyAiSchema, enqueueAiJob, grantNoteConsent, recoverExpiredAiJobs, runOneAiJob, revokeNoteConsent } from './ai-foundation.mjs';
import { createGatewayProvider, localGatewayConfigFromEnv } from './ai-provider-gateway.mjs';
import { aiStorageReport, backupAiStore, dropAiSchema, pruneAiRetention } from './ai-maintenance.mjs';
import { startFakeGateway } from './ai-eval/fake-gateway.mjs';
import { SYNTHETIC_NOTES, syntheticNoteRecord } from './ai-eval/synthetic-notes.mjs';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';

const origin = 'http://127.0.0.1:15700';
const localEnv = gatewayOrigin => ({
  NOTEOS_AI_ORGANIZE_ENABLED: '1', NOTEOS_AI_INFERENCE_ENABLED: '1', NODE_ENV: 'production', NOTEOS_AI_LOCAL_PROVIDER_ENABLED: '1',
  NOTEOS_AI_GATEWAY_URL: gatewayOrigin, NOTEOS_AI_GATEWAY_PROVIDER: 'ollama', NOTEOS_AI_GATEWAY_MODEL: 'synthetic-local-8b',
  NOTEOS_AI_LOCAL_ATTESTATION: 'synthetic:2026-10-28', NOTEOS_AI_GATEWAY_TIMEOUT_MS: '5000',
});

function store(t, notes = []) {
  const root = mkdtempSync(join(tmpdir(), 'noteos-ai-reliability-'));
  const db = openStore(root, { initialize: true }); applyAiSchema(db);
  writeFileSync(join(root, '.sync-epoch'), serverMeta(db).serverEpoch, { mode: 0o600 });
  for (const note of notes) transaction(db, () => {
    const json = canonicalJson(note), content = { ...note }; delete content.revision; delete content.createdAt; delete content.updatedAt;
    const hash = createHash('sha256').update(canonicalJson(content)).digest('hex');
    const cursor = appendChange(db, 'note', note.id, 1, 'upsert', json);
    db.prepare("INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES('note',?,1,?,?,?,0,?)").run(note.id, json, hash, note.lifecycle, cursor);
  });
  t.after(() => { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, db };
}
async function gateway(t, options) { const fake = await startFakeGateway(options); t.after(() => fake.close()); return fake; }
const notes = n => SYNTHETIC_NOTES.filter(row => !row.gold.insufficient).slice(0, n).map(row => syntheticNoteRecord(row));
function prepare(db, env, records) { for (const note of records) { grantNoteConsent(db, note.id, { providerBoundary: 'STRICT_LOCAL', env }); enqueueAiJob(db, note.id, { serverVersion: 1, env }); } }

test('crash/restart: a worker process killed mid-inference loses its lease; a restarted worker completes exactly once', async t => {
  const fake = await gateway(t, { latencyMs: index => (index === 0 ? 60000 : 20) });
  const env = localEnv(fake.origin), [note] = notes(1), { root, db } = store(t, [note]);
  prepare(db, env, [note]);
  const script = `import { openStore } from './sync-server/storage.mjs'; import { runOneAiJob } from './sync-server/ai-foundation.mjs'; import { createGatewayProvider, localGatewayConfigFromEnv } from './sync-server/ai-provider-gateway.mjs';
    const db = openStore(process.argv[1]); const config = localGatewayConfigFromEnv(process.env);
    await runOneAiJob(db, { workerId: 'doomed', provider: createGatewayProvider(config), env: process.env, leaseMs: 2000, timeoutMs: 60000 });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: 'ignore' });
  for (let i = 0; i < 200 && !fake.requests.some(row => row.path === '/v1/chat/completions'); i++) await new Promise(resolve => setTimeout(resolve, 25));
  child.kill('SIGKILL');
  await new Promise(resolve => child.on('exit', resolve));
  assert.equal(db.prepare('SELECT status FROM ai_jobs').get().status, 'RUNNING', 'the killed worker left a leased job behind');
  const leaseUntil = db.prepare('SELECT lease_until l FROM ai_jobs').get().l;
  assert.deepEqual(recoverExpiredAiJobs(db, { now: leaseUntil }).map(row => row.status), ['QUEUED']);
  const runAfter = db.prepare('SELECT run_after r FROM ai_jobs').get().r;
  const result = await runOneAiJob(db, { workerId: 'restarted', provider: createGatewayProvider(localGatewayConfigFromEnv(env)), env, now: runAfter });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(db.prepare('SELECT count(*) n FROM ai_suggestions').get().n, 1);
  assert.equal(db.prepare('SELECT attempts FROM ai_jobs').get().attempts, 2);
});

test('network loss: gateway down → bounded retry; gateway back → the same job completes; nothing else is contacted', async t => {
  const first = await startFakeGateway(); const port = first.port; await first.close();
  const env = localEnv(`http://127.0.0.1:${port}`), [note] = notes(1), { db } = store(t, [note]);
  prepare(db, env, [note]);
  const down = await runOneAiJob(db, { workerId: 'w', provider: createGatewayProvider(localGatewayConfigFromEnv(env)), env });
  assert.equal(down.status, 'QUEUED');
  const fake = await gateway(t, { port });
  const up = await runOneAiJob(db, { workerId: 'w', provider: createGatewayProvider(localGatewayConfigFromEnv(env)), env, now: down.runAfter });
  assert.equal(up.status, 'COMPLETED');
  assert.equal(fake.requests.filter(row => row.path === '/v1/chat/completions').length, 1);
});

test('malformed provider output (prose instead of JSON) dead-letters for review without publishing', async t => {
  const fake = await gateway(t, { fault: () => 'prose' });
  const env = localEnv(fake.origin), [note] = notes(1), { db } = store(t, [note]);
  prepare(db, env, [note]);
  const result = await runOneAiJob(db, { workerId: 'w', provider: createGatewayProvider(localGatewayConfigFromEnv(env)), env });
  assert.deepEqual(result, { status: 'FAILED_NEEDS_REVIEW', invoked: true, reason: 'invalid_provider_output' });
  assert.equal(db.prepare('SELECT count(*) n FROM ai_suggestions').get().n, 0);
});

test('duplicate work: repeated requests dedupe to one job and three concurrent worker processes never double-process', async t => {
  const fake = await gateway(t, { latencyMs: 30 });
  const env = localEnv(fake.origin), records = notes(9), { root, db } = store(t, records);
  prepare(db, env, records);
  for (const note of records) assert.equal(enqueueAiJob(db, note.id, { serverVersion: 1, env }).reused, true);
  const run = promisify(execFile);
  await Promise.all([1, 2, 3].map(() => run(process.execPath, ['sync-server/ai-worker.mjs', '--drain', '--max', '20'], { cwd: process.cwd(), env: { ...process.env, ...env, NOTEOS_SYNC_STORAGE: root } })));
  assert.equal(db.prepare("SELECT count(*) n FROM ai_jobs WHERE status='COMPLETED'").get().n, 9);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_suggestions').get().n, 9);
  assert.equal(db.prepare('SELECT count(DISTINCT job_id) n FROM ai_suggestions').get().n, 9);
  assert.equal(fake.requests.filter(row => row.path === '/v1/chat/completions').length, 9, 'no job was sent to the model twice');
});

test('audit log records every transition with metadata only — no note text, titles or model output', async t => {
  const fake = await gateway(t);
  const env = localEnv(fake.origin), records = notes(3), { db } = store(t, records);
  prepare(db, env, records);
  for (let i = 0; i < 3; i++) await runOneAiJob(db, { workerId: 'w', provider: createGatewayProvider(localGatewayConfigFromEnv(env)), env });
  revokeNoteConsent(db, records[0].id);
  const actions = db.prepare('SELECT action,count(*) n FROM ai_audit_log GROUP BY action').all().map(row => `${row.action}:${row.n}`).sort();
  assert.deepEqual(actions, ['CONSENT_GRANTED:3', 'CONSENT_REVOKED:1', 'JOB_CLAIMED:3', 'JOB_COMPLETED:3', 'JOB_ENQUEUED:3']);
  const audit = JSON.stringify(db.prepare('SELECT * FROM ai_audit_log').all());
  for (const note of records) { assert.equal(audit.includes(note.title), false); assert.equal(audit.includes(JSON.stringify(note.document).slice(60, 90)), false); }
});

test('storage quota report and explicit retention never touch pending reviews, active jobs, consent or Sync data', async t => {
  const fake = await gateway(t);
  const env = localEnv(fake.origin), records = notes(4), { db } = store(t, records);
  prepare(db, env, records);
  for (let i = 0; i < 3; i++) await runOneAiJob(db, { workerId: 'w', provider: createGatewayProvider(localGatewayConfigFromEnv(env)), env });
  const [decided] = db.prepare('SELECT id FROM ai_suggestions ORDER BY created_at').all();
  db.prepare("UPDATE ai_suggestions SET status='REJECTED',updated_at=1 WHERE id=?").run(decided.id);
  db.prepare("UPDATE ai_audit_log SET created_at=1 WHERE id IN (SELECT id FROM ai_audit_log ORDER BY id LIMIT 2)").run();
  const syncBefore = JSON.stringify(['sync_entities', 'sync_changelog', 'sync_server_meta'].map(name => db.prepare(`SELECT * FROM ${name}`).all()));
  const report = aiStorageReport(db);
  assert.equal(report.caps.ai_jobs.rows, 4); assert.equal(report.jobs.QUEUED, 1); assert.equal(report.jobs.COMPLETED, 3); assert.deepEqual(report.warnings, []);
  const dry = pruneAiRetention(db, { now: Date.now() });
  assert.equal(dry.dryRun, true); assert.equal(dry.purgedDecidedPayloads, 1); assert.equal(dry.deletedAuditRows, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM ai_suggestions WHERE payload_json<>'{}'").get().n, 3, 'dry run changes nothing');
  const applied = pruneAiRetention(db, { now: Date.now(), dryRun: false });
  assert.equal(applied.purgedDecidedPayloads, 1); assert.equal(applied.deletedAuditRows, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM ai_suggestions WHERE status='PENDING_REVIEW' AND payload_json<>'{}'").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM ai_jobs WHERE status='QUEUED'").get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_note_consent').get().n, 4);
  assert.equal(JSON.stringify(['sync_entities', 'sync_changelog', 'sync_server_meta'].map(name => db.prepare(`SELECT * FROM ${name}`).all())), syncBefore);
  assert.throws(() => pruneAiRetention(db, { retentionDays: 1 }), /reviewed minimum/);
});

test('rollback rehearsal: backup → AI-only drop keeps Sync intact and working; restoring the backup restores AI state', async t => {
  const fake = await gateway(t);
  const env = localEnv(fake.origin), records = notes(2), { root, db } = store(t, records);
  prepare(db, env, records);
  await runOneAiJob(db, { workerId: 'w', provider: createGatewayProvider(localGatewayConfigFromEnv(env)), env });
  const backup = backupAiStore(db, join(root, 'pre-rollback-backup.sqlite'));
  assert.throws(() => backupAiStore(db, backup), /new \.sqlite path/);
  const syncBefore = JSON.stringify(['sync_entities', 'sync_changelog', 'sync_server_meta', 'sync_devices'].map(name => db.prepare(`SELECT * FROM ${name}`).all()));
  assert.throws(() => dropAiSchema(db, {}), /confirmation/);
  dropAiSchema(db, { confirm: 'DROP_AI_SIDECAR_ONLY' });
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'ai_%' AND type='table'").get().n, 0);
  assert.equal(JSON.stringify(['sync_entities', 'sync_changelog', 'sync_server_meta', 'sync_devices'].map(name => db.prepare(`SELECT * FROM ${name}`).all())), syncBefore);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  const restored = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(restored.prepare('SELECT count(*) n FROM ai_suggestions').get().n, 1);
    assert.equal(restored.prepare('SELECT max(version) v FROM ai_schema_migrations').get().v, 4);
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { restored.close(); }
});

test('AI OFF: Text Sync push/pull behave identically with AI tables present, and AI routes/worker stay closed', async t => {
  const { root, db } = store(t);
  const fake = await gateway(t);
  const offEnv = { NOTEOS_SYNC_ENABLED: '1', NOTEOS_SYNC_STORAGE: root, NOTEOS_SYNC_ALLOWED_ORIGINS: origin };
  const device = redeemPairingCode(db, issuePairingCode(db), 'ai-off-device');
  const note = syntheticNoteRecord(SYNTHETIC_NOTES[0]);
  const request = (path, body) => new Request(`${origin}/api/v1/sync/${path}`, { method: 'POST', headers: { host: '127.0.0.1:15700', origin, 'content-type': 'application/json', 'x-noteos-sync': '1', cookie: `noteos_sync_local=${device.token}` }, body: JSON.stringify(body) });
  const push = await handleSync(request('push', { protocolVersion: 1, operations: [{ operationId: 'ai-off-op-00000001', entityId: note.id, baseServerVersion: 0, ownerApproved: true, recordingCount: 0, type: 'upsert', recordJson: canonicalJson(note) }] }), 'push', offEnv);
  assert.equal(push.status, 200); assert.equal((await push.json()).acknowledgements[0].serverVersion, 1);
  const pull = await (await handleSync(request('pull', { protocolVersion: 1, cursor: 0, limit: 100 }), 'pull', offEnv)).json();
  assert.equal(pull.changes[0].recordJson, canonicalJson(note));
  assert.equal(db.prepare('SELECT count(*) n FROM ai_jobs').get().n, 0, 'a Text Sync push never creates AI work');
  const ai = await handleAi(new Request(`${origin}/api/v1/ai/status`, { headers: { host: '127.0.0.1:15700', origin } }), 'status', offEnv);
  assert.equal(ai.status, 503);
  assert.deepEqual(await runOneAiJob(db, { workerId: 'w', provider: createGatewayProvider(localGatewayConfigFromEnv(localEnv(fake.origin))), env: offEnv }), { status: 'disabled', invoked: false });
  assert.equal(fake.requests.length, 0);
});

test('security matrix for inbox routes: origin, CSRF, content type, size, query strings, traversal and cookie scope', async t => {
  const { root, db } = store(t);
  const env = { NODE_ENV: 'test', NOTEOS_SYNC_ENABLED: '1', NOTEOS_AI_ORGANIZE_ENABLED: '1', NOTEOS_SYNC_STORAGE: root, NOTEOS_SYNC_ALLOWED_ORIGINS: origin };
  const device = redeemPairingCode(db, issuePairingCode(db), 'security-device');
  const id = crypto.randomUUID(), decision = { protocolVersion: 1, requestId: crypto.randomUUID(), itemKey: 'tag:0', decision: 'REJECTED', expectedVersion: 0, appliedLocalRevision: null };
  const call = async (path, { method = 'GET', body, headers = {}, cookie = `noteos_ai_local=${device.token}`, from = origin } = {}) => {
    const h = new Headers({ host: '127.0.0.1:15700', origin: from, 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}), ...headers });
    const response = await handleAi(new Request(`${origin}/api/v1/ai/${path}`, { method, headers: h, ...(body !== undefined ? { body } : {}) }), path.split('?')[0], env);
    return response.status;
  };
  const json = { 'content-type': 'application/json', 'x-noteos-ai': '1' };
  assert.equal(await call('suggestions', { from: 'https://evil.example' }), 403);
  assert.equal(await call('suggestions', { cookie: `noteos_sync_local=${device.token}` }), 401, 'the Sync-path cookie is not an AI session');
  assert.equal(await call('suggestions?limit=1000'), 400);
  assert.equal(await call('suggestions/notes/..%2F..%2Fetc'), 404);
  assert.equal(await call(`suggestions/${id}/decisions`, { method: 'POST', body: JSON.stringify(decision), headers: { 'content-type': 'application/json' } }), 403, 'missing CSRF header');
  assert.equal(await call(`suggestions/${id}/decisions`, { method: 'POST', body: JSON.stringify(decision), headers: { 'content-type': 'text/plain', 'x-noteos-ai': '1' } }), 403);
  assert.equal(await call(`suggestions/${id}/decisions`, { method: 'POST', body: 'x'.repeat(5000), headers: json }), 413);
  assert.equal(await call(`suggestions/${id}/decisions`, { method: 'POST', body: '{not json', headers: json }), 400);
  assert.equal(await call(`suggestions/${id}/decisions`, { method: 'POST', body: JSON.stringify({ ...decision, itemKey: '../x' }), headers: json }), 400);
  assert.equal(await call(`suggestions/${id}/decisions`, { method: 'POST', body: JSON.stringify(decision), headers: json }), 404, 'unknown suggestion');
});
