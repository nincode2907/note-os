# Phase 08.2A.1 — Sync Reliability Hardening

**Status:** PASS for synthetic web acceptance; BLOCKED for real iPhone and real-data validation.  
**Baseline:** `6eb0ecf60b48d8b84f67b77803613086a238257d`  
**Scope:** Phase 00 web spike only. Normal production Sync remains disabled.

## Changes

- Drain durable outbox work in bounded cycles, keep stable operation IDs, yield between requests, and report Pending while eligible work remains.
- Reconcile a lost push acknowledgment against the server's exact canonical record before retrying later revisions. Persist cursor/epoch with acknowledgments and halt on invalid history.
- Quarantine invalid or oversized operations and prevent same-note revisions from advancing after a conflict. Unrelated notes can continue.
- Persist exact local and remote conflict versions. A conflict copy stays local-only until the user explicitly retains it as a separate note; it is never described as backed up or synced.
- Keep recordings and anchors local. Display text sync separately from local-only media at note and library levels; text pull preserves local media and prevents stale queued text snapshots from overriding it.
- Keep the implementation in `spikes/phase-00/gate1`; the production Compose configuration and canonical document schema were not changed.

## Verification

Automated results on 2026-10-23:

| Check | Result |
|---|---:|
| MVP / IndexedDB and regression suite | PASS — 96/96 |
| Sync server suite | PASS — 40/40 |
| Canonical document engine suite | PASS — 31/31 |
| TypeScript typecheck | PASS |
| Next.js production build | PASS — Next.js 16.4.2, Turbopack |
| Chromium + iPhone-sized WebKit scenarios | PASS — 13 scenarios, synthetic only |
| Reliability failure injection | PASS — partial queue, reload, lost acknowledgment, conflict preservation |
| Archive V2 browser regression | PASS — 7 scenarios |
| Audio/anchor browser regression | PASS — 11 scenarios |
| Origin isolation | PASS — first origin 1 synthetic record, alias origin 0, return 1 |
| Quick Capture | PASS — 20 synthetic writes; p50 66.845 ms, p95 99.655 ms, max 99.655 ms |
| Production Sync | OFF — `NOTEOS_SYNC_ENABLED=0`; normal endpoint returned HTTP 503 |

Browser versions: Chromium `156.0.8078.4`; WebKit `27.2`; WebKit viewport `390×844`. Quick Capture used Chromium `156.0.8078.4`. These are browser simulations and are not physical iPhone results. Details and machine-readable traces are in the review bundle.

## Important limits and follow-up

- No personal notes, real devices, real backup imports, or external AI services were used. No Docker volumes were deleted.
- Audio upload/download is not implemented. Media remains on the recording device, and cross-device media recovery requires a later approved design.
- Conflict copies are durable on the local device and explicitly local-only. Cross-device publication of the selected conflict resolution remains follow-up work before any real-data pilot.
- Synthetic acceptance does not establish iPhone behavior or real-data safety. Keep normal Sync disabled pending architecture review and device-specific evidence.

## Reproduction

From `spikes/phase-00/gate1/web`, run `npm run test:mvp`, `npm run test:sync`, `npm run test:documents`, `npm run typecheck`, and `npm run build`. Browser scripts and synthetic test Compose configuration are included in the review ZIP's source diff and evidence. The dedicated test service uses its own named synthetic volume; preserve it unless separately reviewed.
