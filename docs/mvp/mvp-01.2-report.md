# noteOS MVP-01.2 — Data Safety Patch

Scope: verified F-01–F-05 only, IndexedDB database v1 and canonical JSON v1 retained. No dependency, sync engine, AI, voice, cloud, or production deployment change.

**Result: all five findings FIXED in the implemented and tested scope. Ready for Lead Architect review/acceptance with the durability limits below.** This is not a guarantee against browser eviction, unavailable recovery storage, or OS/process termination.

## Findings and changes

| Finding | Status | Root cause and fix | Evidence |
| --- | --- | --- | --- |
| F-01 live editor recovery | **FIXED** | React draft state changed while mounted Tiptap retained old content. Recovery now validates with the canonical engine, uses Tiptap 3.32.0 `setContent(json, { emitUpdate: false, errorOnInvalidContent: true })`, then updates React/coordinator and awaits a save. Original journals remain on apply/save failure. A concurrent revision forces recovery as a separate note. Explicitly keeping the saved version also resets the live editor after a failed recovery save. | Browser covers Old body → failed write → Recovered body/title → restore → more typing → save/reload; failed recovery save/discard; concurrent recovery/copy. |
| F-02 lifecycle after failed save | **FIXED** | Save failures were consumed, and lifecycle adopted a fresh DB revision. `flush()`/`transition()` now return explicit results. Transition uses the coordinator's committed revision; no DB reread bypasses a conflict. Failure prevents navigation and preserves the draft. Clean drafts do not produce a save/revision increment. Trashed/future-schema records can take allowed lifecycle actions without being rewritten. | Stale Archive/Trash in two tabs, injected failure + Archive, immediate Archive, normal lifecycle and clean revision-count assertions. |
| F-03 overlapping saves/newer journal | **FIXED** | Independent calls raced and older completions cleared the shared recovery key. A single-note coordinator serializes writes, records generations and in-flight snapshots, drains newer drafts with the next committed revision, and only clears its own journal when current content is committed. Each tab has its own journal key. Drains are bounded; failures stop without an automatic retry loop. Reopening uses content/revision evidence rather than timestamp ordering. | Deferred A/B/C tests, failed in-flight save, cross-tab conflict, simultaneous save/lifecycle; real browser IndexedDB transaction held until test releases it while B/C arrive. |
| F-04 debounce navigation loss | **FIXED** | Links could unmount the editor before debounce. Back/sidebar/brand links now use Next's documented `onNavigate` cancellation hook and await the editor flush. Lifecycle/copy routes navigate only after their explicit operation succeeds. Failure remains on the editor with retry/copy feedback. No async unmount save is used. | Back/sidebar clicks in less than 650 ms preserve current content on reopen; failed sidebar flush stays on editor and retains its journal. |
| F-05 journal cleanup/import mismatch | **FIXED** | Delete left old journals; parser and repository had different document rules. Confirmed delete returns the deleted record, removes only captured unchanged journals matching committed content, retains newer/other-tab drafts and marks the deletion epoch. Retained pre-delete journals can only recover as copies after same-ID import. Parser/repository share record/canonical validation; future documents remain unmodified. Missing note routes now show not-found instead of silently recreating a deleted ID. | Delete/reimport browser test; stale/new/concurrently changed/unrelated journal tests; shared parser/repository rejection and future preservation tests. |

## Source and operation contract

- `app/lib/save-coordinator.mjs`: one active write promise per editor, current draft generation, structured results, expected revision and transition ordering.
- `app/lib/recovery-journal.mjs`: legacy journal compatibility, writer-specific journals, conditional cleanup, in-flight recovery evidence and deletion marker.
- `app/lib/note-validation.mjs`: the common metadata/canonical validation boundary. It rejects corrupt wrappers/known trees and invalid record metadata, while retaining valid future/unsupported documents for read-only use.
- `app/ui/navigation-guard.tsx`, editor and app shell: app navigation flush, live recovery application, retry/copy and failure feedback.
- Repository/import/lifecycle changes reuse the existing IndexedDB transactions. No IndexedDB migration or canonical schema change was made.

The installed Tiptap source `node_modules/@tiptap/core/src/commands/setContent.ts` confirms the object-options signature. The installed Next.js Link documentation confirms `onNavigate` with `preventDefault()`. No dependency version was guessed or upgraded.

## Actual verification

| Verification | Result |
| --- | --- |
| MVP repository/helper/coordinator/journal tests | **PASS — 22/22** |
| Document engine tests | **PASS — 31/31** |
| Targeted browser regression + MVP-01.1 happy-path smoke | **PASS — 13/13** |
| Typecheck | **PASS** |
| Next production build | **PASS**; existing multiple-lockfile workspace-root warning remains |
| `git diff --check` | **PASS** |
| Lint | **NOT RUN** — workspace has no lint script/config |
| Real iPhone, OS termination/process crash, quota/eviction | **NOT RUN** |

The browser suite includes injected write failure, controlled IndexedDB transaction delay, real reloads, two-tab revision conflicts, DB lifecycle/revision checks, actual body/title assertions, and journal preservation. Its committed-state polling awaits IndexedDB results in Node; it does not treat an async browser predicate or a truthy promise as evidence of commit. Test-only delays never alter production timeout behavior.

Final browser diagnostics: no console errors, page errors or external requests. Two same-origin RSC navigation requests were canceled with `net::ERR_ABORTED` while navigating. These are retained in the JSON evidence; they are not reported as HTTP failures.

UI Lens `0.1.0` captured the affected Editor, Recovery, Save Error and immediate Navigation states at desktop `1440×1000` and mobile `390×844`: **8/8**. After the error-action controls changed, only Save Error was refreshed: **2/2**. Console/page/HTTP errors were zero; the initial navigation capture logged one same-origin aborted request. The stock UI Lens action schema cannot inject storage failure or recovery fixtures, so a committed synthetic setup harness delegates screenshot capture/diagnostics to the existing UI Lens runner without changing UI Lens or Dev Hub.

Visual check: recovery and error content is readable on the mobile viewport; the pre-existing horizontal overflow of the mobile navigation remains visible and is outside this data-safety patch.

### Environment and resource boundaries

- macOS Darwin 24.6.0 arm64; Node v24.21.0, npm 11.19.0; Playwright Chromium 156.0.8078.4 from the existing sibling UI Lens installation.
- Host physical RAM: 16 GiB; `memory_pressure` reported 32% free before browser workload. No RAM blocker occurred. No Docker container, volume, setting or unrelated process was changed.
- Next 16.4.2, React/React DOM 19.3.1, Tiptap 3.32.0; existing fake-indexeddb 6.2.6 used for tests. No package/lockfile change.
- Tests use fresh isolated browser contexts with synthetic notes only. Non-loopback requests are blocked; no external request was attempted. This does not test full offline application startup.
- The local `127.0.0.1:3000` server was stopped after verification.

## Remaining durability limits and review points

1. IndexedDB is primary storage. localStorage recovery journals are synchronous best-effort checkpoints after edit events; storage can be denied, full, cleared or evicted. Neither this patch nor a successful download request guarantees durable backup.
2. Application-controlled links/lifecycle await flush. Refresh/tab close uses a `beforeunload` warning when dirty/in flight; browser back/forward, OS termination and process crash rely on the journal. Async IndexedDB completion during unload is not guaranteed. IME composition that never emits an edit update is not covered.
3. Journal cleanup/deletion markers are separate localStorage operations after the IndexedDB deletion commits, not one atomic transaction across the two stores. Changed/ambiguous journals are retained rather than discarded; same-ID retained drafts are offered as copies when the marker is available. Multi-tab deletion/reimport with unavailable localStorage is not a fully verified atomic incarnation protocol.
4. Recovery journals and backup files remain unencrypted local data. The existing dependency audit finding through the unused-in-MVP WatermelonDB candidate from MVP-01.1 remains unchanged; no dependencies changed or audit auto-fix ran here.
5. No additional confirmed data-loss defect remains in the exercised scope. Browser eviction/quota, full process-kill durability, large documents and real-iPhone behavior still need dedicated evidence before broader guarantees.

## Reproduction

From repository root:

```sh
npm --prefix spikes/phase-00/gate1/web run test:mvp
npm --prefix spikes/phase-00/gate1/web run test:documents
npm --prefix spikes/phase-00/gate1/web run typecheck
npm --prefix spikes/phase-00/gate1/web run build
npm --prefix spikes/phase-00/gate1/web run dev
node spikes/phase-00/gate1/web/scripts/mvp-01.2-browser.mjs
../ui-lens/node_modules/.bin/tsx spikes/phase-00/gate1/web/scripts/mvp-01.2-ui-lens.mjs
```

Browser scripts resolve the already installed sibling UI Lens Playwright; set `NOTEOS_PLAYWRIGHT_ROOT` if its directory differs. They create only synthetic isolated browser data. The test evidence output is `/tmp/noteos-mvp012-evidence`; UI Lens writes under this repository's `artifacts/ui-review/`.

## GitHub and handoff

Branch: `main`; remote: `origin/main`. Implementation SHA and actual push outcome are recorded after delivery. Unrelated pre-existing Phase 00 changes remain outside the milestone commit.

Handoff files: `artifacts/review/noteOS-MVP-01.2-review.zip` and UTF-8 `artifacts/review/noteOS-MVP-01.2-Audit.txt`. The package contains source/patch, exact final test logs, selected UI Lens captures/diagnostics and a SHA-256 manifest. Independent re-review is warranted for the coordinator/recovery boundaries; Gemini has not reviewed this patch yet.

Stop at MVP-01.2. Lead Architect decides acceptance and any next milestone.
