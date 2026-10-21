# noteOS MVP-04.1 — Final Corrections & Native Readiness

**Captured:** 2026-10-21 (Asia/Ho_Chi_Minh)  
**Status:** F-04.1-A/B SOURCE FIXES PASS · STATIC/SYNTHETIC CHECKS PASS · NATIVE GATES A/B/C BLOCKED

## Scope and outcome

This is the approved final correction slice for the Phase 00 iPhone prototype. It changes no canonical schema, Web IndexedDB behavior, dependency versions, or production code. No MVP-05, OS upgrade, Xcode installation, developer-directory change, simulator test, or physical iPhone test was performed.

### F-04.1-A — Explicit Discard removes the matching recovery journal

The editor now cancels the debounce, closes and settles the serialized journal writer, and deletes only the current note's expected revision. A failed or stale-revision cleanup keeps the user in the editor and reports the error; the writer can resume after a failed cleanup. A successful discard keeps the writer closed so navigation cannot recreate the discarded draft. Save commits the note first and clears only the journal whose base revision matches the saved note's expected revision. A journal-clear failure is reported as a post-commit cleanup issue; it does not misreport the already committed note as unsaved.

### F-04.1-B — Lifecycle and schema editing policy

Only active schema-v1 notes with supported native content are editable through the body editor. Archived and trashed notes are read-only and display: “Archived and trashed notes are read-only. Restore this note from Home before editing.” `saveNote()` checks schema, lifecycle and expected revision inside the exclusive SQLite transaction and guards its update with the active lifecycle and revision. Lifecycle transitions stay separate from content saves; unknown/future-schema document data is not rewritten by this correction.

These source checks preserve revision CAS. Tests exercise policy and orchestration helpers; they do not prove the transaction behavior of Expo SQLite.

## Regression evidence

| Scenario | Result | Test boundary |
|---|---|---|
| Normal edit → Discard → reopen leaves no draft | PASS | Synthetic journal/helper test |
| Pending/in-flight write settles before Discard; no recreation after navigation | PASS | Synthetic delayed-writer test |
| Stale revision is not deleted; writer resumes on failed cleanup | PASS | Synthetic revision-guard test |
| Keep Editing preserves unsaved changes | PASS | Synthetic journal test |
| Matching journal clear occurs only after successful note commit | PASS | Synthetic operation-order test |
| Active schema-v1/supported content is editable; archived and trashed are read-only | PASS | Pure policy test |

Full current suite: **17 passed, 0 failed, 0 skipped**. TypeScript, Expo dependency check, and iOS JavaScript export passed. Exporting JavaScript is not a native compile or simulator test.

## Read-only host preflight

No backup contents were opened or read. No system settings were changed.

| Check | Observed | Assessment |
|---|---|---|
| Mac model | MacBook Air (M2, 2022), model identifier `Mac14,2`; Apple M2; 16 GB RAM | Tahoe-compatible hardware: PASS |
| Current OS | macOS 15.7.7, build 24G720 | Does not meet Xcode 26.4.1's minimum OS |
| Available disk | `/`: 460 GiB total, 75 GiB free (14% used) | Ample relative to the current App Store Xcode listing of 3.1 GB; simulator runtimes and installed footprint add space, so recheck before installation |
| Installed developer tools | `xcode-select` points to `/Library/Developer/CommandLineTools`; full `xcodebuild` unavailable; `simctl` unavailable | Native build BLOCKED |
| Software Update offers | CLI preflight listed Safari 27.0, macOS Sequoia 15.8.1 and macOS 27.0.1; no Tahoe 26.x offer appeared | The listed macOS 27.0.1 is above the Xcode 27.1 minimum by version number, but confirm its exact OS name/build and compatibility in System Settings before any change |
| Time Machine status | Not currently running; no destinations configured | Backup readiness BLOCKED |
| Latest backup check | `tmutil latestbackup` could not mount a destination (code 17) | No successful recent backup was verified; do not upgrade yet |
| Connected iPhone | No physical iPhone available for this validation | Gate C BLOCKED |

## Compatibility and safe path

Expo's [SDK 58 reference](https://docs.expo.dev/versions/v58.0.0/) requires Xcode 26.4 or later. Apple's [Xcode system requirements](https://developer.apple.com/xcode/system-requirements) currently list Xcode 27.1 as the newest stable release in the table (27.2 is marked RC); Xcode 27.1 requires macOS Tahoe 26.6 or later. The Xcode 26.6 row supports Tahoe 26.2–26.x, but the App Store listing now shows Xcode at 3.1 GB and requiring macOS 26.6 or later, so its current distribution appears to track a newer build. Apple's [Tahoe compatibility list](https://support.apple.com/en-ca/122867) includes MacBook Air (M2, 2022). Before download, verify that Software Update's macOS 27.0.1 offer is a compatible Tahoe build at least 26.6 and obtain the stable Xcode 27.1 build Apple lists; no installation was attempted.

Recommended path for this host:

1. Configure a Time Machine destination and verify a successful backup without inspecting its contents. Apple recommends backing up before an OS install ([Apple macOS update guidance](https://support.apple.com/en-us/108382)).
2. After the backup is verified, check System Settings → General → Software Update and confirm the exact name/build for the listed macOS 27.0.1 offer. The required pairing for stable Xcode 27.1 is Tahoe 26.6 or later; use the offer only if Apple's compatibility information confirms it meets that requirement.
3. With explicit user approval for the required OS change, update only to the confirmed compatible OS, obtain stable Xcode 27.1 from Apple, and recheck disk space. Select its developer directory only after installation is complete and approved.
4. If Software Update does not offer a compatible OS, use another Mac already on a supported Tahoe version with a compatible full Xcode, or wait for an Apple-supported host path. Do not downgrade Expo SDK 58 or install a mismatched Xcode to bypass the gate.

The preflight intentionally stops before all system changes. It does not authorize or perform an OS update, Xcode install, `sudo` operation, or developer-directory switch.

## Gate status

| Gate | Status | Missing evidence |
|---|---|---|
| A — SQLite, notes and UI | **BLOCKED** | Compatible full Xcode and simulator; actual migrations, persistence, transaction rollback/CAS, recovery, lifecycle and file-cleanup runs |
| B — Native audio | **BLOCKED** | Compatible full Xcode/simulator; native recording, finalized Documents URI, playback/relaunch and interruption results |
| C — Physical iPhone | **BLOCKED** | Connected and authorized iPhone, local signing, and device/iOS-specific save, offline, microphone, suspension/resume evidence |

No native screenshots were captured. The 23 dependency advisories from the prior audit remain visible in the linked hotfix report; no forced audit fix was run.

## Reproduction and versions

Environment: macOS 15.7.7 (24G720), Node 24.21.0, npm 11.19.0, Expo 58.0.16, expo-sqlite 58.0.13, expo-audio 58.0.9.

| Command | Result |
|---|---|
| `rtk npm --prefix spikes/phase-00/gate1/mobile test` | PASS — 17 tests, 0 failures, 0 skipped |
| `rtk npm --prefix spikes/phase-00/gate1/mobile run typecheck` | PASS — `tsc --noEmit` |
| `rtk npm --prefix spikes/phase-00/gate1/mobile run expo-check` | PASS — dependencies up to date |
| `rtk npm --prefix spikes/phase-00/gate1/mobile run export:ios` | PASS — JS/assets only; Metro 978 modules, 3.1 MB bundle |
| `rtk git diff --check` | PASS |
| Native Xcode build / simulator / real iPhone | BLOCKED — as above |

Tests and source: `spikes/phase-00/gate1/mobile/tests/mvp04-1-safety.test.mjs`, `mobile-safety.mjs`, `store.ts`, and `App.tsx`. All tests are pure helper/synthetic orchestration tests; none are represented as Expo SQLite or physical device evidence.

Stop at Phase 00. Do not start MVP-05 until architecture review and the remaining native evidence are complete.
