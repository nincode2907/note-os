# Phase 08.0 safety gate — owner verification required

Status: PENDING. The runner has not inspected personal databases or certified current backups.

Inventory from source and runtime:
- Mac Chrome `http://127.0.0.1:15700`: IndexedDB `noteos-mvp-01` v2, notes/recordings/recordingChunks; localStorage recovery and Quick Capture drafts.
- Tailscale `https://dn00392.tail913fb3.ts.net:8443`: separate browser origin, separate IndexedDB and drafts. Same hostname without :8443 serves another project.
- Safari on iPhone: another browser/device store even at the same HTTPS URL.
- Expo Go: `noteos-mvp04.db`, private audio files and recovery/Quick Capture/session tables. Paths remain owned by the Expo sandbox.
- Server: new named volume `noteos_noteos_sync`, initially empty with the private API disabled. It is not a client backup.

Before real-data activation, the owner must:
1. Open every origin/browser/device containing important notes. Do not assume a localhost archive covers HTTPS or iPhone.
2. Export a NEW **Full Archive V2**, labeled with origin/device and current date. Legacy JSON V1 has no audio and an older archive may omit recent notes or recordings.
3. Verify the exported manifest's counts and hashes, expected notes, audio bytes and Audio Anchors. Keep a second copy outside the app/volume.
4. Export the native Expo archive separately and validate it on an isolated target; verify recordings and anchors are present/playable. Do not restore over the only real copy.
5. Record which archive covers each store. Outstanding drafts/recovery or unfinished audio must be resolved or explicitly preserved.
6. Review Tailnet access rules and trust of the other service using the same hostname; approve the intended device list before enabling private APIs.

The live configuration stays disabled. Synthetic test results do not satisfy this owner gate. No automatic enrollment, merge, import, local database reset, or production note mutation is part of Phase 08.1.
