# noteOS — Recovery 00-R / 00-R.1: Capacity, Contract Fix & Lean Profiles

**Run date:** 2026-10-20  
**Scope:** 00-R read-only Docker capacity analysis; 00-R.1 minimal Laravel contract fix, feature tests, static PowerSync diagnosis and Gate 1 Compose profile preparation. No container was started/stopped, no image was built, no Docker setting or test volume was changed, and no browser or sync test was run.  
**Gate status:** Gate 1 remains **BLOCKED**. Sync Engine remains **UNDECIDED**.

# Recovery 00-R.2 — controlled capacity gate (2026-10-20)

**Gate A: BLOCKED — `CAPACITY_UNVERIFIED`; HARD STOP.** This turn performed read-only inspection only. Gates B and C were not started; no Laravel command, Compose `up`/`run`/`build`, browser process, or fixture write was attempted. No container, image, setting, or volume was changed.

| Check | Current evidence | Result |
| --- | --- | --- |
| Docker VM capacity | `wsl -d docker-desktop` reported 7.6 GiB RAM total, 1.7 GiB used, 2.9 GiB free, 5.7 GiB available; 2.0 GiB swap total and free. HostConfig on the six running containers has no memory or swap limit. | VM-level snapshot available, but insufficient by itself to establish safe end-to-end headroom. |
| Windows host capacity | `Win32_OperatingSystem`: 16,393,116 KiB visible RAM, 475,680 KiB free (~465 MiB). `vmmemWSL` working set ~4.2 GB; Docker backend ~97 MiB. | **Host memory pressure risk.** |
| Current containers | Six `noteos-phase00` services are running: Web (59.7 MiB), API (89.1 MiB), PowerSync 1.20.0 (220.1 MiB), Redis (6.8 MiB), MySQL 8.4.7 (483.9 MiB), MongoDB 8.0.16 (314.8 MiB). All report no per-container memory limit; each is owned by this noteOS Compose project. PowerSync and MongoDB were already running and were not touched. | Existing workload must be preserved; candidate browser run would add unmeasured demand while host free RAM is ~465 MiB. |
| Recent OOM/events | Docker event query returned no OOM events in its 7-day window. Current six containers show `OOMKilled=false`, restart count 0. | No recent OOM event observed; prior recovery report still records historical OOM kills. |
| MySQL health/recovery | noteOS MySQL is `running`, health `healthy`, version 8.4.7, restart count 0. Logs show InnoDB initialization ended, XA crash recovery started and finished at 2026-10-20 15:31:41 UTC, and “ready for connections.” | **PASS for current DB health/readiness only.** Does not attest candidate test-volume integrity. |
| Test volumes | Existing `noteos-phase00_noteos-phase00_{mysql,mongo,redis}` volumes were listed. No candidate Gate 1 containers exist. The Watermelon Compose volume is declared separately and no matching created volume was observed. Existing volumes were not mounted or modified. | Candidate volume integrity/readiness **NOT VERIFIED**; no volume was created or inspected by starting a service. |
| Watermelon profile / image reuse | Compose lists only `gate1-watermelon-mysql`, `gate1-watermelon-api`, `gate1-watermelon-playwright`, and `gate1-watermelon-web`. The prior report estimates 2–3 GiB for an isolated Watermelon browser run, explicitly unmeasured. | Resource budget is an estimate, not evidence of safe headroom; no run. |

**Decision:** Gate A does not pass. The measured Docker VM `MemAvailable` is 5.7 GiB, but the Windows host has only ~465 MiB free while six unlimited noteOS containers are active; the proposed browser workload's actual peak is unknown. Starting it could pressure existing host/container workloads. Stop here under the approved safety gate. **Gate B Laravel tests: NOT RUN. Gate C Watermelon initial pull: NOT RUN (not 0/20; no result). Root cause of prior browser 0/20 remains UNKNOWN.** No files under application/test source changed in this turn. Docker health at handoff: all six current noteOS containers were listed running; noteOS MySQL healthy. See the other 00-R.2 report addenda for the same gate verdict.

## Recovery 00-R.3 — controlled workload reduction (2026-10-20)

**Step 1 — PASS.** `docker compose ps --all` confirmed `noteos-phase00` ownership for services. Graceful `docker compose stop --timeout 30 powersync mongo` stopped only `noteos-phase00-powersync-1` and `noteos-phase00-mongo-1`; both exited 0. MySQL/API were healthy and kept running. Redis/Web were left running. Worker was already `Exited (1)` and was not touched. `dev-hub-caddy` was outside this Compose project and was not touched. No volume, image, setting, database or other project was changed.

**Step 2 — PASS for a lightweight Laravel test only; NOT PASS for Chromium.** Immediately before stopping, Windows already showed ~1.68 GiB available. Three post-stop samples over ~20 seconds fluctuated between ~1.28 and 1.71 GiB, with a final snapshot of 1,838 MiB; a sustained host-memory increase from stopping the two services was not established. Committed memory was ~23.6–24.0 GB of 33.6 GB. Paging samples settled at 21–93 pages input/sec and 2–6 page reads/sec. Docker VM reported 7.6 GiB RAM, 5.9 GiB available, 2 GiB swap entirely free; memory PSI `some`/`full` averages were 0.0. Existing Web/API/Redis/MySQL usage stayed around 63/90/7/485 MiB across samples. No Docker OOM event appeared in the 15-minute post-stop query; retained containers reported `OOMKilled=false`, restart count 0. MySQL/API/Redis/Web remained healthy. The 1.28–1.80 GiB Windows headroom does not establish safe capacity for the unmeasured 2–3 GiB Chromium/browser envelope, so Step 4 remains gated off.

**Step 3 — BLOCKED; no test started.** The existing API container provides PHP 8.4.26 and Laravel 12.70.0, and `vendor/autoload.php` exists, but `vendor/bin/phpunit` is absent (`phpunit-missing`). The test configuration specifies SQLite `:memory:` with `RefreshDatabase`, so its database target is isolated; however, without PHPUnit the approved test cannot run. No dependencies were installed. All four `SyncPullContractTest` cases are **NOT RUN**.

**Step 4 — NOT RUN.** Gate C requires Gate B PASS, which did not occur; remaining Windows headroom also falls below the prior 2–3 GiB browser planning estimate. Watermelon result is **NOT RUN**, neither 20/20 nor 0/20. No Gate 1 service/container/volume was started or created, no fixture was seeded, and the prior 0/20 root cause remains **UNKNOWN**.

**Handoff inventory:** running containers are `noteos-phase00-api-1`, `noteos-phase00-mysql-1`, `noteos-phase00-redis-1`, `noteos-phase00-web-1`, and external `dev-hub-caddy`. PowerSync and MongoDB are stopped cleanly; worker was already exited. No source/test code changed. See corresponding 00-R.3 entries in the framework, sync and final reports.

## Recovery 00-R.1 update

- **00-R.1a contract review:** confirmed the endpoint already returns `changes.notes.deleted` as an array of record IDs (including `[]` when empty). No collection-level tombstone field was missing, so the endpoint and cursor algorithm needed no further change. The `deleted: false` raw record field is declared in the Watermelon client schema and remains in created/updated records.
- **Contract assertions strengthened:** four feature tests now decode the response as JSON objects so they verify `created`, `updated`, and `deleted` are JSON arrays, collection name is exactly `notes`, and raw record fields exactly match the client schema. Tombstone coverage checks the deleted ID is in the collection-level `deleted` array and absent from active changes.
- **Laravel tests: NOT RUN.** Host PHP 7.4.33 is unsuitable for Laravel 12 and `api/vendor/autoload.php` plus `vendor/bin/phpunit` are absent. No package install or container was used. PHP syntax checks are static only and do not establish Laravel behavior.
- **Lean Compose profiles applied:** new [docker-compose.gate1.yml](../../docker-compose.gate1.yml) defines `gate1-watermelon` and `gate1-powersync`; the old coupled Gate 1 services were removed from the default Compose file. Static `docker compose config --quiet` passed for the root file and both Gate 1 profiles. No `up`, `run`, `build`, `restart`, or `down` command was used.
- **Capacity:** **CAPACITY_UNVERIFIED**. Prior OOM evidence remains; Docker VM telemetry changed externally during the previous inspection, current available VM memory is unknown, and noteOS MySQL health/data integrity remain unverified. No test is authorized by this report.

## 1. OOM classification and confidence

| Finding | Evidence | Classification / confidence |
| --- | --- | --- |
| noteOS baseline MySQL was OOM-killed | `docker inspect`: `exit=137`, `OOMKilled=true`, `HostConfig.Memory=0`, `MemorySwap=0`, `MemoryReservation=0`. Last MySQL log ends after “InnoDB initialization has started”; it never logged “ready for connections” on the latest attempt. | **VERIFIED OOM kill — high confidence.** The container had no explicit per-container memory limit. |
| Isolated Gate 1 MySQL was OOM-killed | Same inspect values: `exit=137`, `OOMKilled=true`, no memory/swap/reservation limits. Earlier logs show database initialization completed and MySQL became ready before the later exit. | **VERIFIED OOM kill — high confidence.** |
| Scope of the OOM | At the first capacity read, Docker Desktop settings showed 5,120 MiB RAM / 1,024 MiB swap and Docker Engine reported 5,173,080,064 bytes (4.818 GiB). A later settings/engine read changed to 8,192 MiB / 1,024 MiB and 8,337,670,144 bytes (7.765 GiB); the exact capacity at the OOM timestamps is not independently recorded. Both MySQL containers had no per-container cap. Container-level `memory.events`/OOM counters are unavailable for the stopped containers; no matching noteOS OOM event appeared in the retained 24-hour Docker event query. | **Likely Docker VM/global memory pressure; exact OOM scope UNKNOWN.** `OOMKilled=true` proves an OOM kill but does not distinguish VM-wide kernel pressure from a cgroup event without counters. |
| macOS host pressure | Host reports 16 GiB physical RAM, 39% free in `memory_pressure`, and 12,453 MiB of 13,312 MiB swap used. | **Observed host condition, not a direct Docker VM available-memory reading.** This indicates substantial swap use; it cannot identify the Docker VM OOM trigger. |
| Other noteOS exits | API/Web/Mongo show exit 137 but `OOMKilled=false`; Gate 1 Mongo exited 255; Gate 1 PowerSync exited 1. | **Cause UNKNOWN.** Do not attribute these exits to OOM based on exit code alone. |

Docker Desktop settings changed during this read-only inspection: the first read showed `memoryMiB=5120`; the settings file mtime then advanced to 15:39:30 +07 and a later read showed `memoryMiB=8192`. `swapMiB` remained 1024. Docker Engine initially reported 5,173,080,064 bytes, then at 15:41 reported 8,337,670,144 bytes (7.765 GiB), so the live daemon capacity also changed. **No Docker setting or container was changed by this task; the actor/cause of the external change is unknown.** Do not assume a restart is needed or perform one in this recovery task.

Available memory inside the Docker VM is not exposed by the read-only Docker API snapshot. The stopped MySQL cgroup counters no longer appear through inspect, and no VM shell/cgroup access was available without starting or exec'ing a container. No attempt was made to do either. The earlier 5 GiB capacity and 8-container inventory below are time-bounded observations, not the current Docker VM state.

## 2. Capacity inventory and observed usage

Docker Desktop settings file: `~/Library/Group Containers/group.com.docker/settings.json`. Latest read: `cpus=4`, `memoryMiB=8192`, `swapMiB=1024`, `diskSizeMiB=76294`. The current Docker Engine read reports 4 CPUs, cgroup v2, memory/swap limit support, and 7.765 GiB memory. The setting and live engine were both read-only; the observed change during this task was external and its source is unknown.

At approximately 15:38 +07, 8 containers were running. Two snapshots several minutes apart showed roughly 2.2 GiB aggregate container working set; this is not VM headroom and is not a peak measurement.

| Running container | Project / service | Current observed memory | Configured memory limit / reservation |
| --- | --- | ---: | --- |
| `memoryos-web-1` | `memoryos` / web | 1,022 MiB | none / none |
| `memoryos-mysql-1` | `memoryos` / mysql | 402.2 MiB | none / none |
| `memoryos-api-1` | `memoryos` / api | 127.5 MiB | none / none |
| `memoryos-queue-1` | `memoryos` / queue | 30.81 MiB | none / none |
| `memoryos-ai-worker-1` | `memoryos` / ai-worker | 30.81 MiB | none / none |
| `memoryos-redis-1` | `memoryos` / redis | 9.859 MiB | none / none |
| `dev-hub-caddy` | `dev-hub-proxy` / caddy | 24.77 MiB | none / none |
| `mysql-local` | `db` / mysql-local | 543.4 MiB | none / none |

All 8 containers have `HostConfig.Memory=0`, `MemorySwap=0`, and `MemoryReservation=0`, so Docker has no configured container-specific cap/reservation for them. `docker stats` is a point-in-time working-set view. It does not include unobserved peaks, Docker daemon/VM overhead, filesystem cache behavior, or remaining VM `MemAvailable`.

At 15:39:27 +07, Docker events show the then-running MemoryOS, Dev Hub and other project containers exiting with status 255; `docker ps` showed only `mysql-local` still running immediately after that transition. This coincided with the settings mtime change and Docker Engine reporting a larger memory total. The timing is consistent with an external Docker state transition, but the cause/actor is unknown. The MemoryOS queue and AI worker then entered restart loops (restart count 11, exit 1). At 15:41:28, `docker stats` reported only `mysql-local` at 558.3 MiB; restart-loop containers were not contributing a stable workload. A later event query also showed a short-lived `agent-corporation.fix081.probe` container created and removed by another process. These are observed external Docker state changes; this task did not initiate them. Current per-container usage is therefore unstable and cannot establish a safe headroom number.

Disk is not the immediate blocker: Docker reports 18.11 GB of images, 12.92 GB of local volumes, and 3.218 GB build cache. No prune was run. Current image inventory confirms the reusable Gate 1 Web image (~630 MB), API image (~586 MB), Playwright runner image (`noteos-phase00-gate1-playwright`, ~2.5 GB), MySQL 8.4.7 (~788 MB), MongoDB 8.0.16 (~901 MB), and PowerSync 1.20.0 (~481 MB) are present. These are disk sizes, not RAM usage. Existing Gate 1 containers are still listed in Compose as stopped or `Created`, so the exact existing profile could reuse their container definitions/images. However, the current Web container depends on PowerSync and is unsuitable for a lean Watermelon-only run; Compose may recreate containers after a profile refactor while preserving the named volumes.

The isolated volumes `noteos-phase00_noteos_gate1_mysql` and `noteos-phase00_noteos_gate1_mongo` both still exist. MySQL logs show initialization completed once before the OOM; current schema/data integrity cannot be verified while the DB is stopped. Volume reuse is possible in principle, but **not yet validated as healthy**. Preserve both volumes; do not reset them.

### Compose profile behavior

The current `gate1` profile contains MySQL, API, MongoDB, PowerSync, Web, and Playwright together. `gate1-web` unconditionally depends on `gate1-powersync`, so the current definition cannot start a Watermelon-only service set. Enabling a Compose profile also makes unprofiled default services eligible; `docker compose --profile gate1 config --services` lists the baseline stack as well. To keep the candidate run lean, future commands must target only the intended Gate 1 services, and the Web dependency/profile coupling must be revised first. No such change was applied here.

## 3. Proposed lean, sequential environments

`docker-compose.gate1.yml` now defines mutually exclusive `gate1-watermelon` and `gate1-powersync` profiles with candidate-specific MySQL/API/Web services. Watermelon MySQL omits binlog/GTID and uses a new named volume that will only be created when a later run starts it. PowerSync MySQL retains row binlog/GTID and references the existing preserved MySQL volume; MongoDB and PowerSync Service are PowerSync-only and reference the existing preserved Mongo volume. API/Web aliases keep the existing harness URLs stable. The file contains no baseline services and publishes no host ports. Each profile has its own optional Playwright runner definition with a candidate-specific `--grep` filter; neither runner is a prerequisite for service health checks.

| Candidate | Minimum services | Services deliberately omitted |
| --- | --- | --- |
| WatermelonDB | Candidate-isolated MySQL without PowerSync binlog/GTID requirements → Laravel API → Next.js Web; Playwright runner only while executing browser cases | MongoDB, PowerSync Service, worker, Redis, baseline noteOS services |
| PowerSync | Candidate-isolated MySQL with row binlog/GTID → Laravel API; MongoDB replica set + PowerSync Service; Next.js Web; Playwright runner only while executing browser cases | Worker, Redis, baseline noteOS services |

Static service listings were validated: Watermelon includes only `gate1-watermelon-mysql`, `gate1-watermelon-api`, `gate1-watermelon-web`, and optional `gate1-watermelon-playwright`; PowerSync includes only `gate1-powersync-mysql`, `gate1-powersync-api`, `gate1-mongo`, `gate1-powersync`, `gate1-powersync-web`, and optional `gate1-powersync-playwright`. Each runner filters to its candidate. The two profiles share internal DNS aliases and must not be active together. Explicit service-targeted commands will keep unprofiled services out of the run. Existing images are available and can be reused without builds. The existing PowerSync MySQL/Mongo volumes remain unverified; the Watermelon volume does not yet exist. No volume was created or changed in this turn.

## 4. Resource budget and risk

Historical measurements from a prior noteOS sync run, not a Gate 1 peak test: MySQL 299 MiB, API 68 MiB, Web 56 MiB, PowerSync 204 MiB, MongoDB 174 MiB, Redis 6.8 MiB. These snapshots suggest about 423 MiB for the three shared application services and about 801 MiB when PowerSync and MongoDB are included. They exclude Playwright/Chromium, worker peaks, VM overhead, database initialization, Next build peaks, and measured Gate 1 peak RSS. Treat these only as **steady-state planning inputs**, not safe memory requirements.

| Profile | Measured service input | Unmeasured workload | Planning envelope (not measured/validated) | Risk |
| --- | --- | --- | --- | --- |
| WatermelonDB | ~423 MiB from prior MySQL/API/Web snapshots | Playwright + Chromium, Next runtime peaks, MySQL recovery/fixture initialization, Docker VM overhead | Budget at least **2–3 GiB** for an isolated run, plus verified free VM headroom; do not impose per-container caps from this estimate. | Moderate/high until browser peak and VM headroom are measured. |
| PowerSync | ~801 MiB from prior MySQL/API/Web/PowerSync/Mongo snapshots | Same as above, plus Mongo replica initialization and PowerSync catch-up/indexing peaks | Budget at least **3–4 GiB** for an isolated run, plus verified free VM headroom; do not impose per-container caps from this estimate. | High until VM `MemAvailable` and isolated-run peak are demonstrated, even with the current 7.765 GiB engine limit. |

These planning envelopes are deliberately labeled estimates. The earlier inventory showed about 2.2 GiB in other active containers before Docker VM overhead; the current Docker daemon capacity and active inventory changed during the task. Neither the initial 5 GiB state nor the later 7.765 GiB state establishes that a candidate has safe headroom, and the prior OOM outcomes are counter-evidence to assuming it does. No recommendation to change Desktop memory/swap is made from this evidence alone.

## 5. Static initial-pull diagnosis

### PowerSync path

| Layer | Source evidence | Classification |
| --- | --- | --- |
| MySQL fixtures | Playwright fixture has 20 stable UUIDs and a `phase00-gate1-v1` dataset. `beforeAll` posts all 20 `PRIVATE_SERVER` rows when API state count is below 20. The Laravel create path inserts notes and change-log entries. | **Source path matches.** The seeder's count-only guard is a harness weakness: it does not assert every expected fixture ID/content when count is already 20. This does not explain the previously reported exact 20-row server state. |
| Sync rules | Stream selects `notes` fields from the matching dataset and `PRIVATE_SERVER` privacy. DB table is `notes`; migration includes the selected fields, including `deleted`, `dataset_id`, `revision`, and `updated_at`. | **No static table/filter mismatch found.** |
| Client token | Browser fetches `/api/gate1/powersync-credentials`; Next rewrites `/api/*` to Gate 1 API. Laravel emits `aud=powersync`, `kid=noteos-phase00`, 1-hour expiry, and the endpoint `http://localhost:8080`. Service config has matching audience/key ID/key; Playwright proxy listens on localhost:8080 and forwards to `gate1-powersync`. | **No static endpoint/audience/key-ID mismatch found.** Token signature validity and browser delivery remain unverified at runtime. |
| SDK schema | PowerSync Web SDK schema declares local table `notes` and matching selected columns. The UI connects to the credential endpoint and queries `notes WHERE dataset_id = ?` with the same dataset constant. | **No static table/field/dataset mismatch found.** |
| Local query and assertion | `getDb()` memoizes one `PowerSyncDatabase`; `refresh()` queries that instance; listener refreshes on local changes. The test waits for row-count 20 after navigation/reload. | **No definite static defect found.** Whether `connect()` receives credentials/stream data, SDK applies rows, or the query sees the materialized store remains **UNKNOWN** without runtime logs/local-store evidence. Checkpoint 40 alone does not prove rows were materialized. |
| Browser origin | Playwright loads `http://localhost:3000`; proxy targets Next. PowerSync credentials return `http://localhost:8080`; the proxy forwards to the PowerSync service. | **Static secure-origin correction is internally consistent.** The earlier insecure-origin error was addressed in code; CORS/stream runtime behavior is not established here. |

**PowerSync result:** no verified source defect explains 0/20. Runtime cause remains **UNKNOWN**. Minimum useful diagnostics on a future approved run: capture credential response status/endpoint (never token), stream connection/error callbacks, SDK status, local SQLite table list/count, raw local `notes` sample, and the matching UI query result.

PowerSync findings by requested category:

- **VERIFIED:** fixture IDs/dataset match the API seeder, sync-rule dataset/privacy filter, SDK `notes` schema, and UI query. Stream is `auto_subscribe: true`; service audience/key ID match the generated JWT metadata; Web and PowerSync URLs use the test runner's localhost proxy. `getDb()` and `refresh()` use the same singleton database; the test waits for 20 rows rather than treating the server checkpoint as row evidence.
- **SUSPECTED:** UI status changes to `connected` once `db.connect()` resolves, which does not itself prove initial sync completion. This is weak progress instrumentation, not a confirmed cause; the row assertion waits up to 30 seconds and the earlier server log reported checkpoint 40.
- **UNKNOWN:** whether credentials were accepted by the browser client, the server subscription delivered these specific 20 rows, the SDK applied them to its browser database, and the exact SQL query returned zero or rows that the UI filtered. No source-only finding identifies which stage caused the prior 0/20 result.

### WatermelonDB path

| Layer | Source evidence | Classification |
| --- | --- | --- |
| Laravel pull | `GET /api/sync` resolves through the Next rewrite to Laravel `GET /sync`. It takes `dataset_id` and `last_pulled_at`, snapshots `sync_clock.revision`, filters `sync_changes` by revision and joins/filter notes by the same dataset. | **No static route/dataset/cursor mismatch found.** |
| Response contract | Laravel returns `{ timestamp, changes: { notes: { created, updated, deleted } } }`; Watermelon `pullChanges` returns `response.json()` unchanged. `lastPulledAt ?? 0` maps the first pull to revision 0; the server returns the global integer revision. | **Shape and cursor are aligned by source.** Runtime HTTP body/status not captured in the saved failure context. |
| Required collection fields | Watermelon `notes` schema declares non-optional `title`, `body`, `privacy`, `dataset_id`, `revision`, and boolean `deleted`. The original 00-R create/update payloads omitted `deleted`; 00-R.1 now adds `deleted: false` to both. | **VERIFIED CODE DEFECT — FIXED in 00-R.1.** Whether the omission caused the prior 0/20 still requires runtime evidence. |
| Other mapping | Model `field('dataset_id')` maps `datasetId` to the same snake-case server column; collection/table are both named `notes`; server sends `revision` and body as strings as declared. | **No other static table/field mismatch found.** |
| Lifecycle/query | One module-level `Database` uses LokiJS; `synchronize(db)` is awaited, then the same `db` is queried with `refresh()`. The assertion counts rows in that collection filtered by the same dataset. | **No static instance-lifecycle or missing-await defect found.** A thrown sync error is rendered in status, but the saved Playwright error context captured only the row-count assertion. |
| Auth/origin | Sync pull endpoint has no auth middleware in this Gate 1 route; same-origin `/api/sync` is rewritten by Next. This is an isolated synthetic harness, not an authenticated product boundary. | **No source auth blocker for this test.** Security is not validated by this harness. |

**Watermelon result:** the verified response/schema defect is fixed by the 00-R.1 change. The browser's 0/20 result is still **not attributed** to it without a logged sync exception, pull response, and local collection count.

## 00-R.1a — response contract recheck

The Laravel GET `/sync` endpoint emits the full contract shape before and after 00-R.1a:

```json
{"changes":{"notes":{"created":[],"updated":[],"deleted":[]}},"timestamp":0}
```

`created` and `updated` contain raw note records; `deleted` contains record ID strings. The endpoint already constructed all three collection arrays with `compact('created', 'updated', 'deleted')`, and for a deletion it appended `note_id` to the collection-level array. Therefore 00-R.1a made **no endpoint or cursor change**. 00-R.1 added the per-record `deleted: false` field to created/updated entries. This is a declared Watermelon schema column (`boolean`) and an app-level soft-delete state used by the Web UI to hide deleted rows; it is distinct from Watermelon’s collection-level `deleted: [id, ...]` tombstones, which remove records from the synchronized local collection.

The four contract tests now preserve JSON array/object distinctions during decoding and assert: 20 created records and empty updated/deleted arrays; all three empty arrays for zero fixtures; incremental updated record with empty deleted array; and deletion ID only in `deleted`, with no active created/updated record. They also verify exact raw field names, `notes` collection name, record IDs, dataset/privacy/type mapping and nonnegative integer revision timestamp. The timestamp remains the existing global revision snapshot; no cursor algorithm was changed.

Static PHP syntax checks and `git diff --check` pass. Laravel Feature tests are **NOT RUN** because PHP 8.4 and Composer dependencies are unavailable in the host runtime; no container was started. Docker capacity remains **CAPACITY_UNVERIFIED**, Gate 1 remains **BLOCKED**, and the earlier browser 0/20 remains **FAIL pending a browser retest**.

## 6. Implemented fixes and remaining proposals

1. **Applied — Watermelon response contract:** created/updated payloads include `deleted: false`; tombstone IDs remain in the `deleted` array. No revision or cursor logic changed.
2. **Added — feature contract tests:** four scenarios are present in `api/tests/Feature/SyncPullContractTest.php`. PHP syntax lint passed. The host test command was attempted but aborted before PHPUnit boot because `api/vendor/autoload.php` is absent (exit 255); host PHP is 7.4.33, below Laravel 12's PHP 8.2 requirement. **Laravel tests NOT RUN**; no install was attempted.
3. **Applied — Compose isolation:** `docker-compose.gate1.yml` splits Watermelon and PowerSync service graphs; root Compose no longer contains the coupled Gate 1 services. Both profiles pass static Compose parsing and list only their candidate services plus the optional runner.
4. **Still proposed — fixture guard:** compare the exact fixture ID/content/revision set instead of only row count before seeding. This was not needed to correct the response contract and remains unmodified.
5. **Still proposed — runtime diagnostics:** capture sanitized pull status/body shape, PowerSync stream callbacks/local DB rows, Watermelon sync rejection/local collection count, and resource samples through initialization, browser launch, catch-up and shutdown. Never log JWTs.

No container, image, Docker setting, registry, external project, or volume was changed. Both existing Gate 1 volumes remain preserved; the new Watermelon volume is only declared in Compose and has not been created.

## 7. Capacity gate checklist for a future run

| Gate input | Required evidence | Current result |
| --- | --- | --- |
| Docker VM RAM/swap | Read current Desktop setting and confirm it matches live Engine `MemTotal`; record any external change/restart | **CAPACITY_UNVERIFIED** — last observed settings 8,192 MiB RAM / 1,024 MiB swap; source changed during prior inspection. |
| Available memory | Reliable VM `MemAvailable` sample near the run, not macOS free memory alone | **CAPACITY_UNVERIFIED** — not exposed by the captured Docker API. |
| Running containers | Enumerate owner/service and current usage; sample through the full run, including restart-loop state | **CAPACITY_UNVERIFIED** — earlier inventory changed while inspected; usage is not stable. |
| MySQL health/recovery | Both candidate DBs pass healthcheck and reach ready state before seeding | **BLOCKED** — preserved PowerSync MySQL volume's integrity is unverified; Watermelon DB/volume not created. |
| Recent OOM | Check Docker events and kernel/cgroup `memory.events` around the proposed run; no new OOM counter increment | **BLOCKED** — prior OOM kills confirmed; exact source unresolved and no fresh run evidence. |
| Profile footprint | Compare per-service measurements to the planning estimates below; no arbitrary memory caps | **ESTIMATE ONLY** — Watermelon 2–3 GiB; PowerSync 3–4 GiB including browser/VM overhead allowances, not validated. |
| Margin | Demonstrate peak profile use plus explicit reserve fits live VM capacity while accounting for active workloads | **CAPACITY_UNVERIFIED** — no reliable live headroom/peak measurement. |
| Test volume integrity | Preserve existing volumes; after approved DB recovery, verify schema and expected synthetic dataset without reset | **BLOCKED** — volume objects exist, but DB checks cannot run while stopped. |

**Overall capacity verdict: CAPACITY_UNVERIFIED; Gate 1 stays BLOCKED.** Do not treat 8 GiB configured memory as a PASS. Do not apply arbitrary container caps to force a run.

## 8. Smallest next execution and approvals

After a separate capacity/recovery gate passes, run only the Watermelon profile first, using the existing API/Web/test-runner images and the Watermelon-only MySQL volume. Seed/verify exactly 20 synthetic records, then collect pull response, sync result, local collection count and browser assertion. If the Watermelon profile succeeds, stop it cleanly while preserving its volume; separately run the PowerSync profile and capture token metadata without token value, stream/subscription status, local table rows and query count. Do not run profiles concurrently. No browser retest is part of this recovery task.

Still requires a later decision/authorization: whether to change Docker Desktop capacity or schedule tests with other workloads quiescent; whether to create/populate the declared Watermelon volume by starting its profile; and whether to proceed with the Web retests after all checklist items pass. The contract fix, contract tests and static profile refactor were explicitly authorized and are already applied. Gate 2, Phase 01 and engine selection remain out of scope.

## Reproduction of read-only evidence

Run from the repository root; these commands inspect existing state and do not start services:

```sh
docker info
docker compose ps --all
docker stats --no-stream
docker inspect <container>
docker events --since 24h --until 0s --filter type=container --filter label=com.docker.compose.project=noteos-phase00 --filter event=oom
docker volume inspect noteos-phase00_noteos_gate1_mysql noteos-phase00_noteos_gate1_mongo
```

Host-side capacity evidence was read from Docker Desktop `settings.json`, `vm_stat`, `sysctl vm.swapusage`, and `memory_pressure`. No local development service was started to obtain it.
