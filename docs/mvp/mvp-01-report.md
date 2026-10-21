# noteOS MVP-01 — Local-First Web Notes

> Historical implementation handoff, written before browser acceptance. Its BLOCKED / NOT RUN entries describe the state at that time and are superseded by [MVP-01.1 Quality & Runtime Acceptance](mvp-01.1-report.md).

- **Milestone:** MVP-01 implementation; local-only Web notes in the existing Next.js workspace.
- **Code status:** CODE COMPLETE — pending runtime acceptance.
- **Runtime status:** BLOCKED / NOT RUN — Docker/browser capacity has not been reverified since the 00-R recovery review.
- **Sync engine:** UNDECIDED. This work does not implement sync or authorize MVP-02 / Phase 01.

## Delivered

The product surface is implemented in `spikes/phase-00/gate1/web` while the Phase 00 `/editor`, `/powersync`, `/watermelon` harness routes and their evidence remain in place.

- Notes Home at `/`: create notes, list active notes, and search title/body locally. Search folds Vietnamese accents, case, and punctuation; it retains Unicode letters for Japanese substring search.
- Note editor at `/notes/[id]`: Tiptap rich text over canonical ProseMirror JSON v1, title editing, debounced IndexedDB autosave, saved state, Markdown download with projection warnings, and archive/trash actions.
- `/archive` and `/trash`: restore notes; permanent deletion is gated behind starting a complete backup download.
- `/backup`: export all lifecycles to JSON; validate a complete import before mutation; merge adds only new IDs and leaves matches unchanged, while skip aborts the whole import on any collision.
- Private-by-default copy and a best-effort browser storage quota display. The interface does not call Laravel, MySQL, Redis, MongoDB, PowerSync, AI, or remote font services for note operations.
- Unknown or unsupported canonical documents display as read-only raw JSON. Their stored value is not normalized or rewritten by opening them.

## Local data and recovery design

The browser database is `noteos-mvp-01`, IndexedDB version 1, object store `notes`, keyed by stable UUID. Records contain `id`, `title`, `document`, `schemaVersion`, `createdAt`, `updatedAt`, `lifecycle`, and `revision`. Writes and lifecycle changes use IndexedDB read/write transactions with an expected revision check. A stale tab receives a conflict instead of overwriting the newer database record; its draft can be saved as a new note.

The editor writes a recovery journal to localStorage before an IndexedDB save. A successful save removes that journal. If IndexedDB fails, the in-memory draft remains on screen and the UI reports that saving failed; the journal is best effort and is not treated as primary storage. On reopening, a newer same-revision journal can be restored; a revision mismatch can only be recovered as a new note. Browser storage can still be cleared or exhausted, so users should export backups.

Imports reject malformed bundles, invalid record metadata, duplicate incoming IDs, and unsupported bundle versions before writing. Future canonical document versions with a valid versioned document wrapper are preserved and opened read-only. The implementation does not yet perform schema migration or encrypt browser data at rest.

## Versions and dependencies

Versions declared by the Web workspace lockfile/package manifest:

| Component | Version |
| --- | --- |
| Next.js | 16.4.2 |
| React / React DOM | 19.3.1 |
| Tiptap core and used extensions | 3.32.0 |
| Node runtime in the Web Dockerfile | 22.21.1 |

No package was added for MVP-01. Browser DB, search normalization, and backup format use platform APIs and project code. The editor reuses the existing document engine. No license conclusion beyond the existing project dependency/license review is added here.

## Verification evidence

| Check | Result | Evidence / limit |
| --- | --- | --- |
| MVP helper tests | **PASS — 5/5** | `cd spikes/phase-00/gate1/web && npm run test:mvp`; Node `v24.21.0` host. Covers Vietnamese accent/punctuation and Japanese search, lifecycle filtering, backup round-trip, duplicate IDs, unsupported bundle version, and invalid metadata. |
| `git diff --check` | **PASS** | Run at the repository root after implementation edits. |
| Core JavaScript syntax | **PASS** | `node --check` passed for the IndexedDB repository and MVP utility modules. |
| Next.js typecheck/build | **NOT RUN** | Web workspace `node_modules` is absent. No packages were installed and no image was built. |
| IndexedDB transaction/reload behavior | **NOT RUN** | Requires browser runtime. Repository conflict/atomicity logic was source-reviewed only. |
| Web create/edit/save/reload, search, archive/trash, import/export | **NOT RUN** | No browser was launched because capacity remains unverified. |
| Offline/network panel validation | **NOT RUN** | No browser was launched. Source contains no backend request in core note flows and the product stylesheet has no remote font import. Runtime network evidence is outstanding. |
| iPhone/native behavior | **OUT OF SCOPE** | MVP-01 is Web-only. |

There is no measured browser/device, dataset, p50/p95, or runtime memory result for MVP-01. Do not treat the helper tests or source review as user-interface acceptance.

## Runtime acceptance checklist

Run only after the approved capacity gate confirms adequate host/Docker headroom. Keep the browser check local and synthetic.

1. From `spikes/phase-00/gate1/web`, run `npm run dev` using the already available runtime/dependencies. It binds to `127.0.0.1:3000`. Do not start API/database/sync services.
2. In a clean browser profile, create a note, enter Vietnamese and Japanese text, apply rich formatting, wait for “Saved”, reload, and verify title/content/formatting.
3. Search with/without Vietnamese accents and punctuation; search a Japanese substring.
4. Archive and restore a note; move another to Trash, restore it, then verify permanent deletion only after full backup download.
5. Export a backup; import it into a clean profile. Repeat with duplicate IDs in both merge and skip modes and verify existing content is never overwritten.
6. Open a synthetic future-schema record and confirm the original JSON stays read-only and unchanged.
7. Disable network in DevTools and repeat create/edit/save/reload/search. Check console and network panels for requests or failures.
8. Verify the recovery journal and stale-revision conflict flow in two tabs, then record browser/OS, package versions, dataset, iterations, and observed resource use.

## Remaining review points

- Browser acceptance is required before claiming MVP-01 runtime accepted.
- Browser persistence can be evicted by the user/browser; export remains the recovery mechanism.
- IndexedDB quota behavior and private-browsing behavior are not yet verified.
- Conflict detection is per-record revision; no cross-device conflict model exists.
- Backup JSON is unencrypted and contains note content.
- The import merge policy is ID-based only and intentionally does not merge or overwrite same-ID content.
- Search currently scans local note records in memory; no scale benchmark has been run.

**Handoff:** Review code and the lightweight evidence first. Then decide whether to authorize the capacity-gated browser acceptance run. Keep sync undecided and stop at MVP-01.
