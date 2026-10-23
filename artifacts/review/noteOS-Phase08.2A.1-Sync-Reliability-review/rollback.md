# Rollback Instructions

1. Keep normal production Sync disabled (`NOTEOS_SYNC_ENABLED=0`). Do not pair devices or point real data at the test service.
2. Revert the Phase 08.2A.1 commit on `main` if source rollback is required. The commit is scoped to the Phase 00 web spike, its test-only Compose file, documentation, and this review bundle; it does not include the pre-existing deleted review artifacts.
3. Stop the dedicated synthetic test container if it is still running. Preserve its named volume; do not use `docker compose down -v` or delete volumes.
4. The IndexedDB v4 migration adds a quarantine store and does not rewrite or remove existing note/outbox data. Do not downgrade or manually edit a browser database as a rollback step. If a synthetic test profile needs disposal, clear only that synthetic profile using its documented test harness.
5. Reconfirm normal production Sync remains off and its status endpoint returns unavailable after rollback.
