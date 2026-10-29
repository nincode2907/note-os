import { existsSync } from 'node:fs';
import { transaction } from './storage.mjs';
import { listAiControlState } from './ai-control.mjs';

// Operator-only AI maintenance. Nothing here runs automatically or from an HTTP route.
// None of these functions touch Sync tables, consent rows, queued/running jobs, or
// suggestions that are still waiting for review.
const CAPS = { ai_jobs: 10000, ai_audit_log: 10000, ai_note_consent: 1000, ai_suggestion_decisions: 20000 };
const DAY = 86400000;
const AI_TABLES = ['ai_suggestion_decisions', 'ai_suggestion_item_state', 'ai_analysis_requests', 'ai_consent_operations', 'ai_bridge_rate_limits', 'ai_suggestions', 'ai_jobs', 'ai_audit_log', 'ai_note_consent', 'ai_schema_migrations'];
const SYNC_TABLES = ['sync_server_meta', 'sync_devices', 'sync_entities', 'sync_tombstones', 'sync_changelog', 'sync_operations'];

const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

/** Counts against logical caps plus live payload bytes; numbers only. */
export function aiStorageReport(db) {
  const tables = Object.fromEntries(AI_TABLES.filter(name => tableExists(db, name)).map(name => [name, db.prepare(`SELECT count(*) n FROM ${name}`).get().n]));
  const caps = Object.fromEntries(Object.entries(CAPS).filter(([name]) => name in tables).map(([name, cap]) => [name, { rows: tables[name], cap, percent: Math.round((tables[name] / cap) * 1000) / 10 }]));
  const payloadBytes = tableExists(db, 'ai_suggestions') ? db.prepare('SELECT coalesce(sum(length(CAST(payload_json AS BLOB))),0) b FROM ai_suggestions').get().b : 0;
  const jobs = tableExists(db, 'ai_jobs') ? Object.fromEntries(db.prepare('SELECT status,count(*) n FROM ai_jobs GROUP BY status').all().map(row => [row.status, row.n])) : {};
  const warnings = Object.entries(caps).filter(([, value]) => value.percent >= 80).map(([name]) => `${name}_above_80_percent`);
  let control = null;
  try { control = listAiControlState(db); } catch { control = { unavailable: true }; }
  return { tables, caps, payloadBytes, jobs, control: { ...control, pendingRevocationKeys: control?.pendingRevocationKeys?.length ?? 0 }, warnings };
}

/**
 * Explicit retention. Defaults: dry run; decided/terminal AI data older than 30 days;
 * audit rows older than 180 days. Pending reviews, active jobs, consent markers and
 * every Sync table are never touched. Returns the counts it changed (or would change).
 */
export function pruneAiRetention(db, { now = Date.now(), retentionDays = 30, auditRetentionDays = 180, dryRun = true } = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 7 || !Number.isSafeInteger(auditRetentionDays) || auditRetentionDays < 30) throw new TypeError('Retention windows are below the reviewed minimum');
  const cutoff = now - retentionDays * DAY, auditCutoff = now - auditRetentionDays * DAY;
  const statements = {
    purgedDecidedPayloads: ["UPDATE ai_suggestions SET payload_json='{}',updated_at=? WHERE status IN ('ACCEPTED','REJECTED','STALE','REVOKED') AND payload_json<>'{}' AND updated_at<?", [now, cutoff]],
    deletedRequestReceipts: ["DELETE FROM ai_analysis_requests WHERE created_at<? AND job_id IN (SELECT id FROM ai_jobs WHERE status IN ('COMPLETED','FAILED_NEEDS_REVIEW','SUPERSEDED','CANCELED'))", [cutoff]],
    deletedConsentReceipts: ['DELETE FROM ai_consent_operations WHERE created_at<?', [cutoff]],
    deletedTerminalJobs: [`DELETE FROM ai_jobs WHERE status IN ('FAILED_NEEDS_REVIEW','SUPERSEDED','CANCELED') AND updated_at<?
      AND id NOT IN (SELECT job_id FROM ai_suggestions) AND id NOT IN (SELECT job_id FROM ai_analysis_requests)`, [cutoff]],
    deletedRateBuckets: ['DELETE FROM ai_bridge_rate_limits WHERE window_started_at<?', [now - DAY]],
    deletedAuditRows: ['DELETE FROM ai_audit_log WHERE created_at<?', [auditCutoff]],
  };
  const count = {
    purgedDecidedPayloads: "SELECT count(*) n FROM ai_suggestions WHERE status IN ('ACCEPTED','REJECTED','STALE','REVOKED') AND payload_json<>'{}' AND updated_at<?",
    deletedRequestReceipts: "SELECT count(*) n FROM ai_analysis_requests WHERE created_at<? AND job_id IN (SELECT id FROM ai_jobs WHERE status IN ('COMPLETED','FAILED_NEEDS_REVIEW','SUPERSEDED','CANCELED'))",
    deletedConsentReceipts: 'SELECT count(*) n FROM ai_consent_operations WHERE created_at<?',
    deletedTerminalJobs: "SELECT count(*) n FROM ai_jobs WHERE status IN ('FAILED_NEEDS_REVIEW','SUPERSEDED','CANCELED') AND updated_at<? AND id NOT IN (SELECT job_id FROM ai_suggestions) AND id NOT IN (SELECT job_id FROM ai_analysis_requests)",
    deletedRateBuckets: 'SELECT count(*) n FROM ai_bridge_rate_limits WHERE window_started_at<?',
    deletedAuditRows: 'SELECT count(*) n FROM ai_audit_log WHERE created_at<?',
  };
  return transaction(db, () => {
    const result = { dryRun };
    for (const [key, [sql, params]] of Object.entries(statements)) {
      const threshold = params.at(-1);
      result[key] = dryRun ? db.prepare(count[key]).get(threshold).n : db.prepare(sql).run(...params).changes;
    }
    return result;
  });
}

/** Consistent online copy for migration/rollback rehearsal. Refuses to overwrite. */
export function backupAiStore(db, targetFile) {
  if (typeof targetFile !== 'string' || !targetFile.endsWith('.sqlite') || existsSync(targetFile)) throw new TypeError('Backup target must be a new .sqlite path');
  db.prepare('VACUUM INTO ?').run(targetFile);
  return targetFile;
}

/**
 * AI-only rollback: drop the AI sidecar tables (consent, jobs, suggestions, decisions,
 * audit). Sync data and PRAGMA user_version are untouched. Requires an explicit token.
 */
export function dropAiSchema(db, { confirm } = {}) {
  if (confirm !== 'DROP_AI_SIDECAR_ONLY') throw new TypeError('Explicit confirmation is required');
  const before = SYNC_TABLES.filter(name => tableExists(db, name)).map(name => db.prepare(`SELECT count(*) n FROM ${name}`).get().n);
  transaction(db, () => { for (const name of AI_TABLES) db.exec(`DROP TABLE IF EXISTS ${name}`); });
  const after = SYNC_TABLES.filter(name => tableExists(db, name)).map(name => db.prepare(`SELECT count(*) n FROM ${name}`).get().n);
  if (before.join(',') !== after.join(',')) throw new Error('Sync tables changed during AI rollback');
  return { dropped: AI_TABLES.length, syncRowCounts: after };
}
