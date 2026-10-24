# Privacy enrollment evidence

All evidence below is synthetic and contains no personal note content.

## Quick Capture journey

1. Created a normal note with no `privacy` field.
2. Owner action `Authorize this note for private-server sync` set only that record to `PRIVATE_SERVER`, kept its ID and canonical record, opted in that note, and queued an `audio-privacy` text-sync operation.
3. Existing text Sync pushed the full note through the authenticated sync route. Its ACK baseline stored the privacy value from the operation that the server accepted.
4. Audio approval was allowed only after the local note and server-acknowledged baseline matched and that note was enrolled.
5. Created a complete synthetic recording, approved audio separately, uploaded it, pulled the note to an independently paired synthetic client, approved audio on that client, and downloaded and hashed the recording.

The end-to-end run uses temporary SQLite and fake IndexedDB. It verifies one-note enrollment, no neighbor-note enrollment, note ID/document/lifecycle/tags preservation, independent text/audio approval, and upload/download.

## Existing local audio

An additional synthetic case attached audio before privacy authorization. The text outbox included only the explicit `audio-privacy` operation despite the normal exclusion for recording-bearing notes. The local recording remained intact and was not enrolled for audio until separate approval.

## `DEVICE_ONLY`

By default, the note stays `DEVICE_ONLY`; the repository rejects authorization without a separate explicit confirmation. Chromium and WebKit mobile-width UI checks verify the action remains disabled until the owner checks the confirmation. No notes are classified automatically.

Evidence: `evidence/browser/results.json`, `evidence/browser/chromium.png`, `evidence/browser/webkit-mobile-width.png`, and `evidence/tests/test-mvp.log`.
