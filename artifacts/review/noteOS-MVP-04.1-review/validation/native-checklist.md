# Native validation checklist — BLOCKED

No screenshots were captured: Xcode, simulator tooling, and a physical iPhone were unavailable in this environment. Do not treat JS export as a native build.

When a simulator and real iPhone are available, use fresh isolated prototype data and record exact OS/device, iterations and logs:

- Header Back, swipe Back and programmatic navigation while recording; double Record and double Stop.
- AppState during permission request, recorder preparation, active recording, stop and finalization.
- Inject recorder stop, file verification and SQLite save failures; confirm no completion status before metadata commit.
- Stale revision and non-trashed permanent delete; verify a failed transaction leaves audio files present.
- Individual recording deletion; inject file-delete failure and process interruption after metadata commit; confirm cleanup queue retries on Home.
- Duplicate backup import rollback; concurrent import/save; record actual `SQLITE_BUSY` outcomes.
- Edit without Save, reopen, Restore/Discard/Keep; stale draft, failed save, successful journal clear and edit while write is in flight.
- Legacy backup without pin/tags; rich-text pin; verify `updatedAt` is unchanged on pin and revision changes.
- Lifecycle transition with an unknown future schema; confirm content bytes/data remain preserved.
- Missing audio, rename rejection and playback of an existing file.
- `directory: 'document'` finalized URI, nonzero file size, app restart and reopen/play.

Native Gates A/B/C: **BLOCKED** pending these checks.
