# noteOS MVP-02 — Local Audio Recording & Playback

**Status: IMPLEMENTED; automated and Chromium fake-microphone acceptance PASS.** This handoff covers the approved MVP-02 scope only. It does not claim real-microphone, Safari, iPhone, background-recording, quota-scale or crash-proof results.

## User flows

- From an open note, the user explicitly chooses **Record audio** before the browser requests microphone access. Unsupported APIs, denied permission, missing microphones and storage failures produce visible messages.
- App navigation and note lifecycle changes are blocked while recording; users must stop/save first because background recording is unsupported.
- Chromium's supported `MediaRecorder` MIME type is selected at runtime. Recording uses one-second timeslices and writes each non-empty Blob chunk to IndexedDB in sequence. Pause/resume is shown only when the runtime recorder exposes both methods.
- **Stop and save** waits for queued chunk writes before marking a non-empty recording complete. Empty stops and write failures are not labeled complete.
- Recordings are listed under their note. Users can play/seek through the browser audio controls, rename, export the original MIME type with a matching extension, or confirm deletion.
- Reloading the recording tab marks its unfinished sessions interrupted. Unfinished recording sessions inactive for two minutes, and paused sessions inactive for one day, are marked interrupted on a later note open. Partial chunks remain available to play/export and are clearly labeled.
- Archive and Trash preserve audio. Permanent note deletion removes the note, linked recording metadata and chunks in the same IndexedDB transaction. The confirmation explains that audio is excluded from the notes backup and asks the user to acknowledge audio export/deletion.

## Storage and migration

Database `noteos-mvp-01` advances from version 1 to version 2. The upgrade leaves the `notes` object store and every existing note value intact, and additively creates:

| Store | Key and indexes | Contents |
| --- | --- | --- |
| `recordings` | `id`; indexes `noteId`, `status`, `updatedAt` | Stable recording/note IDs, title, MIME type, explicit state, creation/update times, duration, chunk count and owning tab ID |
| `recordingChunks` | `id = recordingId:sequence`; indexes `recordingId`, unique `[recordingId, sequence]` | Ordered binary `Blob` parts |

Recording states are `recording`, `paused`, `complete`, `interrupted` and `failed`. A unique live-session constraint is enforced transactionally per note: another active/paused session cannot start. The JSON ProseMirror document, its schema version and note revision are not modified by audio operations.

There is no server, sync, transcription or cloud request. New third-party dependencies: **none**. Runtime services are the browser's `getUserMedia`, `MediaRecorder`, IndexedDB, Blob and object URL APIs.

## Backup and deletion contract

The existing `noteos.local-backup` version 1 contract remains notes-only for backward compatibility. Audio is exported separately, one recording at a time, as a local browser download. The UI says the browser download was requested and cannot prove that the file was saved. Users who permanently delete a note are told to export recordings first; the transaction then cascades the note and all its linked media. Archiving and moving to Trash never remove media.

## Verification evidence

Environment observed: macOS Darwin 24.6.0 arm64; Node `v24.21.0`; Next.js `16.4.2`; React `19.3.1`; Playwright Chromium `156.0.8078.4`; existing UI Lens `0.1.0`. No package versions or lockfiles changed. Build reports the existing multiple-lockfile workspace-root warning.

| Check | Result |
| --- | --- |
| MVP repository/coordinator/recovery/audio tests | **PASS — 28/28** |
| Canonical document engine regression tests | **PASS — 31/31** |
| MVP-02 browser scenarios, fake Chromium microphone | **PASS — 8/8** |
| MVP-01.2 browser regression and MVP-01.1 smoke | **PASS — 13/13** |
| TypeScript typecheck | **PASS** |
| Next.js production build | **PASS** |
| UI Lens desktop/mobile | **PASS — 12/12**, six states × two viewports |
| `git diff --check` | **PASS** |
| Real physical microphone | **NOT RUN** — no explicit permission to use the device microphone was given |
| Safari/iPhone, background recording, process kill, quota exhaustion/eviction | **NOT RUN** |

Browser scenarios cover unsupported API, injected denied permission, fake audio start/stop, pause/resume, actual saved chunks, reload/playback, MIME-matched export, rename, multiple recordings, confirmed deletion, injected chunk-write/quota failure, reload recovery as interrupted partial audio, Archive/Trash preservation and permanent-delete cascade. Existing browser regression covers autosave/recovery, revision conflicts, lifecycle, navigation and backup compatibility. Browser console/page errors and external requests were zero. UI Lens console/page/failed-request/HTTP error counts were also zero.

UI Lens captures use synthetic note text and generated fake microphone samples only. Files are in the review package under `ui-lens/`; desktop and mobile dimensions are `1440×1000` and `390×844`.

## Limits and risks

1. One-second timeslices reduce the amount of unsaved audio held by the application, but browser `MediaRecorder` buffering and scheduling are implementation-dependent. The latest chunk in memory may be lost on abrupt process termination. This is not background or crash-proof recording.
2. On tab reload the same tab ID is available through `sessionStorage`; a later open also marks stale `recording` sessions after two minutes and stale paused sessions after one day. A suspended/background tab may be mistaken for stale after the threshold. Background recording is explicitly unsupported.
3. IndexedDB quota, browser eviction, private-browsing restrictions and storage denial vary by browser. Write failure preserves already committed chunks as a `failed` partial recording; no quota capacity guarantee was measured.
4. Playback and export reassemble a recording's stored chunk Blobs into a browser Blob. Temporary memory use therefore grows with the full recording size; long-meeting behavior was not benchmarked. Storage is chunked, but complete-recording playback/export is not streaming.
5. The real microphone was not opened. Permission denial and write/quota errors were controlled browser fixtures, and audio input was Chromium's fake device. No iPhone, Safari, IME, OS interruption or cross-browser codecs were checked.
6. Object URLs and microphone tracks are released after playback resource replacement, deletion, stop and component cleanup. Unmount requests a stop and retains the last committed chunks; completion of asynchronous cleanup during browser termination is not guaranteed.
7. Existing mobile navigation has horizontal overflow visible in the UI Lens screenshots; this predates this audio feature and was not changed here.

## Reproduction

From repository root:

```sh
npm --prefix spikes/phase-00/gate1/web run test:mvp
npm --prefix spikes/phase-00/gate1/web run test:documents
npm --prefix spikes/phase-00/gate1/web run typecheck
npm --prefix spikes/phase-00/gate1/web run build
npm --prefix spikes/phase-00/gate1/web run dev
node spikes/phase-00/gate1/web/scripts/mvp-02-browser.mjs
../ui-lens/node_modules/.bin/tsx spikes/phase-00/gate1/web/scripts/mvp-02-ui-lens.mjs
```

Browser scripts use isolated contexts and synthetic note/audio data; the MVP-02 browser script launches Chromium with a fake media device and does not access a physical microphone. No Docker service, settings, volume, registry or other project was changed. No new packages were installed.

## Source and handoff

Implementation files are the note editor, local notes/audio repository and lifecycle confirmation, audio recorder UI, audio-storage tests, browser/UI Lens harnesses, this report and the root README. The independent review brief, source patch, test logs, browser diagnostics, UI Lens manifest and screenshots are included in `artifacts/review/noteOS-MVP-02-review.zip` and `artifacts/review/noteOS-MVP-02-Audit.txt`.

Implementation commit `dc9ce16814e17969c1332983e61eb1a3f003b129` is pushed to `origin/main`. UI Lens captured that commit; its manifest reports `dirty: true` because unrelated Phase 00 documentation changes were already present in the shared worktree and were left untouched.

No decision is requested to change Sync Engine, canonical document format, backup version or mobile architecture. Stop after MVP-02 review; do not start MVP-03 automatically.
