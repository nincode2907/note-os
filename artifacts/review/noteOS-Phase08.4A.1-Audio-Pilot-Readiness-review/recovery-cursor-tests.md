# Local-media verification and recovery

## Device verification regression cases

| Case | Result | Expected behavior |
|---|---|---|
| Previously verified local recording remains intact after reload | PASS | Full local hash is recalculated; server verification is refreshed; one recording remains. |
| Server says verified, but all local chunks are missing | PASS | Local copy is marked for recovery and downloaded again. |
| Server says verified, but one local chunk is missing | PASS | Missing local media is detected and the complete object is re-downloaded. |
| Server says verified, but a local chunk is corrupted | PASS | Per-chunk/full digest mismatch triggers recovery. |
| Browser repository reload after successful recovery | PASS | Reopened IndexedDB is hashed and verified; no duplicate recording is created. |
| Same recording ID belongs to another local recording | PASS | Local recording is retained and state becomes `needs-review`; no overwrite. |
| Disconnect during verified-device recovery | PASS | Download cursor stays before the incomplete page, verified chunks remain resumable, and the server object remains unchanged. |

Metadata is checked alongside bytes: recording ID, parent note, full content hash, metadata hash and current server version. Metadata disagreement enters review; selected merges preserve local anchors and retain conflicting remote anchors under separate IDs. Byte disagreement is never silently resolved as metadata.

## Cursor and recovery semantics

| Scenario | Result |
|---|---|
| More than 100 changes | PASS — pages are fetched until `hasMore` is false; cursor reached 205 in synthetic paging. |
| Approval after the ordinary cursor passed a media change | PASS — server approval returns current recordings for discovery independently of cursor history. |
| Server epoch changes and old cursor is ahead | PASS — client receives the new epoch, restarts at cursor zero, then persists the new epoch/cursor. |
| Download fails halfway through a page | PASS — incomplete page cursor is not advanced; persisted chunks resume on retry. |
| Metadata changes while bytes already exist | PASS — bytes are checked; metadata conflict is preserved for owner review. |

Detailed deterministic tests are in `evidence/tests/test-mvp.log` and `evidence/tests/test-sync.log`.
