# noteOS Phase 04 — Native Backup V2 & Cross-Platform Archive Compatibility

**Source and automated compatibility: PASS. Physical iPhone acceptance: PENDING USER VALIDATION.** This report records local source, test, and export evidence. It does not claim Files, Share Sheet, playback, or the migrated on-device SQLite database were exercised on an iPhone.

## Implementation

- The iPhone uses the existing Web V2 POSIX ustar contract: `manifest.json`, `manifest.sha256`, `notes.json`, `recordings.json`, and `blobs/000000.<audio-extension>`. Manifest version stays `2`; `sourcePlatform` is `ios` for native export. The Web V2 reader now accepts `web` and `ios` while retaining its checksum, size, schema, MIME, and relationship validation.
- Native TAR output and parsing use Expo SDK 57 `File.readableStream()` / `File.writableStream()`, with 64 KiB BYOB reads and writes, incremental SHA-256, bounded JSON metadata, and no audio base64 conversion or whole-archive byte array. TAR accepts regular files only and rejects traversal, links, duplicate paths, bad padding/checksums, unlisted entries, and entries beyond the V2 limits (1 GiB archive, 512 MiB per entry, 16 MiB JSON).
- Export reads all lifecycle states and raw canonical note records in one short SQLite metadata transaction. The transaction ends before file hashing. Each referenced recording must exist; completed files must be nonempty. Size and modification time are checked around the first hash pass, then bytes are rehashed as they stream into TAR to detect a file change before completion. Missing/corrupt audio blocks the full export.
- Restore verifies the entire archive before persistent writes, plans ID collisions, stages accepted audio to an import-specific directory, verifies staged byte counts and SHA-256, moves media to unique app-private filenames, then inserts note and recording rows in one exclusive SQLite transaction. An SQLite journal distinguishes staged and committed imports. Startup reconciliation removes only journaled uncommitted paths, verifies committed media, and leaves unrelated recordings untouched.
- `recording_archive_metadata` and `archive_imports` are additive SQLite v3 tables. Existing notes, recordings, recovery drafts, and queued file cleanup rows are not rewritten. The adapter retains imported Web metadata and source chunk descriptors. Native-created recordings export a compatibility `ownerId: "ios-local"`; unavailable duration is represented as `durationMs: 0` with `nativeProvenance.durationKnown: false`. Audio is not transcoded. Native export represents a local file as one archive chunk and preserves original source chunk metadata as provenance; chunk descriptor equality is not claimed.
- The Home backup controls expose Full Archive V2 export/restore and Legacy JSON V1 import/export. Restore offers Merge or Skip. Full archives are labeled unencrypted. Share Sheet completion is reported without claiming that the user saved the file. TAR input uses the iOS document picker.

## Verification

| Check | Result |
| --- | --- |
| Mobile tests | PASS — 43/43, including native TAR, import-plan, isolated `node:sqlite` migration/commit/rollback, and crash-recovery tests |
| Web MVP/archive tests | PASS — 62/62, including Web reading an iOS V2 manifest and existing Web archive regressions |
| TypeScript | PASS |
| Tiptap editor bundle and Chromium check | PASS — Chromium 156.0.8078.4 |
| Expo dependency check | PASS — installed versions match SDK 57 |
| Expo Doctor | PASS — 21/21; its network check warned that bundled native module metadata could not be fetched |
| iOS JavaScript/static asset export | PASS — 3.2 MiB JS bundle; local editor HTML bundled |
| Physical Files/Share Sheet, real SQLite migration, audio playback and app-restart checks | PENDING USER VALIDATION |

### Cross-platform fixtures

- Web V2 → native verification/staging: passed with synthetic audio split across ordered source chunks; the staged bytes and SHA-256 matched their exact concatenation.
- Native V2 → Web verification: passed. The Web V2 validator accepted `sourcePlatform: "ios"`, preserved canonical note JSON, and restored the native media as one logical chunk with the same audio SHA-256.
- Native V2 → native verification/staging: passed with unchanged audio bytes and note JSON.
- Rich Canonical v1 structures, Vietnamese/Japanese text, active/archived/trashed lifecycle values, interrupted recordings, future-schema note preservation, malformed TARs, checksum failures, ID collisions, duplicate imports, and storage/write/SQLite failure paths are covered by isolated synthetic tests.
- Legacy V1 note JSON remains notes-only and its existing import/export tests pass. Web IndexedDB persistence and Backup V2 UI were not changed.

### Synthetic stream measurement

Final automated run on Node `v24.21.0` generated and streamed a 32 MiB synthetic audio file into a counting sink without retaining TAR bytes: 33 MiB TAR, 64 KiB maximum write, 939 ms. Process RSS sampled every 5 ms was 88 MiB at start, 101 MiB peak, and 101 MiB at end. This includes the Node test process and synthetic fixture; it is not an iPhone/native filesystem measurement and is not a constant-memory claim. No private recordings were used.

## Physical iPhone checklist — pending

The runner has no Xcode or `simctl`; iPhone Mirroring is locked behind the Mac login. It did not access the iPhone or Expo Go. The checklist must be completed on the user’s device before Phase 04 is accepted:

1. In Expo Go, export a small Full Archive V2 and choose **Save to Files**. Confirm the app reports that the Share Sheet closed without claiming the file was saved.
2. Use isolated synthetic notes and recordings to restore the archive in Merge mode; repeat with Skip and a deliberate collision. Confirm existing records and audio are unchanged when Skip rejects.
3. Play restored audio and compare a rich formatted note, including Vietnamese/Japanese text, after restore.
4. Close and reopen the app; confirm notes and audio remain playable and no interrupted import prompt or orphan recording appears.
5. Cancel a document picker/share action and simulate a failed import with a corrupted archive. Confirm existing notes and recordings remain available.
6. Confirm `recording_archive_metadata` migrates the existing app database additively and its prior notes, audio rows, recovery drafts, and pending cleanup rows remain intact.

The existing Expo process on port `8085` was left running. Check `lsof -nP -iTCP:8085 -sTCP:LISTEN` before starting another server. When that port is free, use `npx expo start --go --lan --clear --port 8085`.

## Limits and known integrity behavior

- Expo SDK 57 file streams were verified in the installed package source and the JS export; actual iOS file-picker copies, document moves, native stream throughput, device disk quota behavior, and playback remain unmeasured.
- The SQLite migration/transaction body passed isolated SQLite tests, not against the user’s installed app database. It will run additively on next app launch; no user database was opened or modified in this run.
- Filesystem and SQLite cannot commit atomically together. The durable import journal plus staged/committed reconciliation handles termination between staging, moves, and the DB transaction. An unrecoverable/missing committed file is left visible as a recovery warning; the app does not silently delete its note row.
- Archives are unencrypted. The native path requires temporary free space for the output TAR on export and for staged media on restore; it reserves an additional 16 MiB when the SDK reports available space. The selected archive copy itself is already in the app cache during restore.
- The pinned Expo/RN/Metro toolchain still reports 15 high npm audit advisories. No forced SDK or dependency remediation was applied.

## Reproduction

From `spikes/phase-00/gate1/mobile`:

```sh
npm test
npm run typecheck
npm run build:editor
npm run test:editor-browser
npm run expo-check
npx expo-doctor
npm run export:ios
```

From `spikes/phase-00/gate1/web`:

```sh
npm run test:mvp
```
