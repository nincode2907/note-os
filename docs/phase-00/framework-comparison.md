# Phase 00-C — Gate 1 framework comparison

**Run date:** 2026-10-20  
**Decision state:** Gate 1 is incomplete and recovery is **BLOCKED**; Sync Engine remains **UNDECIDED**.  
**Scope:** Web target runtime was built and exercised in Chromium/WebKit. Native iPhone validation is blocked because this host has Command Line Tools only, with no Xcode or `simctl`. No Gate 2 or Phase 01 work was started.

## Recovery 00-R.1 — contract fix and lean preparation

00-R.1a rechecked the Laravel pull, Web adapter, schema, and tests. The endpoint already returned `changes.notes` with JSON arrays `created`, `updated`, and `deleted`; `deleted` holds record IDs. No endpoint or cursor change was needed. Per-record `deleted: false` remains valid because the Watermelon `notes` schema declares a boolean `deleted` column; it represents the app's soft-delete state and differs from collection-level tombstones. Four tests now assert JSON array types, exact field mapping, IDs, collection name, cursor timestamp, and tombstone placement. PHP syntax checks pass. **Laravel tests are NOT RUN:** PHP 8.4 and Composer dependencies are unavailable; host PHP 7.4.33 is not used to claim a Laravel 12 pass. No package or container was started.

Gate 1 Compose services were moved to [`docker-compose.gate1.yml`](../../docker-compose.gate1.yml) and split into `gate1-watermelon` and `gate1-powersync`. Static Compose config passed for each profile. Watermelon omits MongoDB/PowerSync; PowerSync alone includes them. Each profile's optional runner filters to its own candidate. The profiles are sequential and must not be enabled together. No service, browser test, or image build was run. **Capacity remains CAPACITY_UNVERIFIED** and G1-02 remains FAIL from the prior browser attempt; this contract fix does not turn it into PASS.

Static PowerSync review found matching fixture dataset, sync-rule filter, SDK schema/table/query, token audience/key ID metadata, localhost proxy endpoints, and singleton database lifecycle (**VERIFIED source alignment**). The UI's `connected` label after `db.connect()` is only weak progress instrumentation (**SUSPECTED**, not a root cause). Actual credential acceptance, stream delivery, local materialization, and the 0/20 stage remain **UNKNOWN**. No PowerSync code was changed.

## Status matrix

`PASS` means the stated criterion completed on its target runtime. `FAIL` means the attempt ran but did not meet its assertion. `BLOCKED` means the target could not be exercised. `NOT TESTED` means no valid attempt was completed.

| Criterion | PowerSync Open Edition | WatermelonDB |
| --- | --- | --- |
| G1-01 Expo native build and persistent local write | **BLOCKED** — no Xcode/`simctl`; source smoke harness and pinned candidate versions only | **BLOCKED** — no Xcode/`simctl`; SQLite native adapter not built or run |
| G1-02 Next.js production browser, initial sync and offline reload | **FAIL** — Next production build passed and Chromium/WebKit connected to the PowerSync stream, but the local query remained at 0 of 20 fixture rows. Offline persistence assertions were not reached. | **FAIL** — Next production build passed and Chromium loaded the real LokiJS adapter, but the local query remained at 0 of 20 fixture rows. Offline persistence assertions were not reached. |
| G1-03 iPhone ↔ Web round trip with canonical JSON, identity and revision | **BLOCKED** — no iPhone client result; Web initial pull failed | **BLOCKED** — no iPhone client result; Web initial pull failed |
| G1-04 `DEVICE_ONLY` non-upload and `PRIVATE_SERVER` upload | **NOT TESTED** — official `localOnly: true` table is declared in the Web schema, but no end-to-end assertion ran | **NOT TESTED** — adapter filter is present, but no end-to-end upload assertion ran |
| G1-05 offline Vietnamese/English/Japanese search and index persistence | **NOT TESTED** — basic accent-normalizing search is implemented but no browser assertions ran | **NOT TESTED** — same test UI search is implemented but no browser assertions ran |

The Web failure is an observed failure of this Gate 1 harness execution, not evidence that either library is structurally unable to sync. The server-side PowerSync log showed the browser opening `/sync/stream` and receiving checkpoint `40`; the PowerSync local query still returned no rows. The WatermelonDB page likewise showed zero rows after `synchronize()`. The traces are retained in [`artifacts/phase-00/gate1/test-output/`](../../artifacts/phase-00/gate1/test-output/). Diagnose the initial-pull adapter contract before using these failures to rank frameworks.

## Target-runtime evidence

| Evidence | Result |
| --- | --- |
| Next.js production image | **PASS** — Next.js `16.4.2`, React/React DOM `19.3.1`; `next build` compiled, type-checked, and generated `/`, `/powersync`, `/watermelon`. Build output was observed from BuildKit. |
| Browser runner | **PARTIAL** — Playwright `1.64.1`; actual Chromium and WebKit engines launched in the `mcr.microsoft.com/playwright:1.64.1-noble` container. Chromium ran both candidates; WebKit ran the PowerSync initial-pull case. The final Watermelon/WebKit case did not run after Gate 1 services were stopped. |
| Browser origin / platform | Chromium `156` (PowerSync user-agent recorded by service), WebKit from the same Playwright `1.64.1-noble` image; Linux container. Browser UI was served by the Next production server through the test container's localhost reverse proxy. |
| Production browser storage | **NOT VERIFIED** — browser test stopped at initial fixture count, before IndexedDB/OPFS checks. |
| Fixture seed | **PASS** — isolated Gate 1 Laravel/MySQL held exactly 20 fixture UUIDs under dataset `phase00-gate1-v1`; API state returned canonical JSON and revisions 1–20. |
| PowerSync replication | **PARTIAL** — Service `1.20.0` loaded edition 3 stream rules against isolated MySQL; server log recorded 40 source changes (insert plus revision update for each fixture), then a Web SDK stream connection and checkpoint `40`. Local table materialization was not observed by the client query. |
| Native tooling | **BLOCKED** — `xcodebuild` reports active developer directory is Command Line Tools; `xcrun simctl` is unavailable. No simulator, signing, or real iPhone result is claimed. |
| Resource / latency | **NOT MEASURED** — no valid comparable run; p50/p95, CPU and memory are N/A. |

### Browser errors and reproduction evidence

The first browser attempt used the Docker service hostname and PowerSync Web SDK reported `Navigator locks are not available in an insecure context`. The harness was corrected to use a localhost proxy in the Playwright container, which is a secure browser context without publishing any host port. In the corrected attempt, the expected 20 fixture rows still did not appear. Playwright then failed the row-count assertion (`expected 20, received 0`) for PowerSync Chromium, Watermelon Chromium and PowerSync WebKit. The trace files and error-context files are preserved beside their screenshots. Offline reload, search, and privacy upload assertions were therefore not executed.

The Gate 1 MongoDB healthcheck later timed out under Docker host resource pressure. Container status also showed the existing noteOS MySQL exit `137`; after Gate 1 services were stopped, only `noteos-phase00-mysql-1` was started for recovery. No existing volume was removed. The Playwright run was stopped and the Gate 1 web/API/PowerSync/MySQL/Mongo containers were stopped. Other projects were not intentionally changed. Verify Docker health before retrying.

### Controlled recovery and RCA — 2026-10-20

**Recovery gate: BLOCKED. No new workload was started.** Read-only Docker checks after the attempted noteOS MySQL recovery found that both the existing noteOS MySQL and isolated Gate 1 MySQL were stopped with exit code `137` and `OOMKilled=true`. The existing MySQL restart began InnoDB initialization but did not reach “ready for connections” before it exited. Its Docker health is `unhealthy`. The existing noteOS API, Web and Mongo containers are also stopped/unhealthy; the PowerSync and Redis containers are stopped. All Gate 1 services are stopped. The two isolated named volumes (`noteos-phase00_noteos_gate1_mysql` and `noteos-phase00_noteos_gate1_mongo`) still exist.

Docker Desktop reports 4 CPUs and 4.818 GiB total memory. At the read-only snapshot, 8 containers belonging to other local workloads were running; `docker stats --no-stream` showed MemoryOS Web at 1.062 GiB, MemoryOS MySQL at 396.3 MiB and `mysql-local` at 543.4 MiB. This snapshot is not peak memory, but in combination with the confirmed MySQL OOM kills and unhealthy noteOS baseline it is not a safe basis for another build or browser workload. Docker storage reports 18.11 GB images and 3.218 GB build cache; no prune was run. Filtered Docker OOM events were unavailable in the retained event window, so there is no daemon event timestamp beyond container state/log evidence.

| RCA item | Evidence | Classification |
| --- | --- | --- |
| Host resource failure | noteOS baseline MySQL and Gate 1 MySQL: exit `137`, `OOMKilled=true`; Docker host total memory 4.818 GiB; multiple unrelated projects remained active | **Confirmed OOM kill** for both MySQL containers. The exact process that triggered host-wide pressure and peak usage are unknown. |
| Other noteOS service exits | API/Web/Mongo stopped with exit `137` but `OOMKilled=false`; PowerSync exited `0` or `1` depending on container | **Unknown / likely coordinated stop or service failure**; exit code alone does not identify the actor or root cause. Do not label these as OOM. |
| PowerSync initial pull | Saved test result is 0/20 rows; prior server log has 40 source changes, a Web stream start and checkpoint 40. No client-side local row count/query evidence or complete DB-to-stream-to-table tracing was captured. | **BLOCKED / RCA unknown.** A checkpoint does not prove fixture materialization. |
| WatermelonDB initial pull | Saved test result is 0/20 rows after `synchronize()`; no captured request/response body, thrown sync error, local collection inspection or server pull comparison. | **BLOCKED / RCA unknown.** Cannot attribute the failure to Laravel response shape, Watermelon schema or local adapter. |
| Browser harness | Both Chromium tests timed out waiting for row-count 20; WebKit PowerSync did the same. WebKit Watermelon was not run. Offline/privacy/search assertions were after the failing count and therefore did not execute. | **FAIL — attempted initial-pull assertion**; harness root cause remains unisolated. |

`artifacts/phase-00/gate1/gate1-run.log` and the Playwright `error-context.md`, screenshots and traces preserve the failed attempts. These artifacts establish the observed 0/20 result, not the missing per-layer diagnostics. Since the noteOS database is unhealthy and Docker resource pressure is evidenced, no container, build, browser, fixture or retry workload was started in this recovery pass.

### Current recovery status

| Check | Status |
| --- | --- |
| noteOS MySQL recovery / health | **BLOCKED** — stopped, exit 137, `OOMKilled=true`, health `unhealthy`; logs end during InnoDB initialization. |
| Docker capacity for another test | **BLOCKED** — 4.818 GiB total; OOM-killed MySQL containers and active unrelated workloads make capacity unsafe to assume. |
| Gate 1 volumes | **PRESERVED** — both isolated named volumes exist; no volume removal or prune. |
| Gate 1 Web retest | **NOT RUN** — stopped at the recovery gate. |
| Sync engine | **UNDECIDED** — no candidate ranking or selection. |

## Versions and compatibility

| Candidate | Pinned direct versions | License note |
| --- | --- | --- |
| Web | Next.js `16.4.2`; React/React DOM `19.3.1`; `@powersync/web` `2.5.0`; WatermelonDB `0.28.0`; Playwright `1.64.1`; Node image `22.21.1` | PowerSync SDK package uses Apache-2.0; WatermelonDB MIT; verify full transitive tree before distribution. |
| Expo iOS candidate | Expo SDK `57.0.30`; React Native `0.86.0`; React `19.2.3`; `@powersync/react-native` `2.3.3`; `@op-engineering/op-sqlite` `18.2.5`; WatermelonDB `0.28.0`; `@morrowdigital/watermelondb-expo-plugin` `2.3.3` | Expo/RN and adapter licenses are not a legal review. Native package install/prebuild was not completed; `mobile/package.json` pins direct candidates, but no transitive `package-lock.json` is available. |
| PowerSync server | PowerSync Service `1.20.0`; MongoDB `8.0.16`; MySQL `8.4.7`; Laravel runtime `12.70.0` / PHP `8.4.26` | PowerSync Open Edition server is FSL-1.1-ALv2; its Competing Use restriction remains a separate architecture/legal review item. MongoDB Community is SSPLv1; MySQL Community GPLv2. |

The Web dependency lock is [`spikes/phase-00/gate1/web/package-lock.json`](../../spikes/phase-00/gate1/web/package-lock.json); test-runner lock is [`spikes/phase-00/gate1/package-lock.json`](../../spikes/phase-00/gate1/package-lock.json). The mobile manifest is direct-version-pinned but not transitively locked or built.

The Web dependency install reported **2 moderate npm audit findings**; they were not auto-fixed during this validation. Review the lockfile advisories before using the harness beyond the isolated synthetic environment.

Expo SDK 57 is the approved candidate baseline. Expo's SDK 57 compatibility matrix lists React Native `0.86`, React `19.2.3`, and Node `22.13+`. SDK 58 is current as of this run, but WatermelonDB `0.28.0` has an upstream report dated 2026-10-19 that it does not build with React Native `0.88.0`; no downgrade or fork was tried. SDK 58 should remain unvalidated until the upstream compatibility issue is resolved or a supported release is available. Sources: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/), [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/), [WatermelonDB issue #1969](https://github.com/Nozbe/WatermelonDB/issues/1969), [WatermelonDB 0.28 changelog](https://github.com/Nozbe/WatermelonDB/blob/master/CHANGELOG.md).

PowerSync Web used package `@powersync/web 2.5.0`; it is not the earlier experimental Node SDK benchmark. PowerSync React Native package is `2.3.3` and declares OP-SQLite peer support `>=17.1.0 <19.0.0`; the candidate `18.2.5` is in that range. This is package metadata compatibility only, not a native build result. PowerSync SDK v2 changed Web worker packaging and its React Native SQLite integration; see [SDK v2 announcement](https://releases.powersync.com/announcements/v2-0-of-powersync-javascript-sdks). WatermelonDB Web uses LokiJS in a browser, whose browser persistence is IndexedDB; its native adapter is SQLite. Neither native adapter has been exercised on this host. See [WatermelonDB database adapters](https://watermelondb.dev/docs/Implementation/DatabaseAdapters).

## Runtime implementation and topology

The new Gate 1 Compose file has two candidate profiles and publishes no host ports. Watermelon uses an isolated MySQL service and a newly declared volume (not created); PowerSync references the preserved existing Gate 1 MySQL/Mongo volumes. API state/credential routes remain gated by `NOTEOS_GATE1_ENABLED`; the Dev Hub block and `15700–15799` mapping were not edited. Web API calls are proxied through Next. The test browser uses a localhost reverse proxy inside its own container to satisfy secure-context requirements; this does not add host port mappings.

| Candidate | Topology for this attempt | App-owned adapter responsibilities |
| --- | --- | --- |
| PowerSync | Next Web + `@powersync/web`; Laravel/MySQL; PowerSync Service + MongoDB | Fetch short-lived test JWT; upload PowerSync CRUD entries to Laravel delta endpoint; enforce PRIVATE_SERVER writes; model `DEVICE_ONLY` in a PowerSync `localOnly: true` table. The official local-only API is present in the Web schema but not yet verified end to end. |
| WatermelonDB | Next Web + WatermelonDB LokiJS/IndexedDB; Laravel/MySQL; no extra sync server | Implement Watermelon pull/push HTTP contract; exclude DEVICE_ONLY from pushes; map canonical JSON and revision fields. R.1 adds the required `deleted` field to pulled created/updated rows. Native would use Watermelon SQLite adapter, not LokiJS. |

Custom Sync was not expanded. Test-only additions to Laravel are gated; existing protocol endpoints were reused. No iPhone-to-Web round trip or final engine recommendation can be made from this evidence.

## Next action for architecture review

Do **not** select an engine from this run. First pass the capacity gate and execute the new contract tests under a compatible PHP/Laravel runtime; then run one lean Web profile at a time and verify the full 20-row pull, local materialization and offline persistence. Native SDK 57 work remains separate and requires supported Xcode/iPhone access; SDK 58 remains compatibility-blocked for WatermelonDB `0.28.0`. Privacy/search/round trip remain unverified. Gate 2 remains unopened.

## Reproduction

Static configuration validation (already run; does not start services):

```sh
docker compose -f docker-compose.gate1.yml --profile gate1-watermelon config --quiet
docker compose -f docker-compose.gate1.yml --profile gate1-watermelon config --services
docker compose -f docker-compose.gate1.yml --profile gate1-powersync config --quiet
docker compose -f docker-compose.gate1.yml --profile gate1-powersync config --services
```

After a future capacity approval, start only one profile's listed services and run the Playwright runner after health checks. Do not run both profiles together or use `down -v`; all Gate 1 volumes must be preserved.

## Recovery 00-R.2 — controlled runtime gate (2026-10-20)

**Gate A BLOCKED (`CAPACITY_UNVERIFIED`); HARD STOP.** Read-only evidence: Docker VM reports 7.6 GiB RAM / 5.7 GiB available and 2 GiB free swap, while Windows reports only ~465 MiB free physical RAM. Six noteOS containers are already running without per-container memory limits, including PowerSync and MongoDB. The Watermelon browser budget remains an unmeasured 2–3 GiB estimate, so safe host headroom is not established. No workload was started. Laravel contract tests are **NOT RUN** and Watermelon initial pull is **NOT RUN** (no 0/20 result for this attempt). Current noteOS MySQL is healthy after XA crash recovery; candidate test-volume readiness is unverified. No project source or Docker state changed. Full evidence: [recovery-00-r.md](recovery-00-r.md#recovery-00-r2--controlled-capacity-gate-2026-10-20).

## Recovery 00-R.3 — workload reduction and conditional tests (2026-10-20)

PowerSync and MongoDB were graceful-stopped after Compose ownership verification. Windows had ~1.68 GiB available immediately before the stop and fluctuated between 1.28–1.80 GiB afterward; a sustained increase from the stop was not established. Docker VM showed 5.9 GiB available with swap unused and zero memory PSI pressure. This supports a light test workload in principle, but not the estimated 2–3 GiB Chromium envelope. The existing PHP 8.4.26/Laravel 12.70.0 container lacks `vendor/bin/phpunit`, so all four Laravel contract tests are **NOT RUN** and no dependencies were installed. Watermelon browser test was consequently **NOT RUN**. Retained services and full evidence: [recovery-00-r.md](recovery-00-r.md#recovery-00-r3--controlled-workload-reduction-2026-10-20).
