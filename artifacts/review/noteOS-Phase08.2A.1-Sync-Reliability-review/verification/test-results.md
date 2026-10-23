# Verification Results

Date: 2026-10-23. Commands were run from `spikes/phase-00/gate1/web` unless noted.

| Command / scenario | Result |
|---|---:|
| `npm run test:mvp` | PASS — 96 tests, 0 failed |
| `npm run test:sync` | PASS — 40 tests, 0 failed |
| `npm run test:documents` | PASS — 31 tests, 0 failed |
| `npm run typecheck` | PASS — `tsc --noEmit` |
| `npm run build` | PASS — Next.js 16.4.2, Turbopack |
| Full Chromium + iPhone-sized WebKit sync browser acceptance | PASS — 13 synthetic scenarios; see `evidence/browser-results.json` and `browser-trace.json` |
| Reliability browser failure injection | PASS — first 100 ACKs then outage leaves 50 Pending; reload drains all 150; later lost ACK replays without duplicate server mutation; see `evidence/reliability-browser.json` |
| Archive V2 browser regression | PASS — 7 scenarios; `evidence/backup-v2/browser-results.json` |
| Audio/anchor browser regression | PASS — 11 scenarios; `evidence/audio/browser-results.json` |
| Origin isolation | PASS — first origin 1 note, alias 0, return 1; `evidence/origin-isolation/origin-isolation.json` |
| Quick Capture | PASS — 20 local synthetic writes; p50 66.845 ms, p95/max 99.655 ms; `evidence/quick-capture/quick-capture-browser-diagnostics.json` |
| Production Sync | OFF — `NOTEOS_SYNC_ENABLED=0`; normal endpoint returned HTTP 503 |

Browser environment: Chromium `156.0.8078.4`; WebKit `27.2`; WebKit viewport `390×844`. Quick Capture measured in Chromium `156.0.8078.4`. No actual iPhone was tested. No physical-device latency claim is made.
