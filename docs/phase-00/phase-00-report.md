# noteOS Phase 00 — report for architecture review

## Latest status — 00-C Gate 1 (2026-10-20)

**Gate 1 INCOMPLETE; Sync Engine UNDECIDED.** Next.js production build passed. Browser runtime started in Chromium and WebKit, but initial fixture pull failed for both Web candidates: the test expected 20 notes and read 0. Offline reload, `DEVICE_ONLY`, multilingual search and round-trip checks were not reached. G1-01 iOS native and G1-03 iPhone/Web round trip are **BLOCKED** because this host lacks Xcode/`simctl` and no iPhone was tested. G1-04/G1-05 are **NOT TESTED**. No Gate 2 or Phase 01 work was performed.

The Gate 1 profile used separate MySQL/MongoDB volumes and published no host ports. Controlled read-only recovery checks confirmed that both the existing noteOS MySQL and isolated Gate 1 MySQL exited `137` with `OOMKilled=true`. noteOS MySQL remained stopped/unhealthy in the captured recovery evidence; its startup did not reach readiness. Docker Desktop and Engine readings changed from 5,120 MiB / 4.818 GiB to 8,192 MiB / 7.765 GiB during the earlier inspection, while other local workloads exited. The current available VM memory and safe headroom remain unverified, so no further build or browser workload was started. Both Gate 1 named volumes remain intact. No other project was operated. The initial-pull RCA is unknown for both candidates: saved errors prove only that the browser observed 0/20 rows, while stream checkpoint evidence does not prove local materialization. See [framework-comparison.md](framework-comparison.md#controlled-recovery-and-rca--2026-10-20) for the Docker snapshot, evidence classifications and current stop state. Treat the browser failures as harness failures to diagnose, not framework rejections.

## Recovery 00-R — capacity and static diagnosis (2026-10-20)

**Status: COMPLETE for read-only analysis; Gate 1 remains BLOCKED.** Both MySQL containers were OOM-killed without explicit per-container memory limits, so VM/global memory pressure is likely, but exact cgroup/VM OOM scope is unknown because counters are unavailable for the stopped containers. Capacity changed during inspection: the first settings/engine read was 5,120 MiB / 4.818 GiB; later the settings file showed 8,192 MiB and the live engine 7.765 GiB. At the same time, previously running project containers exited and Docker stats became unstable. No Docker setting or container change was made by 00-R; cause/actor of the external state transition is unknown. The earlier inventory showed about 2.2 GiB across eight containers; it is not a current headroom measure. macOS reported 39% free memory and 12.45 GiB swap used. The current Compose profile couples Watermelon Web to PowerSync; candidate-separated profiles are proposed, not applied. Static source found a Watermelon pull payload omission (`deleted` missing from a required schema field); whether it caused 0/20 is not yet known. Both Gate 1 volumes remain untouched. Full evidence, inventory, budgets, proposed patches and approval gates: [recovery-00-r.md](recovery-00-r.md).

## Recovery 00-R.1 — contract fix and lean preparation (2026-10-20)

**Status: Code/config changes complete; runtime verification NOT RUN; Gate 1 remains BLOCKED and CAPACITY_UNVERIFIED.** Laravel created/updated sync records now include the required `deleted: false` field; revision/cursor logic is unchanged. Four contract feature tests were added for 20-row initial pull, empty initial pull, incremental update, and tombstones. PHP syntax lint passed; the Artisan command exited 255 before tests booted because `api/vendor/autoload.php` is missing (host PHP 7.4.33; Laravel 12 requires PHP 8.2+). No install was attempted.

Gate 1 services moved to [docker-compose.gate1.yml](../../docker-compose.gate1.yml), with distinct `gate1-watermelon` and `gate1-powersync` service graphs. Static Compose config passed for the root file and both profiles; profile service listings are candidate-specific and the optional Playwright runner. No container/build/browser/test volume was started or modified. PowerSync source mapping has no verified mismatch; credential acceptance, stream delivery and local materialization remain UNKNOWN. The Watermelon contract defect is fixed, but the previous 0/20 browser failure remains FAIL until a browser re-test. Full checklist and results: [recovery-00-r.md](recovery-00-r.md).

### Recovery 00-R.1a — Watermelon contract recheck

The Laravel pull already returns `changes.notes.created`, `updated`, and `deleted` as arrays; `deleted` contains tombstone record IDs. No endpoint or revision/cursor change was needed. `deleted: false` on active raw records is a declared boolean in the Watermelon `notes` schema and models the app's soft-delete state; it is distinct from the collection-level tombstone array. The four contract tests were strengthened to assert JSON array types, exact raw fields, IDs, collection name, integer timestamp, and that tombstones do not appear as active changes. Static checks pass; Laravel Feature tests remain **NOT RUN** because compatible PHP 8.4 and Composer dependencies are unavailable. Capacity remains **CAPACITY_UNVERIFIED**, Gate 1 remains **BLOCKED**, and the previous 0/20 browser result remains **FAIL pending runtime retest**. See [recovery-00-r.md](recovery-00-r.md#00-r1a--response-contract-recheck).

Ngày: 2026-10-20  
Phạm vi lượt này: hoàn tất phần kiểm chứng khả thi của 00-C trong mức harness; không chạy spike khác hay Phase 01.  
Kết luận: **00-C BLOCKED cho quyết định engine; giữ UNDECIDED.** Bộ integration run cuối có 5/5 tests PASS, nhưng scenario coverage và runtime chưa đồng nhất để xếp hạng.

## Bàn giao 00-C

- Dataset chung: 100 ghi chú tổng hợp, IDs `syncbench-v1-0001`–`0100`, lưu trong MySQL; mọi ứng viên dùng chung fixture, cùng nội dung multi-language/Markdown/JSON.
- **PowerSync Open Edition + MySQL:** Service `1.20.0`, Node SDK `@powersync/node 1.2.0`, client Node `node:sqlite` experimental. Full initial sync 100 fixture, offline edit upload qua Laravel, MySQL replication, second client, lost ACK/idempotent retry, SQLite file close/reopen đều PASS.
- **WatermelonDB + adapter Laravel:** WatermelonDB `0.28.0` gọi `synchronize()` thật qua HTTP; full 100-fixture pull, offline edit, lost ACK, concurrent offline conflict và preservation của local edit, delete/tombstone, stale resurrection, DEVICE_ONLY adapter filter/server rejection PASS. Local store là LokiJS, không phải SQLite mục tiêu.
- **Minimal Custom Sync:** Laravel Delta API + SQLite notes/outbox prototype. Idempotency/lost ACK, duplicate payload guard, stale revision conflict, delete/tombstone/no resurrection, DEVICE_ONLY local-only/fail-closed, close/reopen và additive schema migration khi còn pending mutation PASS. Local client chưa apply full pull vào SQLite.
- Suite cuối: 5 tests PASS, 0 FAIL, 30.35 s; `node --test --test-concurrency=1`. Test sources tại `spikes/phase-00/sync/tests/`; API tại `api/routes/api.php`.
- Bằng chứng đầy đủ, scenario matrix, dependency/license, topology, benchmark limits và reproduction: [sync-benchmark.md](sync-benchmark.md). Run log gồm cả lần đầu nhận diện cấu hình PowerSync cũ và lần pass sau recreate service: [`00-c-run.log`](../../artifacts/phase-00/sync/00-c-run.log).

### Blockers còn lại trước quyết định

1. Chưa chạy cùng scenario tương đương cho cả ba: PowerSync thiếu client-side conflict/delete/schema migration/DEVICE_ONLY cases; Custom chưa local-apply full pull và chưa chứng minh preservation khi conflict; WatermelonDB chưa chạy SQLite adapter.
2. `node:sqlite` của PowerSync là experimental; không đại diện Web SDK/Expo hoặc iPhone thật. Không có iPhone evidence.
3. Reopen SQLite file/Loki adapter harness không tương đương SIGKILL hoặc host crash. Cần process-kill recovery test.
4. Chưa có nhiều iteration cùng workload nên p50/p95 và throughput là N/A. Một snapshot `docker stats` sau run không đủ so sánh resource; client RSS/CPU/peak chưa đo.
5. PowerSync Service license FSL-1.1-ALv2 có Competing Use restriction cần được review theo hướng phân phối dự kiến. Bằng chứng license cấp dependency chưa thay thế rà soát toàn dependency tree.

## Trạng thái workstreams

| Workstream | Status | Kết quả |
| --- | --- | --- |
| Dev Hub registration / UI Lens | PASS | Giữ nguyên block đã duyệt `15700–15799`; mapping Web `15700`, API `15701`, Admin `15702` reserved, MySQL `15710` và Redis `15711` reserved/internal. Discovery trước đó sạch; lượt này không sửa registry/project khác. UI Lens convention hiện có; không tạo tool mới. |
| 00-D minimal Docker foundation | PASS — phần foundation | Web/API/worker/MySQL/Redis/MongoDB/PowerSync chạy trong Compose; health/network/migration/persistence đã kiểm tra trước. Chỉ recreate API và PowerSync service noteOS cho migration/config mới; không reset volumes. |
| 00-D search 5.000 notes | BLOCKED / chưa chạy | Ngoài phần nền tảng tối thiểu; chưa đo p50/p95. |
| 00-D backup/restore | BLOCKED / chưa chạy | Chưa backup/restore. |
| 00-C bake-off | BLOCKED cho engine decision | Bằng chứng scenario từng phần có; chưa tương đương để xếp hạng. Giữ `UNDECIDED`. |
| 00-A, 00-B, 00-E, 00-F, Phase 01 | NOT STARTED | Ngoài phạm vi được duyệt. |

### Gate 1 Web recovery stop

| Item | Status | Evidence / limitation |
| --- | --- | --- |
| noteOS MySQL health | **BLOCKED** | Container stopped with exit 137 and `OOMKilled=true`; unhealthy, startup log ends at InnoDB initialization. Dependent noteOS API/Web/Mongo also stopped. |
| Docker memory capacity | **BLOCKED / CAPACITY_UNVERIFIED** | Capacity readings changed from 4.818 GiB to 7.765 GiB during recovery; active workload inventory also changed. Available VM memory and safe headroom remain unknown. Earlier container snapshots are not peak usage; no new workload was attempted. |
| PowerSync initial pull | **FAIL assertion / RCA BLOCKED** | Chromium and WebKit returned 0/20. Server checkpoint 40 was observed, but no client local table/materialization evidence was collected. |
| WatermelonDB initial pull | **FAIL assertion / RCA BLOCKED** | Chromium returned 0/20; no captured pull body/error or local collection evidence. WebKit not run. |
| Remaining Web scenarios | **NOT TESTED** | Offline reload, local persistence, DEVICE_ONLY, private upload and multilingual search assertions were after the initial count and did not run. |
| Gate 1 data | **PRESERVED** | Both `noteos-phase00_noteos_gate1_mysql` and `noteos-phase00_noteos_gate1_mongo` volumes exist; no prune or volume removal. |

Recovery log and Playwright errors/traces/screenshots: [`artifacts/phase-00/gate1/`](../../artifacts/phase-00/gate1/). Do not interpret this failed pull as an engine comparison or choose an engine from it.

## Docker topology, versions và tài nguyên

Stack chung hiện có Web, Laravel API, worker, MySQL, Redis, MongoDB và PowerSync. PowerSync cần thêm PowerSync Service + MongoDB state store và MySQL binlog/GTID; WatermelonDB/Custom không cần hai service này. Laravel vẫn phải quản lý auth/write validation cho PowerSync; Watermelon cần backend sync contract; Custom tự sở hữu toàn bộ protocol. Redis/Web/worker là app foundation, không phải dependency riêng của PowerSync.

Runtime đã quan sát: macOS 15.7.7; Node 22.21.1; PHP 8.4.26; Laravel 12.70.0; MySQL 8.4.7; Redis 7.4.3; MongoDB 8.0.16; PowerSync Service 1.20.0; WatermelonDB 0.28.0; `@powersync/node` 1.2.0. Licenses: PowerSync Service FSL-1.1-ALv2, SDK Apache-2.0, WatermelonDB MIT, Laravel MIT, MySQL GPLv2, MongoDB SSPLv1, Redis RSALv2/SSPLv1; xem chi tiết/link trong [sync-benchmark.md](sync-benchmark.md).

Một `docker stats --no-stream` snapshot sau sync: PowerSync 204 MiB / 0.37% CPU; API 68 MiB / 0.03%; MySQL 299 MiB / 0.77%; MongoDB 174 MiB / 61.06%; Redis 6.8 MiB / 0.39%; Web 56 MiB / 0.01%. MongoDB đang catch up replication/checkpoints. Đây không phải peak/average hay phép đo cô lập theo ứng viên; không dùng để khuyến nghị.

## Quyết định đề xuất cho ChatGPT/Gemini review

**Không chọn Sync Engine ở thời điểm này.** Không chọn Custom chỉ vì topology gọn, và không chọn framework nào theo raw PASS count. So sánh cho thấy cả ba khả thi ở mức khác nhau, nhưng client runtimes, sync protocol coverage và persistence guarantees chưa khớp.

Xin review các bằng chứng và quyết định `UNDECIDED` trong [architecture-decisions.md](architecture-decisions.md). Chỉ tiếp tục sau architecture review; lượt này dừng tại phần được yêu cầu của 00-C và foundation 00-D, không tự triển khai 00-A/B/E/F hoặc Phase 01.

## Tái lập

```sh
docker compose up -d --build
docker compose --profile tests run --build --rm sync-tests
docker compose ps
```

Dev Hub block, registry và các project khác không bị sửa trong lượt 00-C. Không chạy `docker compose down -v`; named volumes chứa fixture và foundation data cần được giữ nguyên.

## Latest recovery status — 00-R.2 (2026-10-20)

**Gate A BLOCKED (`CAPACITY_UNVERIFIED`); HARD STOP.** Read-only inspection measured Docker VM available RAM at 5.7 GiB and free swap at 2 GiB, but Windows host free RAM was ~465 MiB with six noteOS containers running without per-container memory limits. No Laravel Feature Test or Watermelon browser workload was started. Laravel 4 tests: **NOT RUN**. Watermelon initial pull: **NOT RUN** (not 0/20). Current noteOS MySQL is healthy and completed XA crash recovery; candidate Gate 1 volume readiness remains unverified. No app/test source, container, image, Docker setting, or volume changed. Sync engine stays UNDECIDED; no PowerSync/WebKit/Gate 2/Phase 01 work occurred. See [recovery-00-r.md](recovery-00-r.md#recovery-00-r2--controlled-capacity-gate-2026-10-20).

## Recovery 00-R.3 — 2026-10-20

PowerSync and MongoDB were graceful-stopped after confirming `noteos-phase00` ownership. MySQL/API stayed healthy; Redis/Web remained running; the worker was already exited. Windows memory stabilized between 1.3 and 1.8 GiB available; Docker VM had 5.9 GiB available, unused swap and zero PSI pressure. This is sufficient for a light test in principle but does not meet the estimated 2–3 GiB Chromium envelope. Laravel tests were **BLOCKED / NOT RUN** because PHP 8.4.26 and Laravel 12.70.0 are present but PHPUnit is missing from `vendor/bin`; SQLite `:memory:` test isolation is configured. No dependencies were installed. Watermelon initial pull **NOT RUN**; its root cause remains unknown. Running service inventory at handoff: noteOS API, MySQL, Redis and Web, plus external `dev-hub-caddy`. No source/test code, settings, images or volumes changed. Sync engine remains UNDECIDED. See [recovery-00-r.md](recovery-00-r.md#recovery-00-r3--controlled-workload-reduction-2026-10-20).

## Phase 00-B — Document engine and editor validation (2026-10-20)

**Status: Core schema/conversion PASS; Web editor runtime BLOCKED; native/iPhone runtime BLOCKED; Laravel sync contract tests NOT RUN.** A versioned ProseMirror/Tiptap JSON schema v1 prototype, strict unknown-data read-only behavior, plain-text/Markdown projections, Web `/editor` source, and source-only React Native Quick Capture adapter were added under `spikes/phase-00/gate1/`. The 26-test Node suite passed 26/26. The first run exposed ProseMirror null-prototype attributes breaking strict JSON reload equality; normalized output through JSON serialization fixed it, and the rerun passed. The transformation microbenchmark ran 30 measured iterations per size (100/1,000/5,000 words); p50/p95 and RSS/CPU are recorded in [editor-benchmark.md](editor-benchmark.md), with exact logs under [`artifacts/phase-00/document-engine/`](../../artifacts/phase-00/document-engine/).

Windows available memory settled at 2,539–2,577 MiB in the final sample; commit was 68.58–68.78%, and paging was 0–9 pages/sec. A preceding sample showed transient paging of 24–213 pages/sec. The browser workload gate is **CAPACITY_BLOCKED** for the planned 2–3 GiB Next + Chromium run because available host memory remains at the lower edge with noteOS Docker services present, so no Next install/build/start or browser worker was launched. After the Node run, read-only Docker inspection showed noteOS Web/API/Redis/MySQL healthy, Dev Hub Caddy running, no active PowerSync/MongoDB, and no Docker OOM event in the prior hour. No Docker service, volume, image, or setting was changed. Docker VM free memory and per-container limits were not remeasured. The four Laravel cases were **NOT RUN**: the current API image omits Composer dev dependencies/PHPUnit, while `phpunit.xml` configures SQLite `:memory:` isolation. No Composer install or database operation was attempted. Expo 57 / RN 0.86 native compatibility was researched, but no Metro, simulator, Xcode, or real-iPhone/IME validation ran. The Watermelon 0/20 cause remains unknown; this spike did not exercise that path. No editor or sync engine decision was made, and no PowerSync, Gate 2 or Phase 01 work occurred. Full evidence and limits: [editor-benchmark.md](editor-benchmark.md), [`capacity-and-docker.txt`](../../artifacts/phase-00/document-engine/capacity-and-docker.txt), and [architecture-decisions.md](architecture-decisions.md#00-b--document-engine-and-editor-spike).


## Phase 00-B1 - Editor evidence and safety audit (2026-10-21)

**Document integrity PASS with focused fixes; regression tests PASS 30/30; browser CAPACITY_BLOCKED / NOT RUN; native validation BLOCKED; Laravel contract tests NOT RUN.** The v1 wrapper and supported node/mark tree match the configured Tiptap/ProseMirror schema. Future versions and unknown data at nested depths remain non-editable. The audit tightened attribute type validation and added warnings for code language and ordered-list styles omitted by exports. React Native Quick Capture imports the shared canonical text converter; this confirms source-level schema wiring only.

Windows read-only capacity samples showed 1.48-1.50 GiB available, 70.77-70.95% committed, and paging activity. No Next process or browser worker was launched; browser screenshots/console/runtime results are absent. No native build, simulator, or iPhone test ran. The proposed Laravel path is a PHP 8.4 test-only image/layer using the existing Composer lock, dev dependencies and isolated SQLite `:memory:`; no build or test database operation ran. Details, exact evidence links, official compatibility sources, limitations, and reproduction notes: [editor-benchmark.md](editor-benchmark.md#phase-00-b1-audit-addendum-2026-10-21).

No production feature, Docker configuration, service, image, volume, Sync Engine decision, Gate 1 sync run, Gate 2, Phase 01, or other project was changed. Recommendation: retain UNDECIDED status and finish the single-worker browser and isolated Laravel evidence only when host capacity is safe.
