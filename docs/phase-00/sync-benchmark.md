# Spike 00-C — Offline Sync Engine Bake-off

## Gate 1 target-runtime follow-up — 2026-10-20

Gate 1 is **INCOMPLETE; UNDECIDED**. The Next.js production build passed, but the browser contract failed initial pull: Chromium returned 0/20 rows for both Web candidates, and WebKit returned 0/20 for PowerSync. Offline reload, privacy upload and multilingual search assertions did not run. Native G1-01 and cross-device G1-03 are BLOCKED without Xcode/simulator/iPhone. See [framework-comparison.md](framework-comparison.md) for the full matrix, actual versions, traces, topology and reproduction. No engine is selected; Gate 2 is not started.

The earlier Node/LokiJS/Custom Sync results below remain historical Gate 0 evidence and do not count as Gate 1 target-runtime results.

### Controlled Web recovery — 2026-10-20

**Status: BLOCKED before retest. Sync Engine stays UNDECIDED.** Read-only Docker forensics showed the existing noteOS MySQL and isolated Gate 1 MySQL both stopped with exit `137` and `OOMKilled=true`. noteOS MySQL did not complete recovery: its last startup log reaches InnoDB initialization, container state is stopped/unhealthy, and the dependent noteOS API/Web/Mongo services are also stopped. Docker Desktop has 4 CPUs and 4.818 GiB memory; at the snapshot, other local workloads were using substantial memory (MemoryOS Web 1.062 GiB, MemoryOS MySQL 396.3 MiB, and `mysql-local` 543.4 MiB). No additional build, container start, browser, or fixture workload was run.

The OOM kill is **confirmed for both MySQL containers**. The specific source of peak host pressure is unknown. Other noteOS services with exit `137` had `OOMKilled=false`, so they are not classified as OOM. Docker events retained no matching noteOS OOM record in the queried window. Gate 1 named volumes remain present and were not removed; Docker prune was not run.

| Candidate | Observed Web attempt | Recovery-pass classification | RCA status |
| --- | --- | --- | --- |
| PowerSync | Chromium and WebKit initial-pull assertions timed out at 0/20. Server had logged 40 source changes, a stream start and checkpoint 40. | **FAIL — initial-pull assertion**; all later scenarios **NOT TESTED**. | **BLOCKED / unknown** — no client local-table evidence or full delivery trace. Checkpoint 40 alone does not prove rows arrived. |
| WatermelonDB | Chromium initial-pull assertion timed out at 0/20; WatermelonDB WebKit was not run. | **FAIL — initial-pull assertion**; all later scenarios **NOT TESTED**. | **BLOCKED / unknown** — no captured pull response/error and no direct local collection inspection. |
| Recovery prerequisite | noteOS MySQL stopped/unhealthy after OOM; host resource safety not established. | **BLOCKED** — no retest was started. | Must restore noteOS MySQL and verify healthy/resources before a new workload. |

The saved `error-context.md` files show only the count assertion (expected 20, received 0); traces/screenshots and `gate1-run.log` are in [`artifacts/phase-00/gate1/`](../../artifacts/phase-00/gate1/). This evidence does not localize whether fixture delivery, SDK ingestion, schema mapping or the UI query caused either candidate's failure. Recovery RCA and Docker snapshot are recorded in [framework-comparison.md](framework-comparison.md#controlled-recovery-and-rca--2026-10-20).

Ngày chạy: 2026-10-20. Môi trường: macOS 15.7.7, Docker Compose `noteos-phase00`, Laravel 12.70.0 + MySQL 8.4.7, Node 22.21.1 trong test container. Chỉ dùng dữ liệu tổng hợp.

## Kết luận và trạng thái

**BLOCKED — chưa đủ bộ kiểm thử tương đương để xếp hạng hoặc chọn engine.** Cả ba ứng viên có code thực thi; mức tích hợp và độ bao phủ còn khác nhau. Không dùng tổng số PASS làm tiêu chí chọn.

| Ứng viên | Framework chạy thật | Status hiện tại | Giới hạn chính |
| --- | --- | --- | --- |
| PowerSync Open Edition + MySQL | PowerSync Service `1.20.0`, `@powersync/node` `1.2.0` + SQLite `node:sqlite`; stream rules từ MySQL, connector thử nghiệm upload qua Laravel. | **PASS — Node prototype**: full sync 100 fixture, upload offline edit, replication sang client thứ hai, lost ACK replay, reopen cùng SQLite file. | Node SQLite là experimental; chưa kiểm tra Web SDK hoặc Expo/iPhone thật. Conflict preservation, deletion/resurrection, schema migration, DEVICE_ONLY trên client và process-kill recovery còn BLOCKED. |
| WatermelonDB + Laravel adapter | WatermelonDB `0.28.0`, `synchronize()` chạy thật với HTTP adapter gọi Laravel; local store trong harness là LokiJS. | **PASS — protocol prototype**: full pull 100 fixture, offline edit, lost ACK retry, concurrent conflict, local edit được giữ, tombstone, stale create/resurrection bị từ chối, DEVICE_ONLY filtering + server fail-closed. | Chưa dùng SQLite adapter mục tiêu. Durable restart, schema migration và Web/iPhone runtime BLOCKED. |
| Minimal Custom Sync + Laravel | Laravel delta API + SQLite `node:sqlite` local notes/outbox prototype. | **PASS — protocol/local-storage prototype**: idempotency, stale base conflict, tombstone/no resurrection, DEVICE_ONLY local-only/fail-closed, outbox reopen/replay, additive migration khi còn pending mutation. | Full pull chưa được apply vào local client DB trong test; process kill thật, cross-device client merge và Web/iPhone BLOCKED. |

PASS chỉ nói về đúng test harness đã chạy, không chứng minh production readiness.

## Dataset và phương pháp

- Fixture chung `phase00-bakeoff-v1`: đúng 100 note synthetic, ID `syncbench-v1-0001`–`syncbench-v1-0100`; nội dung lặp có tiếng Việt, English, 日本語, Markdown và JSON, khoảng 400–500 ký tự/note. Không có dữ liệu cá nhân.
- Tạo fixture một lần trong MySQL và tái sử dụng cho ba ứng viên. Test notes có ID riêng; phép đếm fixture lọc theo ID prefix. MySQL volumes không bị reset.
- Test tuần tự (`node --test --test-concurrency=1`) do dùng cùng API/database. PowerSync sync rules được reload bằng recreate riêng service PowerSync sau khi đổi cấu hình; không xóa volume.
- Bộ scenario không hoàn toàn tương đương vì adapter/target runtime khác nhau. Kết quả cần review dưới đây là ma trận bằng chứng, không phải xếp hạng.

## Scenario matrix

| Scenario | PowerSync Node + SQLite | Watermelon `synchronize()` + LokiJS | Custom Delta + SQLite prototype |
| --- | --- | --- | --- |
| Full initial sync 100 fixture vào local store | **PASS** — client thứ hai query thấy đúng 100 row sau sync | **PASS** — pull/apply thực tế, local DB thấy 100 fixture | **BLOCKED** — endpoint pull trả 100 fixture, nhưng test chưa apply snapshot vào local SQLite client |
| Offline edit rồi upload về Laravel/MySQL | **PASS** — local SQLite CRUD connector | **PASS** — local edit qua `synchronize()` | **PASS** — SQLite note/outbox gửi delta API |
| Concurrent offline edits | **BLOCKED** — chưa chạy 2 clients sửa cùng note khi offline | **PASS** — A/B sửa cùng note; API trả 409, bản B còn ở local store | **PARTIAL** — stale `baseRevision` trả 409; chưa chứng minh outbox/local copy giữ conflict trong cùng test client |
| Conflict preservation | **BLOCKED** | **PASS** — local unsynced value giữ nguyên sau 409 | **PARTIAL** — server copy trả về; local merge/review flow chưa hiện thực |
| Duplicate mutation / lost ACK | **PASS** — ACK cố ý bỏ sau server commit, connector retry bằng mutation ID ổn định; revision không tăng lần hai | **PASS** — ACK bỏ sau commit, synchronize retry; không thêm revision | **PASS** — durable mutation ID/payload retry trả cùng response; payload khác dùng lại ID bị 409 |
| Delete / tombstone | **BLOCKED** | **PASS** — client mới không kéo note tombstone | **PASS** — tombstone trong pull, stale create không thể resurrect |
| Crash/restart persistence | **PARTIAL** — close DB handle/reopen file; không SIGKILL process/host | **BLOCKED** — LokiJS harness, không kiểm chứng durable adapter/restart | **PARTIAL** — close/reopen SQLite process handle giữ note và outbox; không SIGKILL process/host |
| Schema migration khi còn pending mutation | **BLOCKED** | **BLOCKED** — LokiJS không xác minh Watermelon SQLite schema migration contract | **PASS — prototype** — additive `ALTER TABLE`, pending outbox row và note còn nguyên; không chứng minh migration orchestration production |
| `DEVICE_ONLY` | **BLOCKED** — connector có skip branch, nhưng chưa có assertion end-to-end | **PASS — prototype** — adapter không upload và API từ chối 422 nếu client fail-open | **PASS — prototype** — local-only row không vào outbox; API fail-closed 422 |
| Web/iPhone thật | **BLOCKED** | **BLOCKED** | **BLOCKED** |

WatermelonDB cung cấp sync primitives nhưng backend contract do ứng dụng implement và local database của nó không phải dịch vụ sync; xem [Sync intro](https://watermelondb.dev/docs/Sync/Intro), [backend contract](https://watermelondb.dev/docs/Sync/Backend), [frontend contract](https://watermelondb.dev/docs/Sync/Frontend) và [schema migrations](https://watermelondb.dev/docs/Advanced/Migrations). Harness chưa thể kết luận SQLite adapter behaves giống LokiJS. Không có iPhone thật trong lần kiểm chứng này.

## Thời gian và resource

Đây là lần chạy integration duy nhất, không phải performance benchmark. N=1 không đủ tính p50/p95.

| Quan sát | Giá trị | Giới hạn |
| --- | ---: | --- |
| Cả suite `sync-tests` | 30.35 s | Có build/startup/waits; không dùng để xếp hạng latency |
| Custom SQLite test | 0.16 s | Warm database; endpoint full pull chưa apply vào local DB |
| Custom Delta protocol scenarios | 0.25 s | Không bao gồm production client merge |
| PowerSync Node scenario | 28.79 s | Có PowerSync stream/checkpoint waits và replication; Node SDK thử nghiệm |
| Watermelon scenario | 0.38 s | LokiJS store, không phải SQLite |
| p50/p95, throughput | **N/A** | Cần nhiều vòng lặp đồng nhất và cùng runtime trước khi đo |
| Docker stats sau run, one snapshot | PowerSync 204 MiB / 0.37% CPU; API 68 MiB / 0.03%; MySQL 299 MiB / 0.77%; MongoDB 174 MiB / 61.06%; Redis 6.8 MiB / 0.39% | `docker stats --no-stream`, sau khi service vừa catch up/reload; không phải peak/average, không candidate-isolated. Web 56 MiB / 0.01%. |

Các số liệu container lấy ngay sau lượt full sync; MongoDB CPU còn cao khi PowerSync hoàn tất replication/checkpoint. Không so sánh resource giữa ba engine từ một snapshot này. Test client Node RSS/CPU riêng chưa được thu thập.

## Docker topology và Laravel maintenance

Compose baseline hiện chạy Web, API, worker, MySQL, Redis, MongoDB và PowerSync. Tất cả cổng DB/service nội bộ không publish ra host. Topology tối thiểu theo ứng viên:

| Ứng viên | Dịch vụ riêng cần thêm | Vai trò Laravel | Bảo trì/độ phức tạp hiện quan sát |
| --- | --- | --- | --- |
| PowerSync | PowerSync Service + MongoDB state store; MySQL binlog/GTID; thêm ~2 service ngoài app | Auth/JWT, upload connector, validation/conflict/privacy và quyền ghi MySQL vẫn thuộc ứng dụng | Thêm vận hành service, MongoDB, binlog retention/permissions và sync rules. API integration mỏng hơn nếu connector contract ổn định; test connector hiện vẫn phải tự ánh xạ CRUD và idempotency. |
| WatermelonDB | Không cần PowerSync/MongoDB; giữ API + MySQL; Redis chỉ theo app/queue needs | Laravel phải implement pull/push protocol, cursor/checkpoint, tombstone, conflict, privacy, migration-aware sync | Không thêm replication service, nhưng backend protocol và migration lifecycle là trách nhiệm noteOS; local adapter/runtime phải được chọn rõ theo Web/iOS. |
| Custom | Không cần PowerSync/MongoDB; giữ API + MySQL; Redis chỉ theo app/queue needs | Laravel sở hữu revision clock/log, idempotency ledger, conflict rules, tombstone, privacy và full sync | Ít thành phần riêng nhất, nhưng nhiều logic sync phải tự thiết kế, test, version và duy trì trên cả Web/iPhone client. Chi phí vận hành thấp không đồng nghĩa chi phí maintenance thấp. |

Redis, Web và worker hiện là app foundation dùng chung, không phải yêu cầu riêng của PowerSync. PowerSync stream service đọc MySQL binlog; test có cấu hình replica/binlog và MongoDB. Không tạo container placeholder. Không public MySQL/Redis/MongoDB.

## Versions và licenses

| Dependency | Version chạy | License/ghi chú |
| --- | --- | --- |
| PowerSync Service | 1.20.0 | FSL-1.1-ALv2; source-available, có hạn chế Competing Use. [License tại tag](https://github.com/powersync-ja/powersync-service/blob/v1.20.0/LICENSE). |
| `@powersync/node` | 1.2.0 | Apache-2.0 theo package metadata; Node SQLite implementation được SDK ghi là experimental. [Package](https://www.npmjs.com/package/%40powersync/node). |
| WatermelonDB | 0.28.0 | MIT theo package metadata. |
| Laravel Framework | 12.70.0 | MIT. |
| MySQL Community | 8.4.7 | GPLv2. |
| MongoDB Community | 8.0.16 | SSPLv1. |
| Redis | 7.4.3 | RSALv2/SSPLv1. |

Đây là license notes cho dependency chính, không phải rà soát dependency tree hay tư vấn pháp lý. Kiểm tra lại điều khoản theo cách triển khai/phân phối trước khi chọn.

## Reproduction

```sh
docker compose up -d --build
docker compose --profile tests run --build --rm sync-tests
```

Log lượt tổng hợp gần nhất: [`artifacts/phase-00/sync/00-c-run.log`](../../artifacts/phase-00/sync/00-c-run.log). Kết quả: **5 tests, 5 pass, 0 fail**, 30.35 s test runtime. Nguồn test: `spikes/phase-00/sync/tests/`; API prototype: `api/routes/api.php`; migrations: `api/database/migrations/2026_10_20_000001_create_sync_tables.php` và `2026_10_20_000002_add_dataset_id_to_notes.php`.

## Recommendation

**Không chọn engine trong lượt này; giữ `UNDECIDED`.** Không chọn Custom chỉ vì ít container, cũng không chọn ứng viên khác chỉ vì có nhiều PASS hơn. Bằng chứng còn thiếu làm thay đổi kết luận: WatermelonDB cần adapter/runtime SQLite mục tiêu; PowerSync cần thêm conflict/delete/privacy/migration cases; Custom cần client full-pull apply/merge; cả ba cần chạy cùng workload nhiều lần trên Web và iPhone được hỗ trợ. Những nội dung đó cần kiến trúc review trước khi mở rộng tiếp.
