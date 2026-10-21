# noteOS MVP-04 Native iPhone Prototype — Phase 00 Evidence

**Date:** 2026-10-21 (Asia/Ho_Chi_Minh)  
**Scope:** MVP-04 approved prototype, constrained by repository Phase 00 instructions. No production UI or MVP-05 work was started.

## Delivery summary

An isolated Expo iOS prototype now lives in `spikes/phase-00/gate1/mobile/`. It does not replace or write to the Web application's IndexedDB. The app source includes a notes home, editor navigation, create/open, title/body edit for the native subset, checklist edits, tags, pin, search, archive, trash, restore, permanent-delete confirmation, manual notes backup import/export and a local audio panel with record/stop/save/play/rename/delete/export flows.

SQLite stores the complete Web-shaped note record JSON along with indexed revision, lifecycle and update columns. Each save is a revision-checked SQL `UPDATE`, and note backup import uses a transaction with an all-or-nothing duplicate ID check. Lifecycle changes use the same revision compare-and-swap while preserving future-schema document JSON. Database initialization creates schema version 1 and does not clear existing data.

The prototype imports the existing Web canonical document validator and backup parser. The native editor is deliberately restricted to plain paragraph blocks and one top-level, single-level task list whose item contains one plain paragraph. It does not flatten headings, marks, links, code, nested lists, attachments or unknown nodes. Those documents display read-only. Future schema documents remain byte-preserved as JSON values and cannot be content-edited.

Audio uses `expo-audio` and requests microphone access only after the user taps Record. The recorder is configured to store in the app document directory. Stop verifies the finalized path and non-zero size before inserting `complete` metadata. Leaving the foreground triggers a best-effort stop and an `interrupted` recording row. Audio bytes and SQLite metadata are separate writes, so an abrupt OS termination between them can leave a recoverable file or metadata that needs inspection. Audio is excluded from notes backup and shared individually.

## Versions and environment

- Host: macOS 15.7.7 (24G720), Node.js 24.21.0, npm 11.19.0.
- Expo SDK 58.0.16; React Native 0.88.0; React 19.3.0; Expo development client 58.0.14.
- Native modules: `expo-sqlite` 58.0.13, `expo-audio` 58.0.9, `expo-file-system` 58.0.10, `expo-document-picker` 58.0.4, `expo-sharing` 58.0.19.
- iOS, simulator and physical device OS: **not run**. `xcode-select -p` resolves to `/Library/Developer/CommandLineTools`; `xcodebuild` reports that full Xcode is required. `xcrun simctl` and `xcrun devicectl` are unavailable. No iPhone appeared as an attached device during preflight.
- Signing: no local Xcode project/device signing was possible. No Apple credential was requested, entered, stored or uploaded.

## Gate status

| Gate | Status | Evidence and outstanding requirement |
| --- | --- | --- |
| A — Native notes | **BLOCKED** | TypeScript and iOS JS export pass; four synthetic contract/editor tests pass. SQLite restart persistence, real note editing, lifecycle UI, duplicate import UX and actual app launch remain unverified because no simulator/iPhone native runtime is available. |
| B — Native audio | **BLOCKED** | `expo-audio` and file/metadata lifecycle are implemented and JS bundle resolves. Permission denial, microphone recording, interrupted recording, playback after relaunch, file export and deletion have not been exercised on iOS. |
| C — Actual iPhone | **BLOCKED** | No Xcode, `devicectl` or attached iPhone. Vietnamese/Japanese hardware keyboard, microphone, installed offline operation, diagnostics and device screenshots are not available. |

No iOS-native screenshots or diagnostics are included; producing them without a native runtime would misrepresent the evidence. Simulator and physical-iPhone results are not claimed.

## Verification performed

All commands ran from the mobile package using synthetic fixtures only:

| Check | Result |
| --- | --- |
| `npm run expo-check` | PASS — Expo reports dependencies up to date for SDK 58.0.16. |
| `npm run typecheck` | PASS — `tsc --noEmit`. |
| `npm test` | PASS — 4 tests, 4 passed, 0 failed. Tests cover plain paragraph/checklist round-trip, rich/future-schema read-only behavior, Web backup v1 shape/checklist state, malformed/future backup rejection. |
| `npm run export:ios` | PASS — Metro bundled 977 modules and emitted a 3.1 MB Hermes iOS JS bundle. This is a JS export, not an iOS native build or launch. |
| `npm audit --omit=dev --audit-level=high` | FAIL — 23 dependency advisories (8 moderate, 15 high) are present in the Expo/Metro build and config toolchain. Installed vulnerable paths include `braces@3.0.3`, `node-forge@1.4.0` and `uuid@7.0.3`. The `braces` and `node-forge` advisories currently list no patched versions; npm's forced suggestion would downgrade Expo to 44.0.6, so no unsafe bulk downgrade or override was applied. This is a toolchain finding, not evidence that the app itself is remotely exploitable. |
| Web regression suite | NOT RUN — no shared Web files were modified; this spike consumes the existing validator/parser. The shared backup parser is exercised by the mobile synthetic tests. |
| SQLite/native microphone/runtime performance, p50/p95, memory/disk use | NOT MEASURED — no simulator or device/native runtime is installed. |

The test fixture contains synthetic Vietnamese and Japanese text, note metadata, tags, a pinned note and checked/unchecked checklist items. No user notes or recordings were copied into artifacts.

## Reproduction and next evidence

From `spikes/phase-00/gate1/mobile/`, run `npm install`, `npm run expo-check`, `npm run typecheck`, `npm test`, and `npm run export:ios`. To complete blocked checks, install full Xcode with an iOS simulator, or attach an authorized iPhone and use local Xcode Personal Team signing; then follow `mobile/README.md` for prebuild/signing and run the Gate A/B/C flows with synthetic content. Capture genuine simulator/device screenshots and diagnostics at that point.

## Remaining limits / lead-architect review

- The native text editor supports plain paragraphs and simple checklist items only; richer schema-v1 notes are safely read-only.
- Gate A, Gate B and Gate C all remain BLOCKED pending native runtime evidence. UI behavior and actual SQLite migrations have not been observed on device.
- An OS kill during audio finalization may leave an orphan recording file; metadata/file operations are not atomic. Background and lock-screen recording are disabled and out of scope.
- Dependency audit needs review before any production/build-service use. The current alerts are in local Expo/Metro/config tooling. The upstream advisories list no patched release for [`braces <= 3.0.3`](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) and [`node-forge <= 1.4.0`](https://github.com/advisories/GHSA-86w9-cpqp-85rv); the moderate [`uuid@7.0.3`](https://github.com/advisories/GHSA-w5hq-g745-h8pq) path is through `xcode` config tooling. Recheck upstream and Expo's dependency tree during the Xcode validation session.
- There are no iOS screenshots in this handoff. Do not infer visual or hardware behavior from the JS bundle.
- Expo SDK 58.0.16 is pinned. The host lacks Xcode, so native dependency compilation and Personal Team signing still need validation on an Xcode-equipped Mac.

## Git delivery

Implementation commit: `adf9bb946eb54f27f1653d1f0ac63572989156c5` (`feat(mvp04): add native iPhone prototype spike`). The review bundle is prepared as a separate handoff artifact. Existing unrelated Phase 00 working-tree changes and previous review artifacts are preserved and excluded from the implementation commit.
