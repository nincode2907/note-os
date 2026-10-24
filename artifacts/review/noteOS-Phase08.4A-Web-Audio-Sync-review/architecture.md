# Protocol, Storage and Security Notes

## Transfer protocol

The client prepares a manifest from complete IndexedDB recording chunks. The ordered manifest carries protocol version, stable recording/note IDs, source MIME, status/timestamps/duration, optional supported metadata extensions, Audio Anchor Set v1, whole-object SHA-256, byte length, 1 MiB chunk size, and a digest/length for each chunk. Transfer IDs are random UUIDs and persist in IndexedDB until their operation completes. A metadata change creates a new transfer ID; retrying an unchanged payload reuses its ID.

Endpoints are under the existing `/api/v1/sync/media/` route: status, explicit per-device note approval, upload start/resume/status/chunk/complete, paged media changes, metadata updates, verification, and chunk downloads. JSON metadata is bounded to 256 KiB. Binary chunks use `application/octet-stream` and `X-NoteOS-Sync: 1`; no base64 payloads are used.

## Server persistence and recovery

- `sync_media_uploads` records transfer ownership, manifest digest, reservation, state and expiry. `sync_media_upload_chunks` records only chunks whose durable staged file matches its expected digest.
- Chunk and final object files use mode 0600 under mode 0700 directories in the existing Sync storage mount. Upload bodies stream to a temporary file; bounded buffers are hashed and written incrementally. Files and containing directories are flushed before receipt/publication.
- Final objects live at `media/objects/sha256/<prefix>/<digest>`. Assembly verifies every chunk and the full digest, then hard-links the object without replacing an existing object. Original staging chunks remain available.
- States progress `receiving → publishing → published`. `publishing` reserves extra assembly space. A retry after a crash verifies an already-published object or reassembles from durable staged chunks, then commits metadata transactionally. A staged chunk with no SQLite receipt is reconciled by hash on the next authenticated audio API call. An object created before DB commit remains an accounted orphan; retry can reuse it. No garbage collector is present.
- Per-device verified state is written only after a complete server-side upload commit or an authenticated receiver verification call. Receiving clients persist each downloaded chunk, verify its chunk digest and whole-object digest, atomically add recording+chunks to IndexedDB, and only then send the verification request.

## SQLite/IndexedDB migration

SQLite user_version 2→3 is additive. It preserves the existing meta row epoch/cursor and all v2 text entities, devices, operations and changelog rows. Normal text `openStore()` does not apply the audio migration. The audio handler checks the existing session first and only then opens the v3 path. Migration fixtures assert that an unauthenticated request leaves v2 intact.

IndexedDB advances from version 4 to 5 with three new stores: `audioSyncApprovals`, `audioSyncState`, and `audioSyncChunks`. Existing note, recording, chunk and sync stores are preserved. Approval requires an explicit supported privacy classification and an existing text-sync baseline; missing privacy is denied.

## Origin, authorization and privacy

Every audio request uses the existing authenticated device session and exact configured Host/Origin checks. POST/PUT JSON/binary requests require the custom sync marker and expected content type. Download and metadata endpoints recheck device approval and parent-note privacy. Approval removal is sent to the server on the next existing sync-worker cycle; remote bytes are retained, while that device’s access is denied. The browser service worker bypasses all `/api/` routes and uses `no-store` for Sync requests.

Audio leaves the browser only after per-note approval. Device-only, missing privacy, unfinished recordings, unknown note IDs, invalid IDs/digests, malformed anchors, oversized chunks, expired sessions, quota excess, and unpaired/revoked sessions fail closed. No provider, analytics, transcription, external storage, or AI endpoint receives audio.
