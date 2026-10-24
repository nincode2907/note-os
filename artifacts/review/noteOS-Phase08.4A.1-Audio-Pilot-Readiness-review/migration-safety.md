# Migration and production safety

- Phase 08.4A.1 adds no database migration or server schema change.
- The additive SQLite v2-to-v3 audio migration remains behind the authenticated audio API and explicit audio feature gate. Existing migration tests verify preservation of epoch, cursor, notes, entities and devices.
- Migration testing used temporary synthetic SQLite stores only. Production SQLite was not opened, migrated, reset or modified.
- Production `NOTEOS_AUDIO_SYNC_ENABLED` remains effectively OFF: the running noteOS Web container does not have the value `1`, the base Compose configuration explicitly sets `0`, and the server requires exactly `1` to enable audio routes.
- Existing text Sync remains enabled in the running container (`NOTEOS_SYNC_ENABLED=1`).
- No production media directories, pairing records, note data, Tailscale state, routes or policies were accessed or changed.

Relevant verification: `evidence/tests/test-sync.log`, including the default-disabled endpoint and additive migration tests; `evidence/docker/` for post-run runtime inventory.
