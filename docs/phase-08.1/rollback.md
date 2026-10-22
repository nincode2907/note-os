# Exact rollback

Sync API is disabled in the live Compose file. No client note database schema, note save transaction, audio data or Tailscale mapping was changed.

To restore the previous Web image (tagged before Phase 08.1 deployment), from the repository root:

```sh
docker tag noteos-web-pre-phase081:local noteos-web-local
docker compose -f docker-compose.web.yml up -d --no-build --no-deps web
```

The new Sync named volume can remain attached and unused. Never delete it for rollback. To roll back source later, create a reviewed `git revert <Phase-08.1-commit>`; do not reset main or browser storage.

To stop only synthetic verification infrastructure:

```sh
docker compose -f docker-compose.sync-foundation-test.yml stop web
```

Do not run down -v, volume rm/prune, broad Docker restarts or tailscale serve reset. Both existing Serve mappings and Expo Metro :8085 remain in place.

Real-data activation is a later owner action after the safety/security gates. It requires an explicit local Compose override for NOTEOS_SYNC_ENABLED and a precise allowed-origin list; the shipped default remains 0. The owner then initializes an intended persistent empty volume with `docker compose -f docker-compose.web.yml exec -e NOTEOS_SYNC_ENABLED=1 web node sync-server/cli.mjs init` and generates a pairing code in an interactive terminal with `docker compose -f docker-compose.web.yml exec -e NOTEOS_SYNC_ENABLED=1 web node sync-server/cli.mjs pair`. Include `-f docker-compose.web.yml` when selecting the project. Do not run these against an unexpected/missing database history; recovery review must resolve missing epochs first. For a lost device, use local `cli.mjs devices` and `cli.mjs revoke <device-id>` in the intended project. No real browser was automatically enrolled during this phase.
