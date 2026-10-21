# MVP-01.1 recorded verification

Run date: 2026-10-21. Host: macOS Darwin 24.6.0 arm64. Node v24.21.0, npm 11.19.0. Browser: UI Lens bundled Playwright Chromium 156.0.8078.4. Browser checks used fresh contexts and synthetic notes.

## Automated commands

| Command | Result |
| --- | --- |
| `npm run test:mvp` | PASS: 11 tests, 11 passed, 0 failed. |
| `npm run test:documents` | PASS: 31 tests, 31 passed, 0 failed. |
| `npm run typecheck` | PASS: `tsc --noEmit`, exit 0. |
| `npm run build` | PASS: Next.js 16.4.2 production build. Non-blocking warning: multiple lockfiles made Turbopack infer the gate1 workspace root. |
| `git diff --check` | PASS. |
| lint | NOT RUN: no lint script or ESLint config exists in the Web workspace. |
| `npm audit --omit=dev` | FINDING: 2 moderate advisories for `@babel/runtime` pulled by WatermelonDB 0.28.0. npm's suggested fix requires a breaking WatermelonDB update; no auto-fix was applied. |

## Browser workflow results

All browser checks were against `http://127.0.0.1:3000` with non-loopback requests intercepted/blocked. No external request, browser console error, or page error was observed in the Playwright runs.

- Create an empty note, save its title, reload, and confirm the editor remains editable: PASS.
- Edit rich text with Vietnamese/Japanese content, save and reload: PASS.
- Search `dien thoai` for `Điện thoại`, and search Japanese Kanji/Kana: PASS.
- Archive, restore, move to Trash, and restore: PASS.
- Export a backup and inspect its JSON; UI says the browser save is unverified: PASS.
- Import a colliding ID with merge mode; the existing record remains unchanged: PASS.
- Import a future schema record; its raw content remains visible read-only: PASS.
- Import a bundle containing one valid and one invalid document; direct IndexedDB lookup confirms the valid sibling was not written: PASS.
- Inject an IndexedDB `put` failure for one synthetic title; the UI shows a best-effort warning, reload finds the recovery journal, and restoring/saving succeeds: PASS. This is a simulated write failure and reload, not a process-kill test.
- Open delete confirmation in one tab and restore from another; after confirming the stale delete, the first tab reports a revision conflict and IndexedDB still contains the active restored record at revision 4: PASS.
- Permanent delete a synthetic disposable record only after requesting a backup and acknowledging the saved-copy assertion: PASS.

The browser test scripts were one-off runs using the Playwright package already installed with UI Lens. No Playwright dependency or test runner was added to the Web workspace.

## UI Lens

- UI Lens 0.1.0; 7 targets × 2 viewport sizes = 14/14 screenshots captured successfully.
- Viewports: desktop 1440×1000, mobile 390×844.
- Console errors/warnings: 0; page errors: 0; HTTP errors: 0.
- Diagnostics contain two same-origin `net::ERR_ABORTED` navigation requests: `GET /` during Search (desktop), and `GET /trash` during Delete Confirmation (desktop). These occurred during the capture actions' client navigation; the target screenshots still completed. The raw manifest/diagnostics are included alongside the screenshots.

## Resource boundaries

- No Docker workload was started and no Docker container, volume, or Desktop setting was touched for these tests.
- The local Next.js development server bound to `127.0.0.1:3000` and was stopped after the browser and UI Lens runs.
- No actual browser offline mode, iPhone, storage eviction, or process crash was tested.
