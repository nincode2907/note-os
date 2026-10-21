# noteOS MVP-01.1 — Quality & Runtime Acceptance

- **Scope:** MVP-01 local-first Web notes only.
- **Result:** **PASS WITH LIMITS** for the tested Web workflows.
- **Sync engine:** UNDECIDED. No MVP-02, Phase 01, iPhone build, or production deployment was started.
- **Git:** branch `main`; implementation commit and push result are recorded after commit in the delivery handoff.

## What changed

1. Vietnamese search normalization now folds `đ/Đ` to `d/D` in addition to stripping combining accents. Japanese text remains intact.
2. Permanent delete requires the expected note revision and a `trashed` lifecycle at the IndexedDB transaction boundary. Missing and stale notes return explicit errors. The UI makes users request a full backup download and acknowledge that they verified it; noteOS still says it cannot verify or guarantee that backup.
3. Create, save, and import validate canonical documents. Import validates the whole input before opening its write transaction; invalid input cannot partially write. Future schema documents are preserved and displayed read-only.
4. Browser testing found that ProseMirror serialized an empty document without `content`, which made a note created by noteOS appear unsupported after reload. Canonical normalization now restores the required empty `content: []` array. A document-engine regression test covers repeated validation/serialization.
5. UI Lens capture actions now target the specific **New note** button, avoiding an ambiguous match with the empty-state button.

## Verification results

| Check | Result | Evidence and limits |
| --- | --- | --- |
| MVP helper and repository tests | **PASS — 11/11** | `npm run test:mvp` in `spikes/phase-00/gate1/web`; includes search, revision conflicts, delete lifecycle, import validation/atomicity and future schema preservation. |
| Canonical document-engine tests | **PASS — 31/31** | `npm run test:documents`; includes new empty-document round-trip regression. |
| TypeScript | **PASS** | `npm run typecheck`. |
| Next production build | **PASS** | `npm run build`; Next.js reports a non-blocking multiple-lockfile workspace-root warning. |
| `git diff --check` | **PASS** | Run after the implementation edits. |
| Lint | **NOT RUN** | The Web workspace has no lint script or ESLint configuration. |
| Dependency audit | **FINDING — 2 moderate** | `npm audit --omit=dev` reports vulnerable `@babel/runtime` versions through WatermelonDB `0.28.0`; npm offers a breaking WatermelonDB upgrade. No automatic dependency upgrade was applied. |
| Browser create/edit/autosave/reload | **PASS** | Isolated Playwright Chromium context; synthetic note. Empty documents remain editable after reload; Vietnamese/Japanese content and title survive reload. |
| Search | **PASS** | `dien thoai` finds `Điện thoại`; Japanese Kanji/Kana query finds the note. |
| Archive, Trash, restore | **PASS** | Exercised through the Web UI with synthetic notes. |
| Backup/export/import | **PASS WITH LIMITS** | Browser export download was read and checked; merge kept an existing same-ID record unchanged; invalid import wrote no valid sibling record; a future schema record opened read-only with its raw content retained. Skip-all collision behavior is covered by repository tests. |
| Autosave failure and recovery | **PASS — simulated write failure** | A browser test injected a failing IndexedDB `put`, confirmed the UI error and recovery draft after reload, then restored/saved the draft. This was not a process-kill test. |
| Concurrent stale delete | **PASS** | One tab opened delete confirmation; another restored the note; the first tab reported that it changed in another tab and did not delete it. |
| Confirmed permanent deletion | **PASS — synthetic disposable record** | The browser kept Delete disabled before acknowledgement, requested a backup snapshot, then deleted only a synthetic record in the isolated browser context after acknowledgement. |
| External network dependency | **PASS for tested flows** | Playwright blocked every non-loopback request. No external request was attempted during the exercised workflows. This was not a full OS/browser offline-mode test. |
| UI Lens | **PASS — 14/14 captures** | UI Lens `0.1.0`; desktop `1440×1000` and mobile `390×844`; 7 targets. Zero console errors/warnings, page errors, and HTTP errors. Two same-origin navigation requests were reported as `net::ERR_ABORTED` while the UI Lens action navigated; all screenshots succeeded. |

### Runtime and resources

- Host: macOS Darwin `24.6.0`, arm64; Node `v24.21.0`, npm `11.19.0`.
- Browser: UI Lens bundled Playwright Chromium `156.0.8078.4` (headless). The screenshots cover desktop and mobile viewport sizes; they are not separate physical devices.
- The Web server bound to `127.0.0.1:3000`. Browser tests used a fresh isolated context and synthetic data. The context was closed after each run.
- No Docker service or volume was started, restarted, stopped, or modified. Other project containers remained untouched. This acceptance therefore consumed host resources only; it does not revise the Docker capacity result from Recovery 00-R.
- UI Lens artifacts and Playwright browser tests used synthetic note titles/content only.

### Dependency versions and licenses

| Package | Version | License |
| --- | --- | --- |
| Next.js | 16.4.2 | MIT |
| React / React DOM | 19.3.1 | MIT |
| Tiptap core | 3.32.0 | MIT |
| fake-indexeddb (test only) | 6.2.6 | Apache-2.0 |
| WatermelonDB (existing Phase 00 candidate) | 0.28.0 | MIT |
| PowerSync Web (existing Phase 00 candidate) | 2.5.0 | Apache-2.0 |

The MVP does not activate either sync candidate. License values were read from the installed package metadata. No production support or security conclusion is inferred from that check.

## UI Lens evidence

Latest successful capture:

`artifacts/ui-review/2026-10-21T02-30-59-537Z_abb49169-1615-4112-9764-78729d706a40/`

The final ZIP contains the selected screenshots and the UI Lens manifest/diagnostics. Two canceled same-origin navigation requests are retained in the diagnostics; they produced no HTTP, console, or page errors.

## Remaining limits and review questions

- Real-iPhone editing, IME behavior, backgrounding, and restart persistence were not tested.
- Actual browser/OS offline mode, private-browsing restrictions, storage eviction/quota exhaustion, and process crash recovery were not tested. Recovery used an injected IndexedDB write failure followed by reload.
- Backup JSON is unencrypted. Browser storage can be cleared or evicted; backup download acknowledgement is a user assertion, not verification.
- Search scale and resource use under a large dataset were not benchmarked.
- The dependency audit finding in the unused-in-MVP WatermelonDB candidate remains open pending a non-breaking dependency decision.
- Automated cross-file security reviewer was unavailable: the plugin requires Python 3.10+, while its hook has Python 3.9. Pattern checks and single-shot LLM diff review remained active; a manual source review was also performed. No runtime or dependency change was made to enable that reviewer.

## Reproduction

From the repository root:

```sh
cd spikes/phase-00/gate1/web
npm run test:mvp
npm run test:documents
npm run typecheck
npm run build
npm run dev
```

Use a fresh browser profile and synthetic notes for UI checks. The one-off runtime tests in this acceptance used the Playwright copy already installed with UI Lens; no Playwright package was added to the Web workspace. Use UI Lens with the repository `.ui-review.json` for the screenshot set:

```sh
npm --prefix /Users/buivannin/Desktop/workspace/personal/ui-lens run capture -- noteos --targets home,editor,search,archive,trash,delete-confirmation,backup --viewports desktop,mobile --no-pdf
```

## Handoff

See `REVIEW-ME.md` and `GEMINI-REVIEW-BRIEF.md` in the single review ZIP for the concise decision brief. The implementation commit SHA and push result will be added here after the authorized GitHub delivery.
