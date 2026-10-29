# Phase 09D — Reliability & Recovery

**Verdict: PASS** for synthetic failure injection, recovery, retention, rollback rehearsal and security checks. No production data, migration or deployment.

## Failure-injection matrix

| Scenario | Expected | Evidence |
|---|---|---|
| Network loss to Gateway | transient → bounded backoff (1 s·2ⁿ, cap 300 s, 5 attempts); same job completes when Gateway returns; no other origin contacted | `ai-reliability` · network loss |
| Browser offline / Mac unreachable | consent revocations, analysis intents and inbox decisions queue in IndexedDB and deliver in order; UI says offline/busy, never silently drops | `ai-sync-client.test`, `ai-inbox.test` offline |
| Worker crash (`SIGKILL` mid-inference) | job stays leased; lease expiry requeues; restarted worker completes once (attempts=2, one suggestion) | `ai-reliability` · crash/restart |
| Process crash during revoke | durable intent keeps every process blocked; reconcile completes the revoke | `ai-revocation-safety` (09B-1A) |
| Provider timeout / 5xx / 429 | transient retry; timeout aborts the HTTP request | `ai-provider-gateway.test` |
| Provider 4xx / redirect / oversize / invalid body | permanent → `FAILED_NEEDS_REVIEW` after one attempt | `ai-provider-gateway.test` |
| Malformed model output (prose, bad JSON) | `FAILED_NEEDS_REVIEW` (`invalid_provider_output`), nothing published | `ai-reliability` · malformed |
| Duplicate requests / jobs | dedupe key → one job; 3 concurrent worker processes → 9/9 jobs, 9 suggestions, 9 model calls, no double work | `ai-reliability` · duplicate work |
| Duplicate apply across devices | per-item CAS → `DECISION_CONFLICT`; second device shows *Applied* | `ai-suggestions.test`, browser E2E |
| Revocation mid-inference | in-flight call aborted by watchdog; payloads purged; inbox decisions → `SUGGESTION_REVOKED` | 09B-1A, `ai-inbox.test` |
| SQLite read-only / unwritable control plane | no claim/dispatch (`claim_not_persisted`, `dispatch_not_persisted`) | 09B-1A |
| AI API burst | consent checks throttled; 429 → delayed retry; E2E peak 34/60 req·min⁻¹ | 09C |

## Recovery and operations (operator-only, `sync-server/ai-maintenance.mjs`)

- `aiStorageReport(db)`: row counts vs logical caps (jobs 10k, audit 10k, consent 1k, decisions 20k), payload bytes, job states, control-plane state, ≥80 % warnings. Numbers only.
- `pruneAiRetention(db, { dryRun = true })`: purges payload text of *decided* suggestions older than 30 days, deletes old receipts/terminal jobs not referenced by suggestions, stale rate buckets, and audit rows older than 180 days. Never touches `PENDING_REVIEW`, `QUEUED`/`RUNNING`, consent markers, or any Sync table. Minimum windows enforced (7 / 30 days). Not scheduled; owner decides cadence.
- `backupAiStore(db, path)`: `VACUUM INTO` consistent copy; refuses to overwrite.
- `dropAiSchema(db, { confirm: 'DROP_AI_SIDECAR_ONLY' })`: AI-only rollback — drops AI sidecar tables, verifies Sync row counts unchanged, `PRAGMA user_version` untouched, `foreign_key_check` empty. Restoring the backup restores AI state (`integrity_check = ok`, ledger v4).

Audit log: every transition (grant, enqueue, claim, complete, cancel, retry, dead-letter, revoke) is recorded with IDs, epochs and reason codes only; a scan of the audit table finds no titles, note text or model output. Revocation keeps the durable consent marker even when the audit quota is full.

## AI OFF

With AI tables and data present and `NOTEOS_AI_*` unset, Text Sync push/pull behave identically, no AI job is created by a push, AI routes return 503, the worker returns `disabled`, and the Gateway receives zero requests.

## Security checks

- Route matrix (new inbox routes): foreign Origin 403; Sync-path cookie is not an AI session (401); query strings 400; traversal IDs 404; missing CSRF header / wrong content type 403; >4 KiB 413; invalid JSON 400; malformed item keys 400.
- Static scan (`evidence/09D/static-security-scan.txt`): the only outbound primitive in AI server code is `node:http` in the Gateway adapter (configured loopback origin, redirects refused); no hard-coded URLs; worker logs are metadata JSON; no secret-like values logged; client AI calls are same-origin `/api/v1/...`.
- `npm audit --omit=dev`: 2 **moderate**, both `@babel/runtime` via the pre-existing WatermelonDB spike dependency (not used by AI; fix is a breaking downgrade). No high/critical. Recorded, not changed.
- Prompt injection and privacy boundaries: 09B-1B (0 unsafe leaks under an obedient adversary; DEVICE_ONLY/unconsented → zero Gateway requests).

## Tests

`sync-server/ai-reliability.test.mjs` (9) plus the 09B-1A/1B/09C suites. Full regression: see `evidence/09D/`.

## Limits

Physical secure erasure is not provided (SQLite WAL/free pages and existing backups may retain purged bytes until checkpoint/VACUUM and backup rotation). Retention and backup cadence are owner decisions. Real-device and real-model behaviour are outside this phase.
