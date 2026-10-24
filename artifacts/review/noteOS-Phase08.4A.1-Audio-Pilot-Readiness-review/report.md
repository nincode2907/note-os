# Phase 08.4A.1 — Audio Pilot Readiness & Correctness

**Status:** Synthetic implementation checks PASS. Physical iPhone Safari acceptance remains PENDING. Production Audio Sync remains OFF.

## Changes

- Added an explicit per-note action to authorize `PRIVATE_SERVER` text Sync. It preserves the note ID, canonical document, lifecycle, tags and recordings, enrolls only the selected note, and creates a text-only operation even when local recordings already exist.
- A `DEVICE_ONLY` note stays local until the owner confirms a separate privacy change. The UI explains that note text is sent through text Sync while audio bytes require a second approval.
- Audio approval now requires an enrolled note and a server-acknowledged baseline whose privacy matches the current note. The authenticated server still checks its own note privacy and per-device approval before accepting or returning audio.
- Client verification now hashes local chunks and the complete recording before trusting a server device-verification record. Missing or damaged downloaded files recover safely; distinct user-owned ID collisions and metadata differences remain for review.
- Downloaded audio is no longer considered an upload candidate. Existing downloaded files can submit metadata-only updates after explicit conflict resolution; their bytes are not re-uploaded. Anchor merges keep local bookmarks and preserve differing remote bookmarks as separate entries.
- Audio paging continues across 100-change pages, records the epoch with the cursor, restarts from zero after an epoch change, and commits each page cursor only after the page is processed.

## Verification

- MVP / IndexedDB / Archive V2: **117 passed, 0 failed**.
- Sync client and server: **53 passed, 0 failed**.
- Document Engine: **31 passed, 0 failed**.
- TypeScript check: PASS. Production build: PASS.
- Chromium desktop and Playwright WebKit at 390px: **2/2 synthetic UI checks passed**. No external requests. These cover privacy approval gating and explicit `DEVICE_ONLY` confirmation; WebKit emulation is not an iPhone test.
- Synthetic SQLite v2-to-v3 migration tests pass. No production migration was run.

Full logs, browser evidence and the source diff are in `evidence/` and `source.diff`.

## Production and device boundaries

- Running noteOS Web is healthy; `NOTEOS_SYNC_ENABLED=1` remains active. The running Web container has no `NOTEOS_AUDIO_SYNC_ENABLED=1` setting, and the base Compose configuration sets it to `0`; the server enables audio only for the exact value `1`. Effective production Audio Sync is therefore OFF.
- No production SQLite, IndexedDB, audio bytes, pairing session, server epoch, cursor, or Tailscale settings were read or changed. MemoryOS and unrelated services were left untouched.
- Physical iPhone Safari recording, upload, download, recovery and cellular behavior are **PENDING owner/device acceptance**. The checklist is in `physical-device-checklist.md`.
- No Audio Sync activation or Phase 08.4B work was started.

## Cleanup and Git

- No task-owned Docker test container, volume, network or persistent browser profile was created. Temporary Playwright contexts were closed, the local verification server was stopped, and test-owned IndexedDB/SQLite data was synthetic and process-scoped.
- Docker before/after observations are documented in `docker-cleanup.md`; post-run inventories are saved in `evidence/docker/`.
- Existing owner deletions under Phase 08.2A and 08.2A.1 review artifacts remain unstaged and untouched.
- Baseline before implementation: `ae4fb240264377ec2fa669677283ec2a6835586d`.
- Validated source commit: `0190b7e` (`Harden audio sync pilot readiness`). The final remote HEAD also includes the review-artifact packaging commit; it is reported in the handoff.
