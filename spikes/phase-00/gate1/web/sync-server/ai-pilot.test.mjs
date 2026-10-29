import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, serverMeta, transaction, appendChange } from './storage.mjs';
import { grantNoteConsent, revokeNoteConsent, applyAiSchema } from './ai-foundation.mjs';
import { migrateAi } from './ai-migrate.mjs';
import { pilotPreflight } from './ai-pilot-preflight.mjs';
import { startFakeGateway } from './ai-eval/fake-gateway.mjs';
import { SYNTHETIC_NOTES, syntheticNoteRecord } from './ai-eval/synthetic-notes.mjs';
import { canonicalJson } from '../app/lib/sync-protocol.mjs';

function store(t, notes = []) {
  const root = mkdtempSync(join(tmpdir(), 'noteos-ai-pilot-'));
  const db = openStore(root, { initialize: true });
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
const env = { NOTEOS_AI_ORGANIZE_ENABLED: '1', NOTEOS_AI_INFERENCE_ENABLED: '1', NODE_ENV: 'test' };
const records = n => SYNTHETIC_NOTES.slice(0, n).map(row => syntheticNoteRecord(row));

test('migration is dry-run by default and refuses to apply without explicit confirmation and a verified backup', t => {
  const { root, db } = store(t, records(1));
  const syncBefore = JSON.stringify(db.prepare('SELECT * FROM sync_entities').all());
  assert.deepEqual(migrateAi({ storage: root }), { syncSchemaVersion: 2, aiLedgerVersion: 0, targetAiLedgerVersion: 4, audioMigrationTouched: false, action: 'dry_run' });
  assert.equal(migrateAi({ storage: root, apply: true }).reason, 'confirmation_required');
  assert.equal(migrateAi({ storage: root, apply: true, confirm: 'AI_LEDGER_V4' }).reason, 'backup_missing');
  const garbage = join(root, 'garbage.sqlite'); writeFileSync(garbage, 'not a database');
  assert.throws(() => migrateAi({ storage: root, apply: true, confirm: 'AI_LEDGER_V4', verifiedBackup: garbage }));
  const other = store(t); const foreign = join(other.root, 'foreign.sqlite');
  migrateAi({ storage: other.root, backup: foreign });
  assert.equal(migrateAi({ storage: root, apply: true, confirm: 'AI_LEDGER_V4', verifiedBackup: foreign }).reason, 'backup_epoch_mismatch');
  const backup = join(root, 'pre-ai-v4.sqlite');
  assert.equal(migrateAi({ storage: root, backup }).action, 'backup');
  const applied = migrateAi({ storage: root, apply: true, confirm: 'AI_LEDGER_V4', verifiedBackup: backup });
  assert.deepEqual({ action: applied.action, aiLedgerVersion: applied.aiLedgerVersion, syncSchemaVersion: applied.syncSchemaVersion, fk: applied.foreignKeyIssues }, { action: 'applied', aiLedgerVersion: 4, syncSchemaVersion: 2, fk: 0 });
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM sync_entities').all()), syncBefore);
  assert.equal(migrateAi({ storage: root, apply: true, confirm: 'AI_LEDGER_V4', verifiedBackup: backup }).aiLedgerVersion, 4, 'repeat apply is a no-op');
});

test('migration from the 09B-0 ledger v2 preserves consent, request receipts and jobs through the v3 table rebuild', t => {
  const { root, db } = store(t, records(1));
  db.exec(readFileSync(new URL('./migrations/001-ai-foundation.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./migrations/002-ai-consent-bridge.sql', import.meta.url), 'utf8'));
  db.prepare("INSERT INTO sync_devices(id,label,token_hash,created_at,expires_at) VALUES('d1','synthetic','h',1,9999999999999)").run();
  db.prepare("INSERT INTO ai_note_consent VALUES('synthetic-vi-01','APPROVED_LOCAL_ONLY','[\"organize\"]','MOCK',1,1)").run();
  db.prepare(`INSERT INTO ai_jobs(id,note_id,server_epoch,source_cursor,target_server_version,content_sha256,consent_epoch,analysis_policy_version,prompt_schema_version,model_identity,execution_boundary,dedupe_key,scope,status,attempts,run_after,created_at,updated_at)
    VALUES('job-1','synthetic-vi-01','e',1,1,?,1,'ai-policy-v1',1,'mock-v1','MOCK',?,'organize','QUEUED',0,1,1,1)`).run('a'.repeat(64), 'b'.repeat(64));
  db.prepare(`INSERT INTO ai_analysis_requests VALUES(?,?, 'd1','synthetic-vi-01','e',1,?,1,'organize','MOCK','job-1','{}',1)`).run(crypto.randomUUID(), 'c'.repeat(64), 'a'.repeat(64));
  const backup = join(root, 'pre.sqlite'); migrateAi({ storage: root, backup });
  assert.equal(migrateAi({ storage: root }).aiLedgerVersion, 2);
  assert.equal(migrateAi({ storage: root, apply: true, confirm: 'AI_LEDGER_V4', verifiedBackup: backup }).aiLedgerVersion, 4);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_analysis_requests').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_jobs').get().n, 1);
  assert.equal(db.prepare('SELECT state FROM ai_note_consent').get().state, 'APPROVED_LOCAL_ONLY');
  assert.throws(() => db.prepare("UPDATE ai_analysis_requests SET execution_boundary='EXTERNAL_CLOUD'").run(), /CHECK/);
});

test('pilot cap limits concurrent grants to owner-chosen notes; revoking frees a slot; re-granting a granted note is allowed', t => {
  const notes = records(3), { db } = store(t, notes); applyAiSchema(db);
  const capped = { ...env, NOTEOS_AI_PILOT_MAX_NOTES: '2' };
  for (const note of notes.slice(0, 2)) grantNoteConsent(db, note.id, { providerBoundary: 'MOCK', env: capped });
  assert.throws(() => grantNoteConsent(db, notes[2].id, { providerBoundary: 'MOCK', env: capped }), error => error.code === 'PILOT_NOTE_LIMIT');
  assert.equal(grantNoteConsent(db, notes[0].id, { providerBoundary: 'MOCK', env: capped }).consentEpoch, 2);
  revokeNoteConsent(db, notes[1].id);
  assert.equal(grantNoteConsent(db, notes[2].id, { providerBoundary: 'MOCK', env: capped }).state, 'APPROVED_LOCAL_ONLY');
});

test('pilot preflight is read-only and reports no-go reasons before go', async t => {
  const fake = await startFakeGateway(); t.after(() => fake.close());
  const { root, db } = store(t, records(1));
  const base = { NOTEOS_SYNC_ENABLED: '1', NOTEOS_SYNC_STORAGE: root };
  const blocked = await pilotPreflight(base);
  assert.equal(blocked.go, false);
  assert.deepEqual(blocked.checks.filter(check => !check.ok).map(check => check.name), ['ai_organize_flag', 'ai_inference_flag', 'local_profile_attested', 'ai_ledger_current']);
  applyAiSchema(db); db.close();
  const before = createHash('sha256').update(readFileSync(join(root, 'sync.sqlite'))).digest('hex');
  const ready = await pilotPreflight({ ...base, ...env, NOTEOS_AI_PILOT_MAX_NOTES: '5', NOTEOS_AI_LOCAL_PROVIDER_ENABLED: '1', NOTEOS_AI_GATEWAY_URL: fake.origin, NOTEOS_AI_GATEWAY_PROVIDER: 'ollama', NOTEOS_AI_GATEWAY_MODEL: 'synthetic-local-8b', NOTEOS_AI_LOCAL_ATTESTATION: 'owner:2026-10-29' });
  assert.equal(ready.go, true, JSON.stringify(ready.checks));
  assert.equal(createHash('sha256').update(readFileSync(join(root, 'sync.sqlite'))).digest('hex'), before, 'preflight wrote nothing');
  assert.ok(fake.requests.every(request => request.path === '/v1/models'), 'preflight never runs inference');
  writeFileSync(join(root, 'ai-control', 'INFERENCE_STOP'), '');
  const stopped = await pilotPreflight({ ...base, ...env, NOTEOS_AI_PILOT_MAX_NOTES: '5', NOTEOS_AI_LOCAL_PROVIDER_ENABLED: '1', NOTEOS_AI_GATEWAY_URL: fake.origin, NOTEOS_AI_GATEWAY_PROVIDER: 'ollama', NOTEOS_AI_GATEWAY_MODEL: 'synthetic-local-8b', NOTEOS_AI_LOCAL_ATTESTATION: 'owner:2026-10-29' });
  assert.equal(stopped.checks.find(check => check.name === 'no_global_stop').ok, false);
});
