# Phase 08.2A — Offline-first Web Sync Engine

Date: 2026-10-23  
Status: **PASS for isolated implementation and synthetic acceptance; BLOCKED for real-device validation.**  
Scope: Source implementation and synthetic local validation only. Production sync remains disabled.

## Scope and safety boundary

The sync implementation lives under `spikes/phase-00/gate1/web`. It adds a durable IndexedDB outbox and per-browser enrollment/baseline/cursor/conflict state, an incremental authenticated SQLite protocol with atomic entity/version/change-log/idempotency writes, and a browser sync worker protected by Web Locks. Existing notes require explicit selection for enrollment; missing privacy permission is not promoted. `DEVICE_ONLY`, notes with recordings, and audio bytes are excluded. Conflicts retain the local version and a deterministic pinned review copy of the remote version. There is no remote permanent-delete operation.

The normal local Compose service was checked at `http://127.0.0.1:15700/api/v1/sync/status` and returned HTTP 503 `sync_disabled`. The synthetic acceptance service is isolated in `docker-compose.phase082a-test.yml`, with `NOTEOS_SYNC_ENABLED=1` and `NOTEOS_SYNC_TEST_ONLY=1`, bound only to `127.0.0.1:15740`, and uses the named synthetic volume `noteos_phase082a_synthetic_20261023`.

## Results

| Check | Result | Evidence |
|---|---|---|
| Sync protocol, authentication, migration and rollback tests | **PASS — 40/40** | `evidence/test-sync.log` |
| Local note/outbox, enrollment, privacy/audio exclusion, conflict and recovery tests | **PASS — 87/87** | `evidence/test-mvp.log` |
| Canonical document regression tests | **PASS — 31/31** | `evidence/test-documents.log` |
| TypeScript typecheck | **PASS** | `evidence/typecheck.log` |
| Two-browser synthetic Chromium/WebKit acceptance | **PASS — 11 recorded scenarios** | `evidence/browser-results.json`, `evidence/browser-trace.json`, screenshots |
| Full Archive V2 browser regression | **PASS — 7/7** | `evidence/regressions/backup-v2-final/browser-results.json` |
| Audio and timestamp-anchor browser regression | **PASS — 11/11** | `evidence/regressions/audio-final/browser-results.json` |
| SQLite restart persistence | **PASS** | `evidence/server-restart-persistence.json` |
| Disposable old-origin browser-storage isolation | **PASS** | `evidence/origin-isolation.json` |
| Physical iPhone / Safari device behavior | **BLOCKED — not tested on hardware** | No device evidence claimed |

The recorded cross-browser acceptance covers device pairing, owner-approved existing-note enrollment, exclusion of `DEVICE_ONLY` and audio-bearing notes, local capture/outbox durability during API failure, WebKit-to-Chromium push/pull and Unicode editing, lost-ACK idempotent retry, offline conflict preservation, two-tab Web Lock deduplication, and epoch-change recovery. Browsers were Playwright synthetic contexts on macOS ARM64: WebKit 27.2 at 390×844 / DPR 3 and Chromium 156.0.8078.4 at 1440×1000. This is not physical iPhone Safari.

SQLite restart was separately repeated against the named disposable Compose volume. The fixture state before and after matched byte-for-byte by digest: epoch `9a0c530c-3a45-44ba-969c-db817ee9e9a4`, schema 2, cursor 5, 2 notes, 5 operations and 5 changes. The full browser-script rerun reached a 30-second navigation timeout while moving to the disposable HTTP origin; a focused Chromium test then passed the origin-isolation check by writing a synthetic IndexedDB record on `127.0.0.1`, confirming `localhost` could not read it, and confirming the original record remained after returning. The Compose health-check timeout was raised to 15 seconds after observing slow but successful Next.js startup; this changes only the synthetic test stack.

## Runtime and dataset

- Host: macOS ARM64 (`darwin`, Node 24.21.0); container: Node 22.21.1 Alpine, Next.js 16.4.2, React 19.3.1, SQLite `node:sqlite`.
- Browsers: Playwright WebKit 27.2 and Chromium 156.0.8078.4.
- Dataset: synthetic Japanese/Vietnamese canonical notes, two browser contexts, one synthetic recording marker, and injected offline, lost-response, conflict and epoch-change conditions. No personal notes, recordings, external AI or production server data were used.
- Acceptance was correctness-oriented; no latency percentile or performance claim was measured.

## Reproduction

From the repository root:

1. `rtk npm --prefix spikes/phase-00/gate1/web run test:sync`
2. `rtk npm --prefix spikes/phase-00/gate1/web run test:mvp`
3. `rtk npm --prefix spikes/phase-00/gate1/web run test:documents`
4. `rtk npm --prefix spikes/phase-00/gate1/web run typecheck`
5. Build and start only the synthetic Compose stack, then run `rtk node spikes/phase-00/gate1/web/scripts/sync-web-08-2a-browser.mjs`.
6. Restart persistence can be reproduced by capturing `rtk docker exec noteos-phase082a-synthetic-web node /verification/fixture.mjs state`, restarting only `web` in `docker-compose.phase082a-test.yml`, then comparing the fixture JSON.

The browser acceptance trace and failure-injection log are included with screenshots. Rejected Next.js RSC prefetches were observed in the WebKit run; navigation fallback completed and the recorded assertions passed.

## Rollback and activation gates

No production activation occurred. Keep `NOTEOS_SYNC_ENABLED=0` for the ordinary service. To remove only the test deployment, run `rtk docker compose -f docker-compose.phase082a-test.yml down -v`; this targets only the explicitly named synthetic container, network and volume. Do not use this command against another Compose project.

Before any owner-data pilot, separately complete the blocked origin-isolation browser check, review the Phase 00 architecture decision, obtain a current Full Archive V2 from every relevant browser origin and the native app, verify recovery copies, and test on physical iPhone hardware. This handoff does not authorize production sync activation or personal-data enrollment.
