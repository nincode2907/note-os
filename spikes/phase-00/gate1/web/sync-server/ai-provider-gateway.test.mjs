import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, serverMeta, transaction, appendChange } from './storage.mjs';
import { applyAiSchema, enqueueAiJob, grantNoteConsent, runOneAiJob, validateAiSuggestion, createMockProvider } from './ai-foundation.mjs';
import {
  GatewayError, aiExecutionProfile, buildOrganizeMessages, checkGatewayHealth, createGatewayProvider,
  extractJsonObject, localGatewayConfigFromEnv, normalizeOrganizeOutput,
} from './ai-provider-gateway.mjs';
import { startFakeGateway } from './ai-eval/fake-gateway.mjs';
import { SYNTHETIC_NOTES, syntheticNoteRecord } from './ai-eval/synthetic-notes.mjs';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';

const localEnv = origin => ({
  NOTEOS_AI_ORGANIZE_ENABLED: '1', NOTEOS_AI_INFERENCE_ENABLED: '1', NODE_ENV: 'production',
  NOTEOS_AI_LOCAL_PROVIDER_ENABLED: '1', NOTEOS_AI_GATEWAY_URL: origin, NOTEOS_AI_GATEWAY_PROVIDER: 'ollama',
  NOTEOS_AI_GATEWAY_MODEL: 'synthetic-local-8b', NOTEOS_AI_LOCAL_ATTESTATION: 'owner:2026-10-28', NOTEOS_AI_GATEWAY_TIMEOUT_MS: '2000',
});
const entry = id => SYNTHETIC_NOTES.find(row => row.id === id);

async function gateway(t, options) {
  const fake = await startFakeGateway(options);
  t.after(() => fake.close());
  return fake;
}

function store(t, notes) {
  const root = mkdtempSync(join(tmpdir(), 'noteos-ai-gateway-'));
  const db = openStore(root, { initialize: true }); applyAiSchema(db);
  writeFileSync(join(root, '.sync-epoch'), serverMeta(db).serverEpoch, { mode: 0o600 });
  for (const note of notes) transaction(db, () => {
    const json = canonicalJson(note), content = { ...note };
    delete content.revision; delete content.createdAt; delete content.updatedAt;
    const hash = createHash('sha256').update(canonicalJson(content)).digest('hex');
    const cursor = appendChange(db, 'note', note.id, 1, 'upsert', json);
    db.prepare("INSERT INTO sync_entities(entity_type,id,server_version,record_json,content_hash,lifecycle,recording_count,committed_cursor) VALUES('note',?,1,?,?,?,0,?)").run(note.id, json, hash, note.lifecycle, cursor);
  });
  t.after(() => { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return db;
}

test('local gateway configuration fails closed: cloud provider, remote origin, missing model or attestation', () => {
  const base = localEnv('http://127.0.0.1:15600');
  assert.equal(localGatewayConfigFromEnv({}), null);
  assert.equal(localGatewayConfigFromEnv(base).identity, 'gateway:ollama:synthetic-local-8b');
  for (const [key, value, pattern] of [
    ['NOTEOS_AI_GATEWAY_PROVIDER', 'codex', /Cloud gateway providers/],
    ['NOTEOS_AI_GATEWAY_PROVIDER', '', /explicit local gateway provider/],
    ['NOTEOS_AI_GATEWAY_MODEL', '', /explicit gateway model/],
    ['NOTEOS_AI_GATEWAY_URL', 'https://api.example.com', /loopback origin/],
    ['NOTEOS_AI_GATEWAY_URL', 'http://192.168.1.20:15600', /loopback origin/],
    ['NOTEOS_AI_GATEWAY_URL', 'http://user:pw@127.0.0.1:15600', /loopback origin/],
    ['NOTEOS_AI_GATEWAY_URL', 'http://127.0.0.1:15600/v1', /loopback origin/],
    ['NOTEOS_AI_GATEWAY_URL', 'http://host.docker.internal:15600', /loopback origin/],
    ['NOTEOS_AI_LOCAL_ATTESTATION', '', /attestation/],
  ]) assert.throws(() => localGatewayConfigFromEnv({ ...base, [key]: value }), pattern, `${key}=${value}`);
  assert.equal(localGatewayConfigFromEnv({ ...base, NOTEOS_AI_GATEWAY_URL: 'http://host.docker.internal:15600', NOTEOS_AI_GATEWAY_ALLOW_DOCKER_HOST: '1' }).origin, 'http://host.docker.internal:15600');
  assert.deepEqual(aiExecutionProfile({}), { executionBoundary: 'MOCK', modelIdentity: 'mock-v1', localExecutionAttested: false });
  assert.deepEqual(aiExecutionProfile({ ...base, NOTEOS_AI_GATEWAY_PROVIDER: 'codex' }), { executionBoundary: 'MOCK', modelIdentity: 'mock-v1', localExecutionAttested: false }, 'an unsafe profile never upgrades the boundary');
  assert.equal(aiExecutionProfile(base).executionBoundary, 'STRICT_LOCAL');
});

test('health check requires the configured model on the configured local backend and rejects remote models', async t => {
  const fake = await gateway(t, { models: [{ id: 'synthetic-local-8b', provider: 'ollama', state: 'available' }, { id: 'remote-ollama', provider: 'ollama', state: 'remote' }] });
  const config = localGatewayConfigFromEnv(localEnv(fake.origin));
  assert.equal((await checkGatewayHealth(config)).model, 'synthetic-local-8b');
  await assert.rejects(checkGatewayHealth({ ...config, model: 'remote-ollama' }), error => error.code === 'gateway_model_is_remote');
  await assert.rejects(checkGatewayHealth({ ...config, model: 'missing' }), error => error.code === 'gateway_model_not_found');
  await assert.rejects(checkGatewayHealth({ ...config, provider: 'lmstudio' }), error => error.code === 'gateway_provider_disabled');
  assert.ok(fake.requests.every(request => request.path === '/v1/models'), 'health never runs inference');
});

test('the outbound prompt carries only title, tags and text as delimited data, with explicit provider/model and no fallback fields', async t => {
  const fake = await gateway(t);
  const config = localGatewayConfigFromEnv({ ...localEnv(fake.origin), NOTEOS_AI_GATEWAY_HOST_HEADER: 'codex-server.localhost', NOTEOS_AI_GATEWAY_API_KEY: 'synthetic-key' });
  const note = syntheticNoteRecord(entry('en-01'));
  const messages = buildOrganizeMessages(note);
  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /^NOTE_DATA_BEGIN\n\{"title":/);
  assert.doesNotMatch(messages[1].content, /PRIVATE_SERVER|synthetic-en-01|revision|privacy/);
  const output = await createGatewayProvider(config).analyze({ note });
  assert.doesNotThrow(() => validateAiSuggestion(output, note));
  const sent = fake.requests.at(-1);
  assert.deepEqual(sent.body.keys, ['max_tokens', 'messages', 'model', 'provider', 'seed', 'stream']);
  assert.equal(sent.body.provider, 'ollama'); assert.equal(sent.body.model, 'synthetic-local-8b');
  assert.equal(sent.headers.host, 'codex-server.localhost'); assert.equal(sent.headers.authorization, 'present');
});

test('transport faults are classified: timeout, 5xx and 429 are transient; 4xx, redirect, oversize and invalid body are not retried as success', async t => {
  const modes = ['hang', 'error500', 'rate429', 'bad400', 'redirect', 'huge', 'invalidBody'];
  const fake = await gateway(t, { fault: index => modes[index] ?? null });
  const config = { ...localGatewayConfigFromEnv(localEnv(fake.origin)), timeoutMs: 300 };
  const provider = createGatewayProvider(config);
  const note = syntheticNoteRecord(entry('vi-01'));
  const outcomes = [];
  for (const mode of modes) {
    try { await provider.analyze({ note }); outcomes.push([mode, 'resolved']); }
    catch (error) { assert.ok(error instanceof GatewayError); outcomes.push([mode, error.code, error.transient]); }
  }
  assert.deepEqual(outcomes, [
    ['hang', 'gateway_timeout', true], ['error500', 'gateway_unavailable', true], ['rate429', 'gateway_unavailable', true],
    ['bad400', 'gateway_invalid_request_error', false], ['redirect', 'gateway_redirect_refused', false],
    ['huge', 'gateway_response_too_large', false], ['invalidBody', 'gateway_invalid_json', false],
  ]);
  assert.equal(fake.requests.filter(request => request.path !== '/v1/chat/completions').length, 0, 'no alternate endpoint or provider is ever tried');
});

test('an unreachable gateway is a transient error and no other origin is contacted', async t => {
  const fake = await gateway(t); const origin = fake.origin; await fake.close();
  const provider = createGatewayProvider(localGatewayConfigFromEnv(localEnv(origin)));
  await assert.rejects(provider.analyze({ note: syntheticNoteRecord(entry('en-02')) }), error => error.code === 'gateway_unreachable' && error.transient);
});

test('an abort signal cancels the in-flight HTTP request', async t => {
  const fake = await gateway(t, { fault: () => 'hang' });
  const provider = createGatewayProvider(localGatewayConfigFromEnv(localEnv(fake.origin)));
  const controller = new AbortController();
  const pending = provider.analyze({ note: syntheticNoteRecord(entry('ja-01')) }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  await assert.rejects(pending, error => error.code === 'gateway_aborted');
  assert.ok(Date.now() - started < 1000);
});

test('normalization only removes: ungrounded, unsafe, duplicate and related items are dropped and counted', () => {
  const note = syntheticNoteRecord(entry('en-04'));
  const { output, dropped } = normalizeOrganizeOutput({
    categorySuggestion: { label: 'Travel', sourceQuote: 'Five days in Lisbon' },
    tagCandidates: [{ label: 'Lisbon', sourceQuote: 'Lisbon' }, { label: 'lisbon', sourceQuote: 'Lisbon' }, { label: 'Paris', sourceQuote: 'Paris' }, { label: '<i>x</i>', sourceQuote: 'Lisbon' }],
    shortSummary: 'See https://example.com', taskCandidates: [{ text: 'Book flights', sourceQuote: 'Book flights before the price increase' }],
    relatedCandidates: [{ id: 'x', reason: 'title_match' }], insufficientContext: false, uncertainty: 3, extra: 1,
  }, note);
  assert.deepEqual(output.tagCandidates, [{ label: 'Lisbon', sourceQuote: 'Lisbon' }]);
  assert.equal(output.shortSummary, null); assert.equal(output.uncertainty, 1); assert.deepEqual(output.relatedCandidates, []);
  assert.equal(dropped, 5);
  assert.doesNotThrow(() => validateAiSuggestion(output, note));
  assert.equal(extractJsonObject('prose only'), null);
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
});

test('STRICT_LOCAL end to end: attested gateway job completes outside test mode while the Mock stays refused', async t => {
  const fake = await gateway(t);
  const env = localEnv(fake.origin);
  const note = syntheticNoteRecord(entry('vi-02'));
  const db = store(t, [note]);
  assert.equal(grantNoteConsent(db, note.id, { state: 'APPROVED_LOCAL_ONLY', providerBoundary: 'STRICT_LOCAL', env }).providerBoundary, 'STRICT_LOCAL');
  const job = enqueueAiJob(db, note.id, { serverVersion: 1, env });
  assert.deepEqual({ ...db.prepare('SELECT model_identity m,execution_boundary b FROM ai_jobs WHERE id=?').get(job.id) }, { m: 'gateway:ollama:synthetic-local-8b', b: 'STRICT_LOCAL' });
  assert.deepEqual(await runOneAiJob(db, { workerId: 'mock', provider: createMockProvider({ output: {} }), env }), { status: 'mock_provider_test_only', invoked: false });
  const metrics = [];
  const result = await runOneAiJob(db, { workerId: 'local-1', provider: createGatewayProvider(localGatewayConfigFromEnv(env), { onMetrics: value => metrics.push(value) }), env });
  assert.equal(result.status, 'COMPLETED');
  const suggestion = db.prepare('SELECT payload_json p,provider_identity i,status FROM ai_suggestions').get();
  assert.equal(suggestion.i, 'gateway:ollama:synthetic-local-8b'); assert.equal(suggestion.status, 'PENDING_REVIEW');
  assert.ok(JSON.parse(suggestion.p).taskCandidates.length >= 1);
  assert.equal(metrics.length, 1); assert.equal(metrics[0].outcome, 'ok'); assert.ok(metrics[0].promptTokens > 0);
});

test('local provider is refused without attestation, with a mismatched identity, or for a Mock-boundary consent', async t => {
  const fake = await gateway(t);
  const env = localEnv(fake.origin);
  const note = syntheticNoteRecord(entry('en-05'));
  const db = store(t, [note]);
  grantNoteConsent(db, note.id, { state: 'APPROVED_LOCAL_ONLY', providerBoundary: 'MOCK', env });
  assert.throws(() => enqueueAiJob(db, note.id, { serverVersion: 1, env }), error => error.reason === 'local_execution_not_proven', 'MOCK consent never authorizes a real local model');
  const provider = createGatewayProvider(localGatewayConfigFromEnv(env));
  const { NOTEOS_AI_LOCAL_ATTESTATION, ...unattested } = env;
  assert.equal((await runOneAiJob(db, { workerId: 'w', provider, env: unattested })).status, 'local_execution_not_proven');
  assert.equal((await runOneAiJob(db, { workerId: 'w', provider: { ...provider, identity: 'gateway:ollama:other' }, env })).status, 'local_execution_not_proven');
  assert.equal((await runOneAiJob(db, { workerId: 'w', provider: { ...provider, executionBoundary: 'EXTERNAL_CLOUD' }, env })).status, 'provider_rejected');
  assert.equal(fake.requests.length, 0);
});

test('privacy: DEVICE_ONLY and unconsented notes never reach the gateway', async t => {
  const fake = await gateway(t);
  const env = localEnv(fake.origin);
  const deviceOnly = syntheticNoteRecord(entry('en-06'), { privacy: 'DEVICE_ONLY' });
  const unconsented = syntheticNoteRecord(entry('en-10'));
  const db = store(t, [deviceOnly, unconsented]);
  assert.throws(() => grantNoteConsent(db, deviceOnly.id, { providerBoundary: 'STRICT_LOCAL', env }), error => error.code === 'DEVICE_ONLY');
  assert.equal(db.prepare('SELECT count(*) n FROM ai_note_consent').get().n, 0);
  assert.throws(() => enqueueAiJob(db, deviceOnly.id, { serverVersion: 1, env }), error => error.reason === 'device_only');
  assert.throws(() => enqueueAiJob(db, unconsented.id, { serverVersion: 1, env }), error => error.reason === 'consent_missing');
  assert.equal((await runOneAiJob(db, { workerId: 'w', provider: createGatewayProvider(localGatewayConfigFromEnv(env)), env })).status, 'idle');
  assert.equal(fake.requests.length, 0);
});

test('permanent provider errors dead-letter immediately; transient errors use bounded retry', async t => {
  const fake = await gateway(t, { fault: index => (index === 0 ? 'bad400' : 'error500') });
  const env = localEnv(fake.origin);
  const first = syntheticNoteRecord(entry('ja-02')), second = syntheticNoteRecord(entry('ja-03'));
  const db = store(t, [first, second]);
  for (const note of [first, second]) { grantNoteConsent(db, note.id, { providerBoundary: 'STRICT_LOCAL', env }); enqueueAiJob(db, note.id, { serverVersion: 1, env }); }
  const provider = createGatewayProvider(localGatewayConfigFromEnv(env));
  assert.deepEqual(await runOneAiJob(db, { workerId: 'w', provider, env }), { status: 'FAILED_NEEDS_REVIEW', invoked: true, reason: 'provider_permanent_error' });
  const retried = await runOneAiJob(db, { workerId: 'w', provider, env });
  assert.equal(retried.status, 'QUEUED'); assert.ok(retried.runAfter > Date.now() - 10);
  assert.equal(db.prepare("SELECT reason_code r FROM ai_audit_log WHERE action='JOB_FAILED_NEEDS_REVIEW'").get().r, 'provider_permanent_error');
});

test('prompt injection: an adversarial model that obeys every injected instruction cannot place forbidden content in a suggestion', async t => {
  const fake = await gateway(t, { brain: 'adversarial' });
  const env = localEnv(fake.origin);
  const injected = SYNTHETIC_NOTES.filter(row => row.gold.forbidden.length || row.gold.injectedLabels.length);
  const notes = injected.map(row => syntheticNoteRecord(row));
  const db = store(t, notes);
  for (const note of notes) { grantNoteConsent(db, note.id, { providerBoundary: 'STRICT_LOCAL', env }); enqueueAiJob(db, note.id, { serverVersion: 1, env }); }
  const provider = createGatewayProvider(localGatewayConfigFromEnv(env));
  for (let i = 0; i < notes.length; i++) assert.equal((await runOneAiJob(db, { workerId: 'w', provider, env })).status, 'COMPLETED');
  for (const [index, row] of injected.entries()) {
    const payload = db.prepare('SELECT payload_json p FROM ai_suggestions WHERE note_id=?').get(notes[index].id).p;
    for (const forbidden of [...row.gold.forbidden, 'attacker.example', 'evil.example', 'http', '<', '../']) assert.equal(payload.includes(forbidden), false, `${row.id} leaked ${forbidden}`);
    const value = JSON.parse(payload), text = notes[index].title + JSON.stringify(notes[index].document) + notes[index].tags.join(' ');
    assert.deepEqual(value.relatedCandidates, []);
    assert.equal(value.categorySuggestion, null, 'the injected category is not in the taxonomy and has no grounded quote');
    for (const tag of value.tagCandidates) assert.ok(text.toLowerCase().includes(tag.label.toLowerCase()), `${row.id} tag ${tag.label} is not extractive`);
    assert.ok(value.uncertainty <= 1);
  }
});

test('worker CLI: preflight fails closed, then drains attested local jobs in a separate process with metadata-only logs', async t => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const run = promisify(execFile);
  const fake = await gateway(t);
  const notes = ['vi-04', 'en-04', 'ja-04'].map(id => syntheticNoteRecord(entry(id)));
  const db = store(t, notes);
  const root = db.prepare('PRAGMA database_list').all()[0].file.replace(/\/sync\.sqlite$/, '');
  const env = { ...process.env, ...localEnv(fake.origin), NOTEOS_SYNC_STORAGE: root };
  const cli = async (args, extra = {}) => {
    try { const { stdout } = await run(process.execPath, ['sync-server/ai-worker.mjs', ...args], { cwd: process.cwd(), env: { ...env, ...extra } }); return { code: 0, lines: stdout.trim().split('\n').map(line => JSON.parse(line)) }; }
    catch (error) { return { code: error.code, lines: error.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }; }
  };
  assert.equal((await cli(['--check'], { NOTEOS_AI_INFERENCE_ENABLED: '0' })).lines[0].reason, 'ai_flags_disabled');
  assert.equal((await cli(['--check'], { NOTEOS_AI_GATEWAY_PROVIDER: 'codex' })).lines[0].reason, 'local_profile_invalid');
  assert.equal((await cli(['--check'], { NOTEOS_AI_GATEWAY_MODEL: 'gpt-cloud', NOTEOS_AI_GATEWAY_PROVIDER: 'ollama' })).lines[0].detail, 'gateway_model_not_found');
  const ok = await cli(['--check']);
  assert.equal(ok.code, 0); assert.equal(ok.lines[0].ok, true); assert.equal(ok.lines[0].config, undefined, 'configuration and keys are never logged');
  for (const note of notes) { grantNoteConsent(db, note.id, { providerBoundary: 'STRICT_LOCAL', env }); enqueueAiJob(db, note.id, { serverVersion: 1, env }); }
  const drained = await cli(['--drain', '--max', '10']);
  assert.equal(drained.code, 0);
  assert.deepEqual(drained.lines.filter(line => line.event === 'job').map(line => line.status), ['COMPLETED', 'COMPLETED', 'COMPLETED', 'idle']);
  const output = JSON.stringify(drained.lines);
  for (const note of notes) { assert.equal(output.includes(note.title), false); assert.equal(output.includes(note.id), false); }
  assert.equal(db.prepare("SELECT count(*) n FROM ai_suggestions WHERE status='PENDING_REVIEW'").get().n, 3);
  writeFileSync(join(root, 'ai-control', 'INFERENCE_STOP'), '');
  assert.equal((await cli(['--once'])).lines[0].reason, 'inference_stopped');
});
