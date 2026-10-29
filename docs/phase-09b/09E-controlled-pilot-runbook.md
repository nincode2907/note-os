# Phase 09E — Controlled AI Pilot: preparation and runbook

**Verdict: BLOCKED — waiting for owner approval.** Everything needed for a small pilot is prepared and tested on synthetic data. Nothing was deployed, no production migration was run, inference is not enabled anywhere, and no real note was sent to any model.

## What is ready

| Item | Status |
|---|---|
| Fail-closed revocation across processes (09B-1A) | PASS |
| Attested local-only Gateway adapter, no fallback, cloud refused (09B-1B) | PASS |
| Suggestions Inbox, owner-applied, Undo, cross-device CAS (09C) | PASS (synthetic, Docker, Chromium + iPhone-sized WebKit) |
| Reliability, retention, rollback rehearsal, security (09D) | PASS |
| `ai-migrate.mjs`: dry run by default; apply needs `--confirm AI_LEDGER_V4` + a verified backup with matching server epoch | tested |
| `ai-pilot-preflight.mjs`: read-only go/no-go (opens SQLite read-only, model listing only) | tested; byte-identical DB after run |
| Pilot cap `NOTEOS_AI_PILOT_MAX_NOTES` (1–50): limits notes with an active grant | tested |
| Operator stop: `touch <storage>/ai-control/INFERENCE_STOP` | tested (aborts in-flight calls) |

## Decisions the owner must make before the pilot

1. **Approve the pilot** itself, its duration and the maximum number of notes (recommended: 5–10, `NOTEOS_AI_PILOT_MAX_NOTES=10`).
2. **Model and backend.** Configure the existing Gateway's `ollama` backend (`OLLAMA_BASE_URL=http://127.0.0.1:11434` in codex-server — another project, not changed by Codex) or approve a direct-Ollama adapter. Choose the model (installed: `llama3.1` / `llama3.1-fast`, 8B, ≈4.9 GB on a 16 GB Mac). Sign the local-execution attestation (`NOTEOS_AI_LOCAL_ATTESTATION=<owner>:<date>`).
3. **Run the real-model synthetic benchmark first** (09B-1B command) and set quality thresholds (e.g. schema-valid ≥ 95 %, unsafe leaks = 0, task recall ≥ 0.6, p95 latency budget).
4. **Privacy classification for text notes.** Text Sync does not mark notes `PRIVATE_SERVER`; AI will not treat missing privacy as eligible. Choose: an explicit per-note privacy control (recommended) or manual classification of pilot notes only.
5. **Representations:** category→tag, summary→top quote block, related→“Related: title” line (or alternatives).
6. **Retention:** confirm 30-day decided-payload and 180-day audit windows, and the backup cadence/rotation (backups keep purged text until rotated).
7. **Deployment window** for rebuilding `noteos-web` (Dockerfile now includes the AI runtime and a fix for the pre-existing broken `COPY` path).
8. **Physical device acceptance:** who runs the Mac + iPhone checks below (Codex cannot claim real-iPhone results).

## Runbook (only after written approval)

All commands run from the repository root. Audio Sync stays **off** throughout.

1. **Freeze and back up.** Note the current image ID and `.env`/compose settings. Inside the container:
   `docker compose -f docker-compose.web.yml -f docker-compose.phase082b-pilot.yml --profile phase082b-pilot exec web node sync-server/ai-migrate.mjs --backup /var/lib/noteos-sync/pre-ai-v4-<date>.sqlite`
   Copy the backup out of the volume (`docker cp`) and keep it off-volume.
2. **Build the new image** (no flags change yet): `docker compose -f docker-compose.web.yml build web`. Verify `docker run --rm noteos-web-local ls sync-server` lists the `ai-*` modules. Start with AI flags **unset**; confirm Text Sync on Mac and iPhone works exactly as before (AI OFF parity).
3. **Dry-run the migration:** `exec web node sync-server/ai-migrate.mjs` → expect `syncSchemaVersion 2, aiLedgerVersion 0, target 4`.
4. **Apply the migration:** `exec web node sync-server/ai-migrate.mjs --apply --verified-backup /var/lib/noteos-sync/pre-ai-v4-<date>.sqlite --confirm AI_LEDGER_V4` → expect `applied, aiLedgerVersion 4, foreignKeyIssues 0`; Sync schema unchanged.
5. **Configure the Gateway local backend** (owner, in codex-server) and verify read-only: `curl -s 'http://127.0.0.1:15600/v1/models?provider=ollama'` lists the chosen model with a non-`remote` state.
6. **Enable organize only:** `NOTEOS_AI_ORGANIZE_ENABLED=1`, `NOTEOS_AI_INFERENCE_ENABLED=0`, local profile variables (`NOTEOS_AI_LOCAL_PROVIDER_ENABLED=1`, `NOTEOS_AI_GATEWAY_URL=http://host.docker.internal:15600`, `NOTEOS_AI_GATEWAY_ALLOW_DOCKER_HOST=1`, `NOTEOS_AI_GATEWAY_HOST_HEADER=codex-server.localhost`, `NOTEOS_AI_GATEWAY_PROVIDER=ollama`, `NOTEOS_AI_GATEWAY_MODEL=<model>`, `NOTEOS_AI_LOCAL_ATTESTATION=<owner>:<date>`, `NOTEOS_AI_PILOT_MAX_NOTES=10`). Recreate the container.
7. **Preflight:** `exec web node sync-server/ai-pilot-preflight.mjs` must print `"go": false` only because `ai_inference_flag` is off; every other check `ok`.
8. **Choose pilot notes** (owner): classify them explicitly, grant consent per note in the note page, then request analysis per revision.
9. **Enable inference** (`NOTEOS_AI_INFERENCE_ENABLED=1`), recreate, rerun preflight → `"go": true`. Run the worker on demand: `exec web node sync-server/ai-worker.mjs --drain --max 10`. There is no daemon.
10. **Review on Mac and iPhone:** verify source quotes, confidence, previews; Approve/Edit/Reject/Later/Undo; Text Sync carries applied edits; the second device shows *Applied*; DEVICE_ONLY notes show no AI controls.
11. **Privacy checks:** revoke one pilot note mid-run (expect in-flight abort, purged suggestions); confirm the Gateway log shows only the configured local provider; `ai-maintenance` storage report shows no growth anomalies.

### Stop / rollback

- **Immediate stop (no data change):** `exec web touch /var/lib/noteos-sync/ai-control/INFERENCE_STOP` — blocks dispatch and aborts in-flight calls. Then set `NOTEOS_AI_INFERENCE_ENABLED=0` and recreate.
- **Feature off:** unset both AI flags; Text Sync is unaffected (verified).
- **AI-only rollback:** back up, then `dropAiSchema(db, { confirm: 'DROP_AI_SIDECAR_ONLY' })` via a reviewed one-off command; Sync data, `user_version` and notes are untouched. Notes already edited by approved suggestions keep those edits (they are ordinary owner edits; undo per item before rollback if desired).
- **Full restore:** stop the container, replace `sync.sqlite` with the off-volume backup only under the existing Sync recovery review (server epoch must match), restart, verify Sync.
- **Image rollback:** retag the previous image ID noted in step 1.

### Go / no-go criteria for widening the pilot

Unsafe leaks 0; zero unintended note changes; every applied item traceable to an owner decision; revoke always confirmed or fail-closed; quality thresholds from decision 3 met; no Sync regression; owner sign-off.
