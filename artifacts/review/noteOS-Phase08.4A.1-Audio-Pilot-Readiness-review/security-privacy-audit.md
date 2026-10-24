# Security and privacy audit

**Scope:** Changed note privacy enrollment, audio client verification/recovery, metadata updates, and existing media API trust boundaries. Code review plus temporary synthetic SQLite/IndexedDB tests; no production probing.

## Confirmed controls

- Local text enrollment is per selected note. `DEVICE_ONLY` requires explicit confirmation to change to `PRIVATE_SERVER`; no bulk classification or automatic enrollment was added.
- Audio approval requires local opt-in, enrollment, and a baseline whose acknowledged privacy matches the current note. The server independently requires the stored note privacy and device-specific media approval.
- Existing authenticated routes continue to enforce the paired device cookie, allowed origin, CSRF marker, private `no-store` responses, quotas and manifest/chunk digests.
- A server-side device-verification row is treated as advisory. Before reporting `verified-here`, the client validates recording identity, parent note, ordered local chunk presence, each chunk digest, full SHA-256 and metadata hash, then asks the server to refresh device verification.
- Recovery replaces bytes only for noteOS-owned `audio-sync` recordings and only after the complete replacement verifies. User-owned collisions are retained for review.
- PWA API routes remain network-only; no private media was added to the cache path.

## Fixed correctness findings

- A Quick Capture note with no privacy classification had no owner-facing path to authorize private-server text before audio sync. Added one-note owner flow and server-ACK gate.
- The client previously skipped a download solely when the server reported the device verified. It now rehashes local media and recovers missing/corrupt bytes.
- Recovery exposed a secondary overwrite path: downloaded recordings were eligible as upload candidates, so an incomplete local copy could publish a shorter object. Downloaded media is now excluded from byte upload; incomplete chunks and changed hashes fail closed. Explicit metadata changes use metadata-only updates.
- Metadata conflict resolution previously replaced local bookmarks. Remote merges now preserve local anchors and retain differing remote anchors separately.

## Residual limits

- No physical iPhone Safari test was performed. Playwright WebKit emulates a 390px viewport and does not prove iOS storage eviction, microphone, backgrounding or cellular behavior.
- Browser authentication, cookie expiry/revocation, and server-side authorization remain covered by existing Sync suites; production pairing was not changed or exercised.
- A future owner pilot must verify real-device persistence/recovery and confirm the UI conflict choices with actual recordings before enabling Audio Sync.
