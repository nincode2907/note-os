# Phase 08.1 architecture decision

Use the existing Next.js Web container, Next.js Route Handlers and Node 22.21.1's built-in `node:sqlite` (SQLite 3.50.4 in the tested Alpine image). No SQLite npm binding or service was added. The built-in driver is experimental in this pinned Node runtime; accepting it for a disabled foundation is not approval for a production sync rollout. Runtime tests and production build were required because dependency installation uses `--ignore-scripts`.

The synchronous driver suits the current single-owner, bounded read-only milestone. Request bodies are capped at 256 KiB; client summaries and server comparison state are capped at 1,000 records. Larger libraries stop with an explicit capacity error. This is not a high-throughput claim.

## Storage

`/var/lib/noteos-sync/sync.sqlite`, its WAL/SHM and `.sync-epoch` marker live on a Docker local named volume, outside the image. The runtime runs as the unprivileged `node` user. SQLite uses WAL, foreign keys, FULL synchronous writes and a 2-second busy timeout. No network filesystem is used. Future immutable media blobs are reserved under `/var/lib/noteos-sync/blobs`; upload/download is absent.

Migration 001 creates server metadata, devices, reserved operation history, committed changelog, canonical entities, tombstones and pairing throttle state. Stateless preview needs no bootstrap-session table. Version 0 is initialized only through the owner's local CLI. Unknown schema versions and missing/mismatched epoch markers fail closed. Runtime requests never initialize a new server database. If the database or volume is unavailable, private API returns a generic 503 and the local note UI still works.

Cursor allocation, change append, entity/tombstone version and future operation result must commit in ONE writer transaction. A rolled-back cursor is never visible to clients. Composite foreign keys tie each entity/tombstone to its exact committed change; triggers reject live-entity/tombstone coexistence. No HTTP mutation caller exists for the reserved storage primitive.

## Routes

`/api/v1/sync/status`, `pair`, `revoke` and `bootstrap/dry-run` are owned by a catch-all Route Handler. Reserved unknown paths return 404. Other old `/api/*` paths retain the historical proxy as a fallback after filesystem/dynamic routes. That historical backend is not started or approved infrastructure.

`NOTEOS_SYNC_ENABLED=0` is fixed in the live Compose configuration. Merely setting a shell variable does not enable it. Allowed origins default to empty. The synthetic Compose file is a separate project, one Web container on loopback :15720, with its own named fixture volume. A temporary loopback TLS proxy in the browser test harness exists only for HTTPS cookie verification; it is not deployment infrastructure.

## Consistent backup and restore strategy

A volume is not a backup. For this foundation, keep the API disabled and stop ONLY noteOS Web before copying the complete volume (database, WAL/SHM if present, epoch marker and future blobs) from a read-only helper mount to an archive outside Docker. No writer or blob garbage collection may run during the copy. Record epoch, schema, cursor, file hashes and a blob manifest from the copied snapshot; run SQLite integrity_check and foreign_key_check against a restored copy in an isolated new volume. Preserve the original volume and compare restored epoch/cursor before activation. Never initialize a replacement epoch automatically or overwrite a live volume as a shortcut.

For future online backups, use SQLite's consistent backup API plus immutable blobs and a committed blob manifest/high-water mark, retaining blobs until the manifest and database snapshot are verified together. That mechanism is a future requirement, not implemented media backup.

References: https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html and the installed Next.js 16.4.2 Route Handler/rewrites documentation.
