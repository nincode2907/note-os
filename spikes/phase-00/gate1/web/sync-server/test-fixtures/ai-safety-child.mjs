// Separate-process actor for 09B-1A revocation safety tests. Synthetic data only.
// Usage: node ai-safety-child.mjs <mode> <storageRoot> [noteId] [workerId]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openStore } from '../storage.mjs';
import { reconcileAiRevocationIntents, revokeNoteConsent, runOneAiJob } from '../ai-foundation.mjs';

const [mode, root, noteId, workerId = `child-${process.pid}`] = process.argv.slice(2);
const env = { NOTEOS_AI_ORGANIZE_ENABLED: '1', NOTEOS_AI_INFERENCE_ENABLED: '1', NODE_ENV: 'test' };
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const output = {
  schemaVersion: 1, categorySuggestion: null, tagCandidates: [], shortSummary: 'Synthetic summary.',
  taskCandidates: [], relatedCandidates: [], insufficientContext: false, uncertainty: 0.5,
};

function slowProvider(holdMs) {
  return {
    identity: 'mock-v1', executionBoundary: 'MOCK',
    analyze(_input, { signal } = {}) {
      const invokedAt = Date.now();
      emit({ event: 'invoked', at: invokedAt });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(output), holdMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); emit({ event: 'provider_aborted', afterMs: Date.now() - invokedAt }); reject(signal.reason); }, { once: true });
      });
    },
  };
}

try {
  if (mode === 'worker') {
    const db = openStore(root);
    const holdMs = Number(process.env.HOLD_MS ?? 8000);
    const result = await runOneAiJob(db, { workerId, provider: slowProvider(holdMs), env, leaseMs: 60000, timeoutMs: 30000, watchdogMs: Number(process.env.WATCHDOG_MS ?? 50) });
    emit({ event: 'result', result });
    db.close();
  } else if (mode === 'revoke-crash') {
    const db = openStore(root);
    // Simulate power loss/kill after the durable intent and before the SQLite commit.
    revokeNoteConsent(db, noteId, { onIntentPersisted: () => { emit({ event: 'intent_persisted' }); process.exit(86); } });
    emit({ event: 'unexpected_commit' });
  } else if (mode === 'revoke-readonly') {
    // A real SQLite read-only connection: every write fails inside SQLite itself.
    const db = new DatabaseSync(join(root, 'sync.sqlite'), { readOnly: true });
    try { revokeNoteConsent(db, noteId); emit({ event: 'unexpected_commit' }); }
    catch (error) { emit({ event: 'revoke_failed', code: error.code, controlPlane: error.controlPlane, cause: String(error.cause?.message ?? '') }); }
    db.close();
  } else if (mode === 'worker-readonly') {
    const db = new DatabaseSync(join(root, 'sync.sqlite'), { readOnly: true });
    let invoked = 0;
    const provider = { identity: 'mock-v1', executionBoundary: 'MOCK', analyze: async () => { invoked++; return output; } };
    emit({ event: 'result', result: await runOneAiJob(db, { workerId, provider, env }), invoked });
    db.close();
  } else if (mode === 'reconcile') {
    const db = openStore(root);
    emit({ event: 'result', result: reconcileAiRevocationIntents(db) });
    db.close();
  } else throw new Error(`unknown mode ${mode}`);
} catch (error) {
  emit({ event: 'error', message: error.message, code: error.code });
  process.exitCode = 1;
}
