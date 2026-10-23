# Data Safety Audit

- **Scope:** synthetic Phase 00 web sync spike under `spikes/phase-00/gate1/web`; test Compose override is isolated and local-only.
- **Production gate:** normal Compose remains unchanged. Confirmed `NOTEOS_SYNC_ENABLED=0`; `/api/v1/sync/status` on `127.0.0.1:15700` returned HTTP 503.
- **Data used:** generated synthetic notes, operations, recordings, and browser profiles only. No personal notes or user backups were accessed or uploaded.
- **Volumes:** test runs used dedicated named synthetic volumes. No Docker volume deletion or reset was issued. Existing data volumes were not targeted.
- **Network:** test web services bound to loopback. No Tailscale Serve, identity, tag, ACL, or hostname change. No external AI/STT request.
- **Audio:** audio bytes and anchors remain local; no upload/download path was introduced. Pull preserves local recordings and anchor metadata.
- **Privacy/enrollment:** DEVICE_ONLY and unapproved notes remain excluded; server endpoints retain authentication/CSRF checks. Sync server regression suite passed 40/40.
- **Conflicts:** full local and remote note versions are retained. Conflict copies are local-only until explicit user action and are not presented as backed up or synchronized. Repeated pulls are idempotent.
- **Deletion:** no remote permanent deletion endpoint was added. Tombstones and lifecycle remain constrained by existing sync contracts.
- **Schema:** Canonical Document v1 was not changed. IndexedDB migration is additive (v3 to v4) and has regression coverage.
- **Hardware:** no physical iPhone test was performed; browser viewport evidence must not be interpreted as device validation.
