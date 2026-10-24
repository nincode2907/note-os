# Phase 08.4B Physical iPhone Audio Pilot Plan

This is a handoff plan only. No production audio transfer was enabled or attempted in Phase 08.4A.

1. Owner confirms current backups/notes are safe and approves enabling `NOTEOS_AUDIO_SYNC_ENABLED=1` for the pilot window. Keep note text Sync and existing paired devices unchanged.
2. Verify the feature flag and approved origin through the deployment configuration. Confirm the production v2 epoch/cursor and a restorable copy of SQLite plus the Sync volume before any authenticated audio request can trigger migration.
3. Pair only the intended Mac Chrome and physical iPhone Safari sessions. On each device, open an already text-synced test note with explicit `PRIVATE_SERVER` or `CLOUD_ALLOWED` privacy. Do not approve old notes in bulk.
4. Create a short disposable recording on iPhone. Explicitly approve audio for that note, keep Safari foregrounded, and confirm upload progress, server availability, title and anchors.
5. Approve the same test note on Mac Chrome, download, compare byte length/hash, play when the local browser supports the codec, and inspect anchor timestamps. Confirm per-device status changes only after local verification.
6. Test Wi-Fi/cellular loss during upload and download, tab reload, and server restart. Verify durable resume, no duplicate recording, no false `verified-here`, and no loss of local chunks.
7. Make conflicting offline bookmark/title edits on both devices. Review both versions and explicitly choose local or remote; verify the other version remains in conflict history.
8. Confirm note text Sync, Tailscale HTTPS, and MemoryOS remain healthy. Do not test iOS background guarantees as though PWA background execution were supported.
9. Revoke per-note approval on one device and verify its future server access is denied. Keep remote objects retained pending a separate deletion policy.
10. Record device model, iOS/Safari version, network, source/received SHA-256, bytes, elapsed time, retries, progress, UI screenshots with synthetic note titles only, and any limitations. Stop after the pilot; audio policy expansion requires separate approval.
