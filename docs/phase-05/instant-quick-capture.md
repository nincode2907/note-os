# Phase 05 — Instant Quick Capture

**Status:** Automated acceptance passed; physical iPhone verification pending.

**Branch:** `main`

**Expo:** SDK 57.0.31, retained.

## Delivered

- Web Home and iPhone Home now have direct Quick Text capture. Inputs are trimmed only at the edges, canonical v1 note bodies preserve all meaningful content, and titles come from the first meaningful line with an `Untitled note` fallback.
- IndexedDB and SQLite writes are idempotent. A separate sequence guarded capture draft survives backgrounding and save failure without touching the editor recovery journal. A stale save completion cannot clear newer input.
- Quick Voice requests microphone access before creating a note. Finalized audio is journaled with its note and archive metadata, then committed with recording rows in one SQLite transaction. Home and the existing editor share an app-wide recording ownership lock. A finalized file remains retryable if a commit fails.
- Captured notes remain ordinary revision-zero canonical notes. Full Archive V2 carries notes and associated recordings. Legacy JSON V1 continues to carry notes only, with labels corrected to state the difference.
- Existing rich-text editor, backup V2, trash, pin, search, and revision semantics remain available.

## Automated evidence

Environment: macOS Darwin 24.6.0, arm64; Node.js v24.21.0; Chromium 156.0.8078.4. Browser screenshots use 1440×1000 desktop and 390×844 phone-width viewports. These are browser viewport checks, not iPhone screenshots.

| Gate | Result |
|---|---|
| Mobile test suite | PASS — 49/49 |
| Web test suite | PASS — 70/70 |
| Mobile TypeScript | PASS |
| Web TypeScript | PASS |
| Expo install compatibility | PASS — dependencies up to date |
| Expo Doctor | PASS — 21/21 checks; doctor reported it could not fetch bundled native modules |
| Offline Tiptap editor bundle | PASS — 404,803 bytes |
| Chromium editor check | PASS — canonical round trip, formatting, task toggle, IME deferral, no external requests |
| iOS JavaScript export | PASS — Expo SDK 57 bundle, 3.2 MB Hermes output |
| Quick Capture browser check | PASS — recovery after reload, empty guard, double-save idempotence, Unicode canonical save, independent notes, editor open, responsive layout, zero console errors/external requests |
| Quick Capture + Full Archive V2 | PASS — canonical Unicode note and associated audio present in verified V2 export |

Detailed command output is in `artifacts/review/noteOS-Phase05-Quick-Capture-review/evidence/logs/`. Screenshots are in the same package's `evidence/` directory.

## Physical iPhone checklist — PENDING

No physical iPhone was exercised in this run. Confirm each item on the user's device before marking complete:

- [ ] Launch the existing Expo Go SDK 57 app and focus Home capture.
- [ ] Capture and save a note combining Vietnamese and Japanese text; restart and confirm it remains.
- [ ] Save several notes quickly and confirm each appears once.
- [ ] Record a short voice idea, stop, open the note, and play it.
- [ ] Background and reopen during an unsaved text capture; confirm the draft returns.
- [ ] Confirm Quick Capture does not disrupt the full Tiptap editor or its recovery behavior.
- [ ] Export a Full Archive V2 and confirm notes and audio are included.

This report makes no claim of physical-device audio, permission, lifecycle, or screenshot verification. Immediate OS termination protection is best effort and depends on the most recent durable capture checkpoint.

## Reproduction

Use Node.js 20.19.4 or newer (validated on v24.21.0). From `spikes/phase-00/gate1/mobile`, run `npm test`, `npm run typecheck`, `npm run expo-check`, `npx expo-doctor`, `npm run build:editor`, `npm run test:editor-browser`, and `npm run export:ios`. From `spikes/phase-00/gate1/web`, run `npm run test:mvp`, `npm run typecheck`, and `npm run test:quick-capture-browser` while the local Web server is available.

## Limits

- Quick Voice platform behavior, microphone denial, audio interruptions, playback, and real background transitions still require the pending physical iPhone checklist.
- Expo Doctor passed all 21 checks but emitted a warning that bundled native module metadata could not be fetched in this environment.
- No AI, transcription, sync, Share Sheet, or widget work was included.
