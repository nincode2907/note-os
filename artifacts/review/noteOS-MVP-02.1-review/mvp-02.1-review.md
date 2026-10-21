# noteOS MVP-02.1 — Recording Session Safety Review

**Date:** 2026-10-21
**Scope:** R-01 live recording ownership, R-02 stale recovery, and directly related deletion/start/stop races.
**Runtime:** macOS 15.7.7, Node.js 24.21.0, Chromium 156.0.8078.4 with fake microphone.
**Verdict:** R-01 PASS; R-02 PASS in the tested Chromium environment. Physical microphone, Safari, iPhone, and actual process-kill behavior remain unverified.

## Findings and fixes

### R-01 — Live recording ownership: PASS

Previously, a component treated a `sessionStorage` owner ID as proof of ownership and marked every unfinished record with that ID interrupted during initialization. Copied storage IDs and component remounts could therefore rewrite a live session. A second storage path also relied on an IndexedDB active-state check alone.

Audio sessions now hold an exclusive Web Lock named for the note from before microphone acquisition through the final `dataavailable` write and recording-status commit. The lock is the ownership authority; `ownerId` is now per-recording metadata only. A competing tab or component cannot start a second recording for the same note. The existing IndexedDB transaction guard remains in place as a second check. Permanent note deletion and recording deletion now reject unfinished recordings, preserving already committed chunks.

When Web Locks are unavailable, starting a new recording fails closed. Unfinished records remain intact and the UI offers explicit manual partial recovery with a confirmation that all recording tabs are closed. When Web Locks are supported, manual recovery and startup recovery both first acquire the note lock.

### R-02 — Stale recovery: PASS in Chromium

The time-based `recoverStale()` path was removed. Age is no longer treated as evidence that a tab is dead. Startup enumerates unfinished records and marks one interrupted only after acquiring its note lock. A live recording or paused recorder keeps that lock, even with deliberately stale `updatedAt` metadata. A reload releases the former page's lock, allowing persisted chunks to be recovered as partial audio. Chunk records are not deleted or rewritten during recovery.

No IndexedDB schema migration was needed. Existing v2 databases and recording metadata remain readable; tests cover the v1-to-v2 additive upgrade and byte preservation of an existing note.

## Additional safety checks

- Per-note lock and IndexedDB active-state transaction prevent two starts for one note.
- A copied `sessionStorage` ID grants no authority.
- A second tab's initialization does not interrupt a live or long-paused session.
- A trashed parent note cannot be permanently deleted while a recording is unfinished.
- An unfinished recording cannot be deleted from another tab.
- Stop waits for queued chunk writes before committing the terminal status and releasing the lock.
- Lock release after Stop permits a second tab to start a new recording.
- Unsupported Web Locks preserves unfinished state and blocks new recording.
- Cross-tab rename remains allowed; it changes presentation metadata only.

## Test matrix

| Check | Result | Evidence |
|---|---|---|
| MVP unit suite | PASS — 31/31 | `npm run test:mvp` |
| Document suite | PASS — 31/31 | `npm run test:documents` |
| MVP-01.2 browser regressions | PASS — 13 scenarios | Chromium fake browser, `/tmp/noteos-mvp012-regression` |
| MVP-02 + MVP-02.1 browser suite | PASS — 10/10 scenarios | Chromium 156 fake microphone; `artifacts/review/noteOS-MVP-02.1-review/browser-results.json` |
| New ownership and lock unit cases | PASS | Included in MVP unit suite |
| Typecheck | PASS | `npm run typecheck` |
| Production build | PASS | `npm run build`; existing Next.js multiple-lockfile workspace-root warning only |
| `git diff --check` | PASS | No whitespace errors |
| UI state capture | PASS via Playwright screenshot | `artifacts/review/noteOS-MVP-02.1-review/unsupported-locks-recovery-state.png` |
| UI Lens runner | BLOCKED | Existing runner could not resolve `ui-lens/packages/contracts/src/index.js`; equivalent Chromium screenshot was captured by the passing browser regression instead. |
| Docker Gate 1 Playwright integration suite | NOT RUN | This suite targets sync candidate services. No Gate 1 containers were running; MVP audio browser regressions ran directly against the local Web spike. |

The first expanded browser run had one timeout while stopping the second simulated tab's recording; rerunning the complete suite passed all ten scenarios with zero console errors, page errors, or external requests. The stop helper now reports page content if this wait fails again.

## Runtime limits and remaining risk

- Browser evidence is synthetic Chromium 156 on macOS 15.7.7. Fake microphone audio does not establish physical microphone fidelity.
- Browser reload exercised lock release and recovery. Playwright did not simulate an operating-system process kill at an arbitrary point in the MediaRecorder event queue; data not yet committed to IndexedDB remains outside the recovery guarantee.
- Web Locks behavior was verified in Chromium only. Where unavailable, the implementation preserves state and blocks recording. Manual recovery depends on the user's explicit confirmation that all recorder tabs are closed.
- Safari and real iPhone behavior are untested; do not claim support based on these results.
- No cloud AI, STT, telemetry, backend service, or production UI was added.

## Recommendation

Accept MVP-02.1 for ChatGPT architecture review, subject to retaining the explicit browser and process-death limitations above. MVP-02 can then be considered for acceptance once the lead architect reviews this audit. This work stops at MVP-02.1; it does not start STT, AI, Sync Engine work, or MVP-03.

## Reproduction

From the repository root:

```sh
rtk npm --prefix spikes/phase-00/gate1/web run test:mvp
rtk npm --prefix spikes/phase-00/gate1/web run test:documents
rtk npm --prefix spikes/phase-00/gate1/web run typecheck
rtk npm --prefix spikes/phase-00/gate1/web run build
```

Start the local Web spike with `rtk npm --prefix spikes/phase-00/gate1/web run dev`. In another terminal run:

```sh
NOTEOS_MVP02_EVIDENCE=/tmp/noteos-mvp021-browser rtk npm --prefix spikes/phase-00/gate1/web run test:audio-browser
NOTEOS_TEST_OUTPUT=/tmp/noteos-mvp012-regression rtk node spikes/phase-00/gate1/web/scripts/mvp-01.2-browser.mjs
```

Both browser suites use Chromium and synthetic media; they do not require or test physical audio hardware.
