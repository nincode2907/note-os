// Explicit AI ledger migration for an owner-approved rollout. Never run automatically.
//   node sync-server/ai-migrate.mjs                      # dry run: current/target versions only
//   node sync-server/ai-migrate.mjs --backup <new.sqlite> # consistent VACUUM INTO backup
//   node sync-server/ai-migrate.mjs --apply --verified-backup <existing.sqlite> --confirm AI_LEDGER_V4
import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AI_SCHEMA_VERSION, applyAiSchema } from './ai-foundation.mjs';
import { backupAiStore } from './ai-maintenance.mjs';
import { openStore, serverMeta } from './storage.mjs';

const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);

function currentVersion(db) {
  try { return db.prepare('SELECT max(version) v FROM ai_schema_migrations').get().v ?? 0; } catch { return 0; }
}

/** A backup is acceptable only if it is a readable SQLite file with intact pages and the same server epoch. */
export function verifyBackup(file, serverEpoch) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) return 'backup_missing';
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') return 'backup_corrupt';
    if (serverMeta(copy).serverEpoch !== serverEpoch) return 'backup_epoch_mismatch';
    return null;
  } finally { copy.close(); }
}

export function migrateAi({ storage, apply = false, backup = null, verifiedBackup = null, confirm = null } = {}) {
  const db = openStore(storage);
  try {
    const meta = serverMeta(db), before = currentVersion(db), syncVersion = db.prepare('PRAGMA user_version').get().user_version;
    const plan = { syncSchemaVersion: syncVersion, aiLedgerVersion: before, targetAiLedgerVersion: AI_SCHEMA_VERSION, audioMigrationTouched: false };
    if (backup) return { ...plan, action: 'backup', file: backupAiStore(db, backup) };
    if (!apply) return { ...plan, action: 'dry_run' };
    if (confirm !== `AI_LEDGER_V${AI_SCHEMA_VERSION}`) return { ...plan, action: 'refused', reason: 'confirmation_required' };
    const problem = verifyBackup(verifiedBackup, meta.serverEpoch);
    if (problem) return { ...plan, action: 'refused', reason: problem };
    const after = applyAiSchema(db);
    if (db.prepare('PRAGMA user_version').get().user_version !== syncVersion) throw new Error('Sync schema version changed unexpectedly');
    return { ...plan, action: 'applied', aiLedgerVersion: after, foreignKeyIssues: db.prepare('PRAGMA foreign_key_check').all().length };
  } finally { db.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), value = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
  try { out(migrateAi({ storage: process.env.NOTEOS_SYNC_STORAGE, apply: args.includes('--apply'), backup: value('--backup'), verifiedBackup: value('--verified-backup'), confirm: value('--confirm') })); }
  catch (error) { out({ action: 'failed', message: error.message }); process.exitCode = 1; }
}
