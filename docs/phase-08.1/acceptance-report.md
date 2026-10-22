# Phase 08.1 acceptance report

Implementation: PASS as a disabled foundation. Real-data activation: BLOCKED pending owner backup/device approval and access-policy review. Cross-device Sync is not active.

## Implemented

One existing Web container, SQLite WAL persistent storage and migration 001; durable epoch/cursor contract; owner-local 120-second enrollment with persistent throttling, hashed device tokens, HttpOnly sessions and revocation; authenticated status/read-only bootstrap preview; optional Sync Setup with read-only browser discovery and explicit summary consent. Missing/DEVICE_ONLY privacy remains excluded. No note-save hooks, outbox, mutation loops, media transfer, schema changes or native integration were added.

Phone form inputs are at least 16px at the mobile/coarse-pointer breakpoints. Note-title typography remains at least 29px and pinch zoom is unrestricted. Chromium/WebKit focused-input checks passed; actual iPhone Safari behavior still needs the owner’s check.

## Verification results

| Check | Result |
|---|---|
| Existing/new Web Node suite | PASS: 115/115 tests under Node 22.21.1 Alpine, concurrency 1, 768 MiB test cap |
| Shared document engine | PASS: 31/31; total 146 Node test cases |
| Production build/type checking | PASS: Next.js 16.4.2, React 19.3.1, npm ci --ignore-scripts |
| SQLite production image | PASS: Node 22.21.1, SQLite 3.50.4; experimental Node API explicitly recorded |
| Durable volume, recreate and app restart | PASS: same epoch, schema, cursor 4 and seeded note-state hash after recreate/restart |
| Unavailable DB volume | PASS: private API generic 503, Web still 200; original volume reattached unchanged |
| WAL/concurrency/cursors | PASS: rollback includes clock and changelog; two independent writers committed contiguous cursors; exact version/change FKs and live/tombstone exclusion tested |
| Pairing/auth/CSRF | PASS: expiry, one-time redemption, persisted limits, invalid/missing/expired/revoked credentials, Origin/Host/custom-header negatives; HTTPS Secure/HttpOnly/SameSite cookies in actual browsers and loopback cookie contract separately |
| Preview validation/comparison | PASS: bounded input, malformed/duplicate/extra fields denied; seeded equal/new/changed/lifecycle/audio/tombstone cases; empty server explicitly reported |
| No preview note mutations | PASS: browser-local snapshot and server note/history hash unchanged before/after dry-run |
| Foundation browser | PASS: Chromium 156.0.8078.4 and WebKit 27.2, desktop + 390px; separate actual browser origins isolated; 16px phone controls; no actual-iPhone claim |
| Quick Capture regression | PASS: existing script including reload, double click, Unicode, editor opening and phone layout |
| Organization regression | PASS: 8/8 scenarios; old entry locator updated for existing Open full editor label; navigation budget 15s, UI assertion budget remains 4s |
| Audio/Audio Anchors regression | PASS: 11/11 with Chromium fake audio device, no physical microphone input |
| Live Web after update | PASS: localhost /sync 200, private API sync_disabled 503, no automatic enrollment, non-root container healthy and not OOM-killed |
| Live private HTTPS after update | PENDING: Mac Tailscale backend was Stopped at the final check; DNS returned ENOTFOUND. Serve mappings were preserved. No reconnection or policy edit was attempted. |
| Tailnet owner-only access | BLOCKED: effective filter includes the whole Tailnet IPv6 range to all ports; full owner-approved device policy not verified; API stays disabled |
| Personal full backups / native validation | PENDING: owner checklist supplied; runner did not inspect/export/validate personal browser or Expo data |
| Other services / Expo | PASS: 13 unrelated container start times unchanged; Metro :8085 PID 56707 left running; no old experimental stack started |
| Secrets and UTF-8 | Reviewed changed source, logs and package members; actual tokens, pairing codes, keys and database files excluded; final package audit included |

## Dataset and limits

Only synthetic data: four seeded server notes and five browser notes (one DEVICE_ONLY), with one synthetic recording metadata entry and no media bytes in the preview fixture. Browser preview expected one would-upload, one would-download, one identical text-only, two colliding IDs and one audio-review ID. Unit fixtures additionally cover tombstones and lifecycle conflicts. This does not compare three populated personal clients or establish Sync readiness.

Test host: macOS 15.7.7. Docker VM budget observed: 8,337,670,144 bytes (7.765 GiB). Synthetic Web container limit: 512 MiB; observed docker-stats samples were 70.12, 72.68 and 74.77 MiB, and it remained healthy/OOMKilled=false. Peak memory was not measurable through the available cgroup interface. These samples are not a peak or a guarantee for larger libraries. No p50/p95 performance benchmark was claimed.

Initial WebKit errors came from interrupted Next prefetch requests during rapid test navigation; waiting for network idle before navigation removed them. The final browser runs passed. Earlier organization tests used a pre-Quick-Capture button label and a 4-second page-load budget; the final harness uses the existing editor entry and a separate 15-second navigation budget. Product Quick Capture behavior was not modified.

The live image was updated only after source/runtime checks, with NOTEOS_SYNC_ENABLED fixed at 0. Previous image tag `noteos-web-pre-phase081:local` remains available. The synthetic container is stopped after evidence capture; its named volume is retained. A concurrent generated next-env.d.ts dev-reference diff is preserved outside the Phase 08.1 commit. The exact delivery commit/remote HEAD is recorded in the review ZIP README.

## Remaining gates

1. Owner verifies fresh Full Archive V2 separately for every important browser origin and native Expo data, including audio/anchors.
2. Review Tailnet grants/membership and the shared-hostname cookie trust boundary; approve only intended devices or provide hostname isolation before enabling APIs.
3. Reconnect Tailscale deliberately, then rerun the strict live HTTPS check and actual iPhone cellular/Safari input/microphone checks.
4. Verify installed Expo Go SecureStore availability before any future native credential integration; do not change SDK 57.
5. Architecture review approves the experimental driver and backup/restore plan before real-data activation. Stop at Phase 08.1.
