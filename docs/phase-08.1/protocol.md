# Sync protocol v1 — preview only

Executable shared validation and comparison: `web/app/lib/sync-protocol.mjs`. JSON Schema: `web/sync-server/protocol.schema.json`. These are importable by future native integration without changing the canonical document schema.

- `localRevision`: client CAS integer. Used only as client context, never assigned to serverVersion.
- `serverVersion`: per-entity committed version, initially independent of client revisions.
- `serverCursor`: global committed sequence, allocated and appended in the same transaction as a change. Gaps created only by uncommitted reservations are not visible.
- `serverEpoch`: persistent identity of server history.
- `operationId`: stable idempotency key, scoped to an enrolled device in reserved operation history. Future replay must compare request_hash before returning the stored result. No operation endpoint is active now.

Unexpected epoch change or cursor rollback halts preview/future sync and requires recovery review. The shared contract tests enforce this. The browser keeps only an origin-local session history checkpoint; no bearer credential is stored in localStorage.

POST `/api/v1/sync/bootstrap/dry-run` accepts `{protocolVersion:1,records:[{id,contentHash,lifecycle,localRevision,recordingCount}]}`. It rejects duplicate IDs, extra fields, non-string hashes, malformed versions and oversized data. Hashes use stable, sorted-key JSON of semantic note fields, excluding id, revision, createdAt and updatedAt. Unknown JSON semantic fields remain in the hash; non-JSON values are rejected. This is a text/semantic hash, not a verified audio hash.

Read-only discovery opens only an existing browser database, without a version upgrade, using readonly transactions. Missing/DEVICE_ONLY privacy is excluded; no privacy level is lowered. Only an explicit user request sends summaries for notes already marked PRIVATE_SERVER or CLOUD_ALLOWED. Titles, text and audio bytes are not transmitted. Existing real notes commonly have no explicit server privacy field and stay excluded. This milestone does not add a control to change that permission.

Preview returns ID lists `toUpload`, `toDownload`, `identical`, `collidingIds`, `audioRequiresReview`, plus server history and `serverEmpty`. Matching ID alone is insufficient. Different content or lifecycle, or any local/server audio presence, requires review. A server tombstone colliding with a client ID requires review. Empty-server results cannot establish conflicts among three populated clients. All categories are hypothetical; there is no apply/import button.

## Audio safety contract for later work

States: `text-local`; `text-synced-audio-pending`; `metadata-synced-blob-pending`; `fully-verified`; `conflict-review`.

Fully verified requires all required audio bytes and anchors, not just text or recording metadata. Notes containing recordings are excluded from any real text-only pilot until safe cross-device media-presence semantics exist. Cross-device Delete Forever stays unavailable. Recording ownership, archive semantics and anchors are unchanged. Native credential work is deferred: the installed SDK 57 module map specifies `expo-secure-store ~57.0.4`; future integration must verify `isAvailableAsync()` in the actual installed Expo Go client and store the credential in SecureStore/Keychain. No native dependency or SDK version was changed. Official guidance: https://docs.expo.dev/versions/latest/sdk/securestore/ (latest docs version is not an instruction to upgrade SDK 57).
