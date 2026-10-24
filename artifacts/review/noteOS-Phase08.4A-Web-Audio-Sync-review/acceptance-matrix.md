# Synthetic Acceptance Matrix

The named automated suites and browser evidence are under `evidence/`. PASS means the listed synthetic fixture or regression passed; it does not mean physical iPhone acceptance.

| # | Required scenario | Result and evidence |
|---:|---|---|
| 1 | Small recording uploads/downloads with identical SHA-256 | PASS — `test-sync.log`, authenticated transfer + client round-trip |
| 2 | Multi-chunk order and total length | PASS — `test-mvp.log`, 1 MiB+ paired-client transfer |
| 3 | Unicode metadata and anchors round-trip | PASS — `test-sync.log`, protocol and media manifest tests |
| 4 | Interrupted upload resumes after chunk N | PASS — `test-mvp.log`, retry test resumes from the stored receipt |
| 5 | Interrupted download resumes after chunk N | PASS — `test-mvp.log`, verified IndexedDB chunk reused after repository reload |
| 6 | Lost ACK/retry does not duplicate media | PASS — `test-sync.log`, repeated completion is idempotent |
| 7 | Browser reload preserves pending transfer state | PASS — `test-mvp.log`, new repository instance reads the same synthetic IndexedDB state |
| 8 | Server restart preserves upload/verified content | PASS — `test-sync.log`, close/reopen fixture and resumable persistent session |
| 9 | Crash between file write and SQLite receipt recovers | PASS — `test-sync.log`, staged chunk recovered into the receipt table |
| 10 | Corrupted upload chunk is rejected | PASS — `test-sync.log`, digest mismatch leaves no accepted receipt |
| 11 | Corrupt whole recording is never published/verified | PASS — `test-sync.log`, wrong full digest creates no media row or device verification |
| 12 | Missing receiver bytes are not marked verified | PASS — `test-mvp.log`, interrupted receiver remains `downloading` and has no finalized recording |
| 13 | Existing synced note receives a later recording | PASS — `test-mvp.log`, both clients start with the parent note already present |
| 14 | DEVICE_ONLY/unclassified audio cannot upload | PASS — `test-sync.log` and `test-mvp.log`, server and local approval gates |
| 15 | Unpaired/revoked clients cannot access media | PASS — `test-sync.log`, anonymous and revoked-cookie requests denied |
| 16 | Invalid Origin/Host/CSRF denied | PASS — `test-sync.log`, wrong origin, host, missing marker cases |
| 17 | Concurrent same-transfer uploads are idempotent | PASS — `test-sync.log`, concurrent chunk and complete requests produce one object/event |
| 18 | Audio Anchors survive transfer | PASS — `test-sync.log`, Unicode label round-trip |
| 19 | Concurrent anchor edits preserve both versions | PASS — `test-sync.log`, stale server version stores conflict; explicit review choices are in UI |
| 20 | Trashing parent does not delete audio | PASS — `test-sync.log`, retained object remains downloadable |
| 21 | Interrupted/failed recordings stay local | PASS — `test-mvp.log`, only complete recordings are upload candidates; incomplete manifest rejected |
| 22 | Text Sync regression | PASS — `test-sync.log`, text pull advances over recording cursors without exposing media as note changes |
| 23 | Full Archive V2 remains complete | PASS — `test-mvp.log`, Archive V2 audio/anchor round-trips |
| 24 | PWA does not cache private Sync/audio API | PASS — `test-mvp.log`, service-worker policy assertion; API is network-only |
| 25 | Chunk/memory/storage limits | PASS — 1 MiB chunk tests, early quota rejection, measured suite/build RSS in report |
| 26 | v2→v3 migration preserves existing text state | PASS — `test-sync.log`, epoch/cursor/device/note preservation and unauthenticated no-migration check |
| 27 | Mac↔iPhone text Sync is not disrupted | PASS for synthetic regression only — existing text Sync suite and shared-cursor test; the earlier owner-confirmed 08.2B hardware pilot was not rerun |
| 28 | No permanent Docker service introduced | PASS — Compose service definition unchanged; only an explicit audio-off environment entry was added; before/after resource IDs match |
