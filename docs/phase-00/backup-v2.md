# Backup V2 — complete Web notes and audio archive

Status: **PASS for automated durability and Chromium validation**; benchmark measurements and final handoff are recorded below. Scope is the existing Phase 00 Web prototype. Native source, Expo SDK 57, canonical document schema, database version, and V1 `makeBackup`/`parseBackup` are unchanged.

## Storage and restore guarantees

`createNotesRepository().snapshotArchive()` queues reads of `notes`, `recordings`, and `recordingChunks` in one IndexedDB readonly transaction over database `noteos-mvp-01` version 2. The snapshot includes active, archived and trashed notes with their original revisions. It does not invoke recovery or rewrite recording statuses. A recording/paused session blocks V2 export, including sessions owned by another tab. Missing parents, duplicate IDs, inconsistent counts, gaps, mismatched MIME types, and complete recordings without saved bytes also block export rather than silently skipping data. Interrupted/failed recordings retain their saved bytes and original status; zero-byte failed recordings retain metadata with an explicit warning.

Restore parses, bounds-checks, hashes and validates the complete archive before opening a write transaction. An immutable verified snapshot is required by `importArchive`. The commit then uses one readwrite transaction over all three stores; it awaits only IndexedDB requests and synchronously queues the additions. Transaction/quota errors abort all queued writes. There is no database replacement, clearing, automatic schema migration, or overwrite.

- **Skip:** any note, recording or chunk ID conflict aborts the entire import.
- **Merge:** new note groups are added together. If the note exists, all incoming recordings for that note are skipped. If a recording or chunk ID conflicts even under a new note ID, that entire incoming note group is skipped. Counts report imported/skipped notes and recordings. Existing revisions, audio and metadata are untouched.
- Repeating Merge imports no duplicate media. Repeating Skip fails without additions.
- Unknown canonical document schemas remain stored unchanged and read-only under the existing validation policy. Additional recording JSON fields are preserved after validation (including an `extensions` object); no Audio Anchors behavior is added.
- Legacy V1 remains notes-only and uses the existing parser/repository import semantics. The file picker detects content rather than trusting filenames or declared MIME. Archive and legacy metadata inputs are limited to 16 MiB per JSON file.

## Actual format

The download is an **uncompressed POSIX ustar `.tar`**, with fixed ASCII-generated paths; note/recording IDs are never used as archive paths. Standard `tar -tvf` successfully lists the synthetic round-trip file. The exporter sorts notes and recordings by ID, chunks by sequence, uses fixed header metadata, and is deterministic for the same snapshot and export timestamp. Audio is not transcoded, compressed, or base64 encoded.

```text
manifest.json
manifest.sha256
notes.json
recordings.json
blobs/000000.webm
blobs/000001.m4a
...
```

`notes.json` is an array of original note records and is authoritative for canonical JSON, titles, tags, pinned state, lifecycle, revisions, and timestamps.

`recordings.json` is an array with this shape:

```json
{
  "recording": {
    "id": "original-recording-id", "noteId": "original-note-id",
    "title": "Ghi âm — 東京", "mimeType": "audio/webm;codecs=opus",
    "status": "interrupted", "ownerId": "original-owner-id",
    "createdAt": 100, "updatedAt": 200, "durationMs": 2000,
    "chunkCount": 2, "extensions": { "validatedFutureMetadata": true }
  },
  "file": "blobs/000000.webm",
  "chunks": [
    { "id": "original-chunk-0", "sequence": 0, "offset": 0, "byteLength": 123, "mimeType": "audio/webm;codecs=opus" },
    { "id": "original-chunk-1", "sequence": 1, "offset": 123, "byteLength": 456, "mimeType": "audio/webm;codecs=opus" }
  ]
}
```

Each audio file is the byte-for-byte concatenation of that recording's original ordered chunks. Import slices the Blob at the validated boundaries, restoring original chunk IDs, sequences, bytes and Blob MIME types. These MediaRecorder chunks are not claimed to be independently finalized audio files. Partial recordings may be unplayable even when saved bytes are intact. A terminal recording with no saved chunks uses `file: null` and `chunks: []`.

`manifest.json` contains `format: "noteos.archive"`, `version: 2`, ISO `exportedAt`, `sourcePlatform: "web"`, `counts` (`notes`, `recordings`, `chunks`), `files` (`path`, `byteLength`, lowercase hex SHA-256), `warnings`, and `skippedEntries: []`. Exports never silently skip entries. Notes, recording metadata and every audio file are hashed. The manifest itself is hashed in `manifest.sha256` (64 ASCII hex bytes). That checksum sidecar is the root checksum and cannot recursively checksum itself. Checksums detect accidental corruption; this is not a signature or encrypted/authenticated container.

The constrained importer rejects links, directories, PAX/GNU extensions, traversal/absolute paths, duplicate paths, unsafe metadata keys, unreferenced files, missing files, truncation, invalid headers/padding, bad lengths, bad checksums, unknown versions and inconsistent relationships/ranges. It never extracts files to disk or interprets imported text as HTML.

## Limits and memory decision

Limits: 1 GiB total TAR size, 512 MiB per entry/audio recording, 16 MiB per JSON entry/legacy JSON, 10,004 entries, 50,000 notes, 10,000 recordings, 100,000 chunks, and 64 levels of JSON metadata nesting. Supported audio bases map explicitly to `webm`, `ogg`, `m4a` (MP4/x-m4a), `wav`, `mp3` (MPEG), `aac`, and `flac`. Original MIME strings are preserved; unsafe/unknown MIME values are rejected. Filenames and MIME labels are not proof that damaged audio is decodable.

Options considered:

| Option | Decision |
|---|---|
| JSZip / compressed ZIP | Not chosen: unnecessary compression work for encoded audio and additional buffering/dependency surface. |
| fflate ZIP | Small and viable, but compression/ZIP complexity offers little value for this byte-preserving milestone. |
| Uncompressed ustar + Blob slices | Chosen: simple regular-file format, standard readers, no decompression bomb, bounded header parser and no aggregate audio Uint8Array. |
| WebCrypto `digest` per recording | Not chosen: requires the entire recording in memory before hashing. |
| Incremental SHA-256 from `@noble/hashes` | Chosen: exact version 2.4.0, MIT, no transitive dependencies, browser support, Node >=20.19 compatible with the Docker Node 22.21.1 runtime. Only the SHA-2 module is imported (about 19 KB source plus shared utilities). |

SHA-256 reads one 1 MiB Blob slice at a time and retains incremental hash state. Archive creation uses Blob parts; import uses Blob slices. All record metadata and Blob references are retained for the snapshot/verified import, and JSON is parsed in memory. Browser Blob construction, IndexedDB structured cloning, downloading, hashing and quota enforcement can allocate more memory or disk space; **fixed-memory and zero-copy behavior are not claimed**. A download object URL is retained for 60 seconds after the request; the browser may retain additional data. Large files may fail on constrained devices below the configured limits. Progress reports real stages/file counts without invented byte percentages.

## Verification and reproduction

```sh
docker compose -f docker-compose.backup-v2.yml build web checks
docker compose -f docker-compose.backup-v2.yml up -d web
docker compose -f docker-compose.backup-v2.yml run --rm checks
NOTEOS_TEST_URL=http://127.0.0.1:15710 node spikes/phase-00/gate1/web/scripts/backup-v2-browser.mjs
NOTEOS_TEST_URL=http://127.0.0.1:15710 node spikes/phase-00/gate1/web/scripts/backup-v2-benchmark.mjs
# UI Lens uses the installed sibling ui-lens tsx/Playwright runtime:
NOTEOS_TEST_URL=http://127.0.0.1:15710 ../ui-lens/node_modules/.bin/tsx spikes/phase-00/gate1/web/scripts/backup-v2-ui-lens.mjs
```

The Compose project `noteos-backup-v2` uses localhost port 15710, an isolated network, no live volumes, and synthetic nonpersistent Playwright contexts. The checks service mounts current app source read-only. Start the Web service before running the checks service to avoid concurrent Compose network-creation races on older Docker engines. No network/volume pruning is required. Existing safety, organization and audio browser scripts were run against this service with evidence redirected into the Backup V2 review directory.

Production build and TypeScript passed in Docker (Node 22.21.1, Next.js 16.4.2, React/React DOM 19.3.1). Web unit tests: **61/61** including 20 new archive tests. Canonical document tests: **31/31**. Browser V2 tests: **7/7** including rollback in real IndexedDB with an injected QuotaExceededError. Existing browser safety tests: **13/13**; organization tests: **8/8**; audio tests: **10/10**. Counts and diagnostics are recorded in the evidence. UI Lens: **2/2** captures at 1440×1000 and 390×844 with empty console/page/request diagnostics. Screenshots were visually inspected; mobile has no horizontal overflow.

The first audio regression run exposed an existing test waiter that could match chunks from a previous recording and stop a new session before it captured bytes. The waiter now requires the new recording's chunk; the complete audio suite subsequently passed **10/10**. No recording logic changed beyond correcting its backup-description copy. Initial failure evidence is retained.

Changed-scope data-model and security reviews traced snapshot consistency, collision serialization, atomic commit, untrusted TAR paths, bounded parsing, SHA verification, metadata validation and output escaping. No unresolved high/critical issue was found in these paths. Validation is not an independent security certification. No personal note data or real microphone input was used.

Browser coverage is Chromium 156.0.8078.4 on the recorded macOS 15.7.7 host. Firefox, Safari/WebKit, mobile browsers, and low-memory devices remain **BLOCKED / unmeasured**; no universal browser, physical-iPhone or absolute zero-data-loss claim is made. Recordings already absent or corrupt in local storage cannot be reconstructed from missing bytes. Local recovery journals outside these three IndexedDB stores and the native backup implementation are outside V2's defined data contract.

References: [noble-hashes primary documentation](https://github.com/paulmillr/noble-hashes), [WebCrypto digest input/memory behavior](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest). The pinned lockfile change adds only the selected hash package; no unrelated dependency upgrade or audit force-fix was performed.

## Measured archive scale

Environment: Apple M2, 8 logical CPUs, 16 GiB RAM, darwin 24.6.0 arm64; browser Chromium 156.0.8078.4; host Node v24.21.0. Three fresh browser processes per size, separate nonpersistent source/target contexts. Each dataset has 3 Unicode notes and 2 synthetic recordings (complete/interrupted), stored in 1 MiB chunks. Fixtures are synthetic byte sequences, not codec-valid playback samples. Every restored chunk was compared with an independent WebCrypto SHA-256 fingerprint. No failures.

| Audio dataset | TAR bytes | Export p50 / p95 | Import p50 / p95 | Maximum sampled summed RSS, export / import | Maximum JS heap, export / import |
|---|---:|---:|---:|---:|---:|
| 50 MiB | 52,443,136 | 1.515 / 1.573 s | 1.913 / 1.964 s | 494.3 / 394.8 MiB | 7.9 / 5.9 MiB |
| 200 MiB | 209,747,968 | 5.413 / 5.893 s | 4.462 / 5.014 s | 881.1 / 597.5 MiB | 7.0 / 5.9 MiB |

p95 uses nearest rank with n=3 (the maximum observed value); it is not a robust production tail-latency estimate. Durations include UI interaction and download completion for export, and verification plus atomic commit for import; fingerprint comparison is outside timing. Browser process IDs come from CDP SystemInfo. RSS is summed with `ps` about every 100 ms; shared memory can be counted more than once and Blob-backed disk/cache storage is not fully attributed. JS heap is CDP Performance JSHeapUsedSize. Baselines and each sample count are in `verification/benchmark.json`. Export baselines include fixture creation and fingerprinting, which already allocated audio; these are whole-browser totals, not incremental archive-only memory. CPU utilization and storage peak were not measured. The measured results justify neither zero-copy/fixed-memory claims nor the configured 1 GiB limit on untested devices.

## Local handoff and rollback

After all required durability tests passed, the tested image was tagged `noteos-web-local` and only the related `noteos-web-1` service was recreated with `docker compose -f docker-compose.web.yml up -d --no-deps --no-build web`. The existing localhost service on port 15700 is healthy and its server-rendered `/backup` response contains Full Archive V2 and Legacy JSON V1. No real browser profile was opened. MemoryOS, Cross and other services and the Expo Metro process were not restarted or modified.

The previous Web image ID is saved at `artifacts/review/noteOS-Backup-V2-review/verification/previous-web-image.txt`. To roll back local code, tag that retained image ID as `noteos-web-local`, then run the same Web-only Compose `up` command. Source rollback can use `git revert <implementation-commit>` and a fresh Web build. No data deletion, IndexedDB clearing or volume reset is part of rollback; already imported notes/audio remain. The report and review package identify the implementation commit separately from the evidence-package commit. Stop after Backup V2 for architecture review.
