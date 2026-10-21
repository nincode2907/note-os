# noteOS Web — Local Runtime Handoff

**Runtime:** PASS for everyday browser text notes · **URL:** http://noteos.localhost/ · **HTTP:** 200

**Captured:** 2026-10-21 (Asia/Ho_Chi_Minh)

## What is running

- Compose project `noteos`, service `web`, container `noteos-web-1`, image `noteos-web-local`.
- Next.js 16.4.2 production server, built from `spikes/phase-00/gate1/web`; Node image `22.21.1-alpine`.
- Only `web` is running for noteOS. Compose health is `healthy`. It has no container mounts, database dependency, or persistent Docker volume.
- Host publication is loopback `15700 → 3000` in the container. Dev Hub proxies `noteos.localhost` to port 15700 and reports the Web service as OBSERVED/running. The old host port 3000 was removed at the user's request.
- Existing `noteos-phase00` Phase 00 containers were left as found: web `Created`; API and MySQL exited 137; PowerSync exited 1; MongoDB exited 255. They were not restarted or cleaned up.

## Persistence and dependencies

Ordinary notes are stored in the browser's IndexedDB database `noteos-mvp-01` (version 2). Preferences and best-effort recovery drafts use browser localStorage. Use the canonical origin `http://noteos.localhost` consistently: `http://127.0.0.1:15700` is a separate browser origin even though it serves the same app. Data at the earlier `http://127.0.0.1:3000` origin was not deleted or migrated. Clearing browser site data can remove notes.

Text-note create/edit/search/tag/pin/checklist/lifecycle flows do not call the API, PowerSync, MySQL, MongoDB, or Redis. AI, STT and cloud services are not part of this runtime. The audio control remains optional in the UI; microphone behavior was not tested and may require a browser permission.

The older stopped MySQL and MongoDB containers map to `noteos-phase00_noteos_gate1_mysql` (`/var/lib/mysql`) and `noteos-phase00_noteos_gate1_mongo` (`/data/db`). Their contents were not opened. The new `noteos` project declares no DB or volumes, so it does not remap or initialize those stores. Do not rename or bring up the old Compose project under a new project name without a separately reviewed volume plan.

## Browser acceptance

The full acceptance below was verified in Chrome at the earlier port-3000 origin with clearly marked disposable `QA — ...` notes. After aligning with Dev Hub, the canonical hostname's Home page was separately opened in Chrome and both the proxy and direct port 15700 returned HTTP 200.

- Home loaded without fatal errors; Chrome console had no errors.
- Created a note; edited title/body; added a checklist item; checked and unchecked it; added `qa-disposable`; pinned it.
- Refreshed and confirmed title, body, checklist state, tag and pin persisted.
- Opened the same note in a second tab. A stale edit displayed the conflict warning, retained its draft, and recovered it as a separate note without overwriting the newer revision.
- Archived and restored the original QA note; found it through search.
- Moved both disposable QA notes to Trash using recoverable actions. No permanent deletion was used. Home is left empty and ready for the user's notes.

Desktop layout was visually checked in Chrome 155.0.8059.85 at the normal desktop viewport. Existing responsive CSS includes 900 px and 650 px breakpoints. The Chrome automation viewport override did not change the visible desktop viewport, so narrow/mobile visual acceptance remains **BLOCKED**; no mobile result is claimed.

## Start and stop

From the repository root:

```sh
rtk docker compose -f docker-compose.web.yml up -d --build web
rtk curl -I http://noteos.localhost/
rtk docker compose -f docker-compose.web.yml ps
```

To stop only this Web stack:

```sh
rtk docker compose -f docker-compose.web.yml down
```

There are no named volumes in this Compose file; stopping it leaves browser IndexedDB intact. Do not run the root `docker-compose.yml` to start everyday notes; it is the separate Phase 00 backend/sync stack.

## Known limits

- Docker image build passed. `npm install` reported 2 moderate advisories; no dependency changes or audit fix were applied.
- `/api/*` rewrites still target the old `gate1-api` service. They are unused by the verified ordinary text-note workflow; API-backed experiments may not work in this Web-only runtime.
- Audio, AI, STT, cloud, PowerSync, database-backed sync and narrow/mobile visual behavior were not validated here.
