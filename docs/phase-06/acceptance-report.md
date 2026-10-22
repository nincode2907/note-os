# noteOS Phase 06 — Audio Timestamp Anchors

**Status:** Implementation complete. Automated acceptance passes; Expo Doctor’s two network-backed checks and physical iPhone validation remain blocked/pending. **Date:** 2026-10-22.

## Implementation

- Added the shared version 1 `audioAnchors` contract: stable per-bookmark IDs, nonnegative integer millisecond offsets, NFC-normalized labels capped at 120 Unicode code points, a 100-bookmark per-recording limit, duplicate-ID/unknown-key rejection, chronological ordering, and empty-label display as “Bookmark”.
- Web stores anchors inside each IndexedDB recording row. Its recording clock accumulates monotonic active segments and returns rounded integer milliseconds on pause/finalization.
- iPhone stores committed anchors in the existing recording archive metadata and uses additive SQLite schema version 5 to journal provisional recording sessions. Quick Voice’s note remains only in the session journal until the audio file is verified and the note, recording and anchors commit together. A failed transaction preserves the journal for retry.
- Recording-time bookmarks, pause/resume, playback-position bookmarks, timestamp seek, rename and delete are available in the existing Web and Expo audio flows. Known playback duration clamps seeks; unloaded players retain the requested seek until media is loaded.
- TAR V2 remains version 2. `audioAnchors` is an optional versioned recording-metadata extension. Both archive readers validate it before mutation; V2 archives without the extension remain compatible. Canonical Document v1 and note revisions are unchanged.

## Verification

| Check | Result | Evidence |
|---|---|---|
| Web unit/regression suite | PASS — 78 tests | `spikes/phase-00/gate1/web`: `npm run test:mvp` |
| Mobile unit/regression suite | PASS — 57 tests | `spikes/phase-00/gate1/mobile`: `npm test` |
| Canonical Document v1 suite | PASS — 31 tests | `spikes/phase-00/gate1/web`: `npm run test:documents` |
| Web fake-microphone browser suite | PASS — 11 scenarios; Chromium 156.0.8078.4; zero console/page errors or external requests | `evidence/browser-results.json` |
| Cross-platform TAR V2 tests | PASS — Web → native → Web fixtures, old V2 without anchors, Unicode and malformed metadata | Included in both unit suites |
| Web/mobile TypeScript | PASS | `npm run typecheck` in both workspaces |
| Expo dependency alignment | PASS — SDK package versions are aligned | `npm run expo-check` |
| Expo Doctor | PASS — 21/21 checks passed | Command: `npx --yes expo-doctor` |
| Native editor bundle/browser | PASS — Tiptap runtime, canonical round-trip, formatting/task toggles, IME snapshot and zero external requests | `npm run build:editor`; `npm run test:editor-browser` |
| iOS JavaScript export | PASS — iOS bundle exported with Expo SDK 57; 964 modules bundled into 3.3 MB Hermes bundle `AppEntry-d555cc46c0219e614b43026f344364fa.hbc` | `npm run export:ios` |
| Desktop/mobile-width browser review | PASS — functional flows at desktop and 390 × 844 viewport | Screenshots in `evidence/` |
| Physical iPhone | PENDING — no physical-device run was performed | Use the checklist below |

### Timing evidence and limits

Web elapsed time uses `performance.now()` active segments; paused time is excluded. The latest fake-microphone browser run measured 50 ms between bookmarks immediately before and after pause settled (offsets 1,048 ms and 1,098 ms), then 1,742 ms after resume. Its active-clock duration was 1,809 ms and the resulting HTML media duration was 1,736 ms, a 73 ms difference in this 1.8-second fixture. The playback bookmark exactly matched the HTML player position at capture (0 ms difference). This is synthetic browser-fixture evidence, not physical microphone or iPhone sample-accuracy evidence. Tests verified bookmark seeking against the playable duration and clamping at its end.

Expo SDK 57’s recorder `currentTime` is read in seconds and converted to integer milliseconds for native capture bookmarks. Physical media-to-bookmark tolerance has not been measured on iPhone; no exact/sample-accurate claim is made. Device measurements are pending.

## Data and recovery checks

- Existing IndexedDB and SQLite note bytes remain untouched by the additive recording metadata migration.
- Tests cover note revision preservation, unsaved Web recovery-journal byte preservation, recording deletion cascade, Quick Voice permission denial, provisional note visibility, interrupted finalization retry, malformed archive rejection before writes, and older V2 imports.
- No personal audio, notes, AI providers, or paid services were used. Browser audio uses Chromium’s synthetic microphone.
- Expo SDK remains `~57.0.31`; `expo-audio` remains `~57.0.5`; React Native remains `0.86.3`.
- Test runtime: Node.js 24.21.0; browser: Chromium 156.0.8078.4.

## Physical iPhone acceptance checklist

1. In Expo Go, deny microphone access from Home Quick Voice; confirm no note or bookmark is created.
2. Record a Quick Voice clip; tap Bookmark twice, pause, wait several seconds, bookmark again, resume, then stop. Confirm paused time does not advance and the note appears only after finalization.
3. Repeat in an editable note. Bookmark, pause/resume, stop, close and reopen the note; confirm bookmarks remain in order and note revision is unchanged by bookmark edits.
4. Tap a saved timestamp before the player has loaded and after it has loaded. Confirm the player seeks to the requested moment and clamps when the file ends earlier.
5. Create a bookmark during playback; rename it to Vietnamese and Japanese text, clear the label, and delete a different bookmark.
6. Export a Full Archive V2 with anchors, restore it on iPhone, then import/export the same archive through Web. Confirm labels and offsets stay attached to the same recording.
7. Force-quit during an active recording and during a retryable save failure. Reopen and confirm recoverable audio/bookmarks are offered without creating duplicate notes or deleting the audio file.

**Stop point:** Phase 06 only. No Sync, Tailscale, transcription or AI work was started.
