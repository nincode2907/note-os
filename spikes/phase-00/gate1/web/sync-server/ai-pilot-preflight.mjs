// Read-only go/no-go check for a controlled AI pilot. Opens SQLite read-only, writes nothing,
// sends no note data. Gateway check is model listing only (no inference).
//   node sync-server/ai-pilot-preflight.mjs
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AI_SCHEMA_VERSION, aiFeatureFlags } from './ai-foundation.mjs';
import { checkGatewayHealth, localGatewayConfigFromEnv } from './ai-provider-gateway.mjs';
import { listAiControlState } from './ai-control.mjs';

export async function pilotPreflight(env = process.env, { health = checkGatewayHealth } = {}) {
  const checks = [];
  const add = (name, ok, detail = null) => checks.push({ name, ok, ...(detail === null ? {} : { detail }) });
  const flags = aiFeatureFlags(env);
  add('text_sync_enabled', env.NOTEOS_SYNC_ENABLED === '1');
  add('audio_sync_off', env.NOTEOS_AUDIO_SYNC_ENABLED !== '1');
  add('ai_organize_flag', flags.organizeEnabled);
  add('ai_inference_flag', flags.inferenceEnabled);
  let config = null;
  try { config = localGatewayConfigFromEnv(env); add('local_profile_attested', Boolean(config), config ? config.identity : 'missing'); }
  catch (error) { add('local_profile_attested', false, error.message); }
  const file = env.NOTEOS_SYNC_STORAGE ? join(env.NOTEOS_SYNC_STORAGE, 'sync.sqlite') : null;
  if (!file || !existsSync(file)) add('sync_store_present', false);
  else {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      add('sync_store_present', true);
      add('sync_schema_supported', [2, 3].includes(db.prepare('PRAGMA user_version').get().user_version), db.prepare('PRAGMA user_version').get().user_version);
      let ledger = 0; try { ledger = db.prepare('SELECT max(version) v FROM ai_schema_migrations').get().v ?? 0; } catch { ledger = 0; }
      add('ai_ledger_current', ledger === AI_SCHEMA_VERSION, ledger);
      if (ledger) {
        const consented = db.prepare("SELECT count(*) n FROM ai_note_consent WHERE state='APPROVED_LOCAL_ONLY'").get().n;
        const cap = Number(env.NOTEOS_AI_PILOT_MAX_NOTES || 0);
        add('pilot_note_cap_configured', Number.isSafeInteger(cap) && cap > 0 && cap <= 50, cap || 'unset');
        add('consented_notes_within_cap', !cap || consented <= cap, consented);
        let control = null; try { control = listAiControlState(db); } catch { control = null; }
        add('control_plane_present', Boolean(control));
        add('no_global_stop', Boolean(control) && !control.operatorStop && control.automaticStops === 0);
        add('no_pending_revocations', Boolean(control) && control.pendingRevocationKeys.length === 0, control?.pendingRevocationKeys.length ?? null);
      }
    } finally { db.close(); }
  }
  if (config) {
    try { const result = await health(config); add('gateway_local_model_listed', true, `${result.provider}:${result.model}`); }
    catch (error) { add('gateway_local_model_listed', false, error.code ?? 'error'); }
  }
  return { go: checks.every(check => check.ok), checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  pilotPreflight().then(result => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = result.go ? 0 : 2; });
}
