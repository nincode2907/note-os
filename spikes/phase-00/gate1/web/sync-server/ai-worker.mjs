// On-demand AI Organize worker. Runs inside the existing web container (same Sync volume),
// processes queued jobs through the attested local Gateway backend, then exits.
// It is not a daemon and is never started automatically. Output is metadata only.
//
//   node sync-server/ai-worker.mjs --once            # at most one job
//   node sync-server/ai-worker.mjs --drain [--max 25] # until idle or the bound
//   node sync-server/ai-worker.mjs --check            # preflight + health, no inference
import { hostname } from 'node:os';
import { AI_SCHEMA_VERSION, aiFeatureFlags, reconcileAiRevocationIntents, recoverExpiredAiJobs, runOneAiJob } from './ai-foundation.mjs';
import { ensureAiControlPlane, inferenceBlockReason } from './ai-control.mjs';
import { checkGatewayHealth, createGatewayProvider, localGatewayConfigFromEnv } from './ai-provider-gateway.mjs';
import { openStore } from './storage.mjs';

const log = value => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);

export async function preflight(env = process.env, { health = checkGatewayHealth } = {}) {
  const flags = aiFeatureFlags(env);
  if (!flags.organizeEnabled || !flags.inferenceEnabled) return { ok: false, reason: 'ai_flags_disabled' };
  let config;
  try { config = localGatewayConfigFromEnv(env); } catch (error) { return { ok: false, reason: 'local_profile_invalid', detail: error.message }; }
  if (!config) return { ok: false, reason: 'local_profile_missing' };
  let db;
  try { db = openStore(env.NOTEOS_SYNC_STORAGE); }
  catch { return { ok: false, reason: 'sync_storage_unavailable' }; }
  try {
    let version = null;
    try { version = db.prepare('SELECT max(version) v FROM ai_schema_migrations').get().v; } catch { version = null; }
    if (version !== AI_SCHEMA_VERSION) return { ok: false, reason: 'ai_schema_not_migrated', version };
    ensureAiControlPlane(db);
    const reconciled = reconcileAiRevocationIntents(db);
    if (inferenceBlockReason(db) === 'inference_stopped') return { ok: false, reason: 'inference_stopped', reconciled };
    let gateway;
    try { gateway = await health(config); } catch (error) { return { ok: false, reason: 'gateway_unhealthy', detail: error.code ?? 'error', reconciled }; }
    return { ok: true, identity: config.identity, gateway, reconciled, config };
  } finally { db.close(); }
}

export async function runWorker({ mode = 'once', maxJobs = 25, env = process.env, workerId = `worker-${hostname().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'host'}-${process.pid}` } = {}) {
  const check = await preflight(env);
  const { config, ...publicCheck } = check;
  log({ event: 'preflight', ...publicCheck });
  if (!check.ok || mode === 'check') return check.ok ? 0 : 2;
  const db = openStore(env.NOTEOS_SYNC_STORAGE);
  const provider = createGatewayProvider(config, { onMetrics: metrics => log({ event: 'provider_metrics', ...metrics }) });
  const leaseMs = Math.min(300000, config.timeoutMs + 30000);
  try {
    const limit = mode === 'once' ? 1 : maxJobs;
    for (let processed = 0; processed < limit; processed++) {
      const recovered = recoverExpiredAiJobs(db);
      if (recovered.length) log({ event: 'recovered', jobs: recovered.length });
      const result = await runOneAiJob(db, { workerId, provider, env, leaseMs, timeoutMs: config.timeoutMs });
      log({ event: 'job', ...result });
      if (result.status === 'idle') break;
      if (['blocked', 'local_execution_not_proven', 'provider_rejected', 'disabled'].includes(result.status)) return 3;
      if (result.status === 'aborted' && result.reason === 'inference_stopped') return 3;
    }
    return 0;
  } finally { db.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const mode = args.includes('--drain') ? 'drain' : args.includes('--check') ? 'check' : args.includes('--once') ? 'once' : null;
  const maxIndex = args.indexOf('--max');
  const maxJobs = maxIndex >= 0 ? Number(args[maxIndex + 1]) : 25;
  if (!mode || !Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 500) {
    process.stderr.write('Usage: ai-worker.mjs --check | --once | --drain [--max N<=500]\n');
    process.exit(64);
  }
  runWorker({ mode, maxJobs }).then(code => { process.exitCode = code; }, error => { log({ event: 'fatal', code: error?.code ?? 'error' }); process.exitCode = 1; });
}
