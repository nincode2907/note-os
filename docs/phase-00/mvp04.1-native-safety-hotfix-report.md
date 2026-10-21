# noteOS MVP-04.1 — Native Safety Hotfix

**Status:** SOURCE HOTFIX IMPLEMENTED · automated checks PASS · native Gates A/B/C BLOCKED  
**Scope:** Phase 00 native prototype only. No MVP-05, cloud, sync, AI, STT, or background audio work.

## Result

The hotfix adds synchronous recording-session locks, revision-guarded metadata operations, exclusive SQLite transactions, queued post-commit audio cleanup, and a versioned recovery-draft journal. The existing Expo Audio `directory: 'document'` option remains unchanged. Unsupported/future document content remains read-only; lifecycle and pin metadata operations do not call the body editor.

SQLite and the filesystem do not share an atomic transaction. Note/audio metadata deletion commits first and records cleanup URIs in SQLite. A later file deletion removes the queue entry only after success; startup retries queued cleanup. SQLite busy/locked errors propagate to callers and are not treated as guaranteed waits.

## Source findings and resolution

| Approved brief area | Resolution | Evidence / remaining limit |
|---|---|---|
| Recording navigation and duplicate start/stop | Synchronous `RecordingSessionGate`; `beforeRemove` blocks header, swipe and programmatic removal while not idle; complete status follows file existence/size verification and `saveRecording` success. | Synthetic gate tests PASS. No microphone, navigation gesture, stop failure, or AppState native test. Background handling is best effort. |
| Note permanent deletion | Requires expected revision and `trashed`; exclusive transaction collects URIs, enqueues cleanup, removes recordings and revision-guarded note row. | Source review + TypeScript PASS. Native SQLite rollback, stale revision, non-trashed, cascade and crash-in-between tests BLOCKED. |
| Individual audio deletion | Removes recording metadata and queues URI in exclusive SQLite transaction before touching file. | Source review + TypeScript PASS. Native failure/interruption test BLOCKED. |
| SQLite transaction safety | Import and multi-step mutations use `withExclusiveTransactionAsync`; all transactional reads/writes use callback `txn`; schema v2 adds journal/cleanup tables without dropping existing tables. | TypeScript PASS, Expo SDK check PASS. Expo SQLite native concurrency, duplicate rollback, concurrent import/save and `SQLITE_BUSY` tests BLOCKED. Migration execution against an existing device database BLOCKED. |
| Recovery draft journal | Version 1 draft stores base revision, title, canonical body/checklist, tags text and pin; 500 ms debounce, latest-wins serialized writer and best-effort AppState flush. Restore is offered only for the same active schema-v1 revision; stale draft is preserved until explicit discard. Successful save clears the matching journal in the same SQLite transaction. | Pure helper tests PASS. Native remount, actual journal persistence, DB save failure and clear-after-commit tests BLOCKED. A keystroke within the debounce window, a terminated process, or an unresolved async write can still be lost; background flush is best effort. |
| Pin/tag/search parity | Shared `sortNotes`, `filterNotes` and `normalizeTagList`; synchronous pending-pin lock; pin increments metadata revision but leaves `updatedAt` unchanged; pin supports valid schema-v1 rich-text documents. Invalid duplicate tags fail save while the recovery draft preserves the unsaved editor state. | Helper tests PASS; no native UI validation. |
| Legacy Web v1 backup defaults | View model supplies `pinned=false` and `tags=[]`; storage read does not update the imported raw record. | Regression test PASS for view defaults and unchanged input object. Native import/render not exercised. |
| Lifecycle/audio hardening | Rejects trashed→archived; lifecycle updates retain canonical document data; rename rejection is caught; player mounts only for selected audio; missing/empty audio is checked before play/share. | Source review + TypeScript PASS. Native lifecycle/player/file behavior BLOCKED. |
| Expo Audio SDK 58 directory option | Kept `directory: 'document'`; no move/copy workaround added. | SDK 58.0.9 type/API was inspected. Actual persisted URI, file size and reopen behavior BLOCKED. |

## Verification evidence

Environment: macOS 15.7.7 (24G720), Node 24.21.0, npm 11.19.0, Expo 58.0.16, expo-sqlite 58.0.13, expo-audio 58.0.9. The project installed SDK-matched dependencies.

| Check | Result |
|---|---|
| `npm run expo-check` | PASS — dependencies up to date |
| `npm run typecheck` | PASS — `tsc --noEmit` |
| `npm test` | PASS — 11 tests, 0 failures |
| `npm run export:ios` | PASS — JS export only; 978 modules, 3.1 MB iOS bundle |
| `git diff --check` | PASS |
| `npm audit` | FAIL — 23 findings: 15 high, 8 moderate, 0 critical |
| iOS native build / simulator / iPhone | BLOCKED — `xcodebuild` requires full Xcode; `simctl` is unavailable; no physical iPhone was available |

Automated tests cover pure state/policy helpers, shared backup parsing, safe legacy defaults, pinned sorting, lifecycle rejection, recovery revision decisions, latest-wins draft writes, and duplicate-tag validation. They do **not** execute Expo SQLite or native iOS APIs. The requested database failure/race/rollback cases remain native validation work; no mocks are presented as SQLite or iPhone evidence.

## Dependency audit

`npm audit` and `npm audit --omit=dev --audit-level=high` both report 23 findings (15 high, 8 moderate). The underlying advisories and installed paths are:

- `braces@3.0.3` → `micromatch@4.0.8` → `metro-file-map@0.87.1` → Expo Metro/CLI. Toolchain/build-time path; no patched version is reported by the advisory feed used by npm. Runtime reachability from the exported app bundle was not established.
- `node-forge@1.4.0` → `@expo/code-signing-certificates@0.0.7` / `@expo/cli@58.1.13`. Signing/build-time path; runtime reachability was not established.
- `uuid@7.0.3` → `xcode@3.0.1` → `@expo/config-plugins@58.0.9` → Expo config tooling (also included through `expo-sharing`). Toolchain/config path; runtime reachability was not established. The advisory lists `uuid@11.1.1` as patched, but this lock resolves the v7 range; compatibility of an override with `xcode@3.0.1` has not been verified.
- npm’s proposed `--force` remediation downgrades Expo to 44.0.6 (and React Native to 0.72.17 in the reported dependency graph), incompatible with the approved SDK 58 baseline. No forced fix or unrelated dependency downgrade was applied. Compatible remediation remains unresolved.

The count is package-graph based; the advisories above are not evidence that their vulnerable functions are reachable from the noteOS runtime. Conversely, lack of demonstrated reachability is not a claim of zero exploitability.

Advisories: [braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [node-forge GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), [uuid GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

## Native validation checklist — BLOCKED

Run on an Xcode simulator and a real iPhone before treating MVP-04.1 native behavior as validated:

- Record then header Back, swipe Back and programmatic navigation with no text changes; double-tap Record and Stop.
- Background while permission is pending, preparing, recording, stopping and finalizing; inject recorder-stop and SQLite-save failures.
- Exercise stale revision, non-trashed delete, transaction rollback, recording-row deletion, cleanup failure and process interruption after metadata commit.
- Exercise duplicate import rollback, concurrent import/save, and observed `SQLITE_BUSY` behavior using isolated test data.
- Edit without Save, remount, Restore/Discard/Keep; test stale revision, failed save, successful clear, explicit discard, and a second edit during a delayed journal write.
- Verify legacy backup import, rich-text pin, `updatedAt` stability, tags and search; verify rename failure and missing audio.
- Verify `directory: 'document'` URI, nonzero file size, close/reopen/playback, and repeat after app restart.

Do not reset user data. Use a fresh isolated prototype database for destructive scenarios. Report actual device/iOS version, iterations, outcomes, and logs when these gates can run.

## Reproduction

From repository root:

```sh
rtk npm --prefix spikes/phase-00/gate1/mobile run expo-check
rtk npm --prefix spikes/phase-00/gate1/mobile run typecheck
rtk npm --prefix spikes/phase-00/gate1/mobile test
rtk npm --prefix spikes/phase-00/gate1/mobile run export:ios
rtk git diff --check
rtk npm --prefix spikes/phase-00/gate1/mobile audit
```

The iOS export produces JavaScript/assets only; it is not an iOS binary or simulator result. Stop at Phase 00 and hand off for architecture review; do not start MVP-05.
