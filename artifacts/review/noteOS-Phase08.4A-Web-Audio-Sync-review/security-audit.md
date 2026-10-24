# Defensive Security Review

## Controls checked

- Audio routing is independent and requires both `NOTEOS_SYNC_ENABLED=1` and `NOTEOS_AUDIO_SYNC_ENABLED=1`; Compose pins audio to `0`. Disabled requests return before opening storage.
- Authenticated cookie session, device revocation, exact Host/Origin and same-origin fetch metadata are checked on every media request. Mutating requests require the sync marker and exact JSON or octet-stream content type.
- Note approval is per device and per note. Both browser and server reject absent privacy, `DEVICE_ONLY`, unknown notes, and missing explicit audio approval. Recording parent IDs cannot change after first commit. Parent trash does not remove its media.
- UUID/recording IDs and digests are validated before filesystem path creation. Content hashes determine object paths; clients cannot submit paths. Symlinks and non-regular media paths fail closed.
- Request JSON is bounded to 256 KiB; chunks are capped at 1 MiB; recording size, upload sessions, TTL, concurrency and total media quota have hard bounds. Bodies stream to private files and are hashed while written.
- Chunk and object hashes are verified before receipt/commit. Publication is no-overwrite and content-addressed. Corrupt full media is not published or marked verified. Downloaders recheck every chunk and the full hash before local commit.
- Conflicting metadata retains local and remote snapshots in `sync_audio_conflicts`; it does not silently overwrite. No remote delete, garbage collection, external service, or audio logging was added.
- Service worker excludes all API requests from cache and uses `no-store` for Sync; server media responses are `no-store` and `nosniff`.

## Negative tests

`test-sync.log` covers disabled mode, unauthorized/revoked clients, origin/host/CSRF failures, DEVICE_ONLY, corrupt chunks, corrupt full-object digest, quota rejection, stale metadata conflict, and path-independent opaque errors. `test-mvp.log` covers local privacy approval, persisted chunk resume, and hash-before-IndexedDB-finalization.

## Residual risks

- Transfer activation and actual reverse-proxy behavior on the live Tailnet hostname were intentionally not exercised. Keep the feature flag off until a separate approved real-device pilot.
- The current single-service deployment is assumed for the process-local publication queue; SQLite `BEGIN IMMEDIATE`, hard-link idempotency and durable reservations provide cross-process serialization for DB metadata and object publication.
- Large recordings need free space for staged source chunks plus a temporary assembled copy. Reservations and quota checks account for that; quota errors retain staging data for explicit retry/review rather than deleting a possible sole copy.
