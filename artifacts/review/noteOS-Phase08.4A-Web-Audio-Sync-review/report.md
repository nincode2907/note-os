# noteOS Phase 08.4A — Reliable Web Audio Sync

**Result: SYNTHETIC ACCEPTANCE PASS.** Implementation and isolated synthetic checks pass. Audio sync remains disabled in the normal Compose configuration (`NOTEOS_AUDIO_SYNC_ENABLED=0`); this work did not enable live media transfer, migrate the production database, read personal notes/audio, alter Tailscale, pair devices, or deploy a service.

## What changed

- Added authenticated, same-origin audio endpoints to the existing Next.js Sync API. Binary chunks are 1 MiB, content-addressed with SHA-256, limited to 512 MiB per recording, with resumable seven-day transfer sessions, two concurrent sessions per device, eight total sessions, and a default 2 GiB media quota (configurable from 64 MiB to 8 GiB).
- Uploads stream to private staging files, sync file data and directories, validate each chunk and the complete object, then publish by hard link before committing metadata. An additive SQLite v3 migration preserves the v2 epoch, cursor, devices, notes, and text history. It runs only after an authenticated request reaches the separately enabled audio API. Text Sync remains on the v2 path when audio is off.
- Added IndexedDB v5 approval, transfer, and downloaded-chunk stores. Sync is per-note and per-device; `DEVICE_ONLY`, unclassified, unpaired, and non-enrolled notes are rejected. Audio changes run inside the existing sync cycle and Web Locks. Failed transfers leave local audio intact; incomplete recordings remain local.
- Added per-recording status, retry, and explicit keep-remote/keep-local review actions for title/bookmark conflicts. The service worker keeps `/api/` network-only and refuses private/no-store responses from its cache.

## Verification

| Gate | Result |
|---|---:|
| MVP, Archive V2, IndexedDB, audio client and protocol | 106 / 106 passed |
| Sync server, migrations, media transfer and security | 53 / 53 passed |
| Document Engine | 31 / 31 passed |
| TypeScript | PASS |
| Next.js production build | PASS |
| Chromium audio recorder regression with synthetic input | 11 / 11 passed |

Total automated Node tests: **190 passed, 0 failed**. Browser evidence reports Chromium 156.0.8078.4, fake audio input, no console/page errors, and no external requests. The synthetic paired-client test uploads a 1 MiB+ recording and downloads identical ordered bytes into an independently approved browser store. The browser run is not an iPhone test.

`/usr/bin/time -l` measurements: MVP suite peak RSS 103,694,336 bytes; Sync suite 87,916,544 bytes; production build 428,998,656 bytes. One transfer buffer is at most 1 MiB; object hashing and assembly stream in bounded reads. The oversized-reservation test rejects before accepting payload data.

## Operational state and safety

- The initial and final Docker inventories contain the same container IDs and resource sets. Differences in container listings are elapsed uptime only. No test containers, volumes, networks, Compose projects, or production files were created or removed.
- `noteos-web-1` remained healthy; `noteos-tailscale-noteos-1` remained running. MemoryOS container IDs and health states were unchanged. The running operational stack was not rebuilt or restarted. No production Sync API, database, or media endpoint was invoked.
- Source Compose explicitly sets `NOTEOS_AUDIO_SYNC_ENABLED=0`. No audio migration was run against the production SQLite volume; v2→v3 preservation was exercised only in temporary synthetic SQLite fixtures, which the tests removed.
- The owner’s previously accepted Phase 08.2B text pilot is not repeated or re-certified here. Synthetic text-pull and existing sync regression suites pass. No physical iPhone audio test was performed.

## 28-scenario acceptance map

See [acceptance-matrix.md](acceptance-matrix.md) for the scenario-by-scenario evidence mapping. Chromium recorder checks and server/client fixture tests are synthetic; they are not physical-device results.

## Remaining limits

- Audio transfer requires the separately gated server feature to be enabled by a later approved milestone. Production audio sync remains OFF.
- iOS background transfer is not guaranteed; transfers resume while the app is active/online. This milestone does not test iPhone Safari or PWA audio sync.
- Playback support depends on the receiving browser’s codec support. Original bytes and MIME are preserved; unsupported playback is not treated as data corruption.
- Remote audio deletion and garbage collection are intentionally absent. Content-addressed objects and conflict versions are retained to avoid removing a potentially sole copy.
- No Expo Native sync, STT, AI processing, or external storage was added.

## Git and release

Baseline and fetched `origin/main` before commit: `10da387bce75c6bc9e5e5a6efdd9d6f4af020617`. Source changes and this one review ZIP are intended for a single commit on existing `main`, followed by push. Pre-existing deletions under the 08.2A/08.2A.1 review artifacts are preserved and excluded from staging.

## Rollback

1. Keep `NOTEOS_AUDIO_SYNC_ENABLED=0` (the shipped default) to disable audio routes without affecting text Sync.
2. Revert the implementation commit to restore the previous app code. Do not remove `media/` files or drop v3 tables if the feature is ever activated; first retain the complete SQLite database and media directory together for recovery review.
3. This milestone did not run the migration or create media files in the production volume. The only v3 migrations are temporary synthetic fixtures.

## Phase boundary

Stop after Phase 08.4A synthetic acceptance. Real-device activation/audio sync remains Phase 08.4B and is not started here.
