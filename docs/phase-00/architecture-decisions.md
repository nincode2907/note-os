# 00-C Gate 1 — Target runtime (2026-10-20)

**Decision: UNDECIDED.** Gate 1 is incomplete. The Next.js `16.4.2` production build passed, and real Chromium/WebKit browser processes launched. The browser harness failed full initial pull for PowerSync and WatermelonDB (0 of 20 fixture rows materialized). Offline persistence, `DEVICE_ONLY`, search and cross-platform round trip remain unverified. iOS native validation is BLOCKED because the host lacks Xcode and `simctl`. This result is a harness failure and does not establish a framework limitation.

**Controlled recovery update (2026-10-20): BLOCKED before retest.** Read-only Docker inspection confirmed `OOMKilled=true`, exit `137` for noteOS baseline MySQL and isolated Gate 1 MySQL. Baseline MySQL is stopped/unhealthy and its startup log ends during InnoDB initialization. Docker Desktop has 4.818 GiB total memory with other local workloads still active. No further Gate 1 containers, builds, or browser tests were started; both Gate 1 volumes remain intact. Root cause of the 0/20 local results is still unknown for both PowerSync and WatermelonDB because the previous attempt did not capture end-to-end pull and local-store evidence. See [framework-comparison.md](framework-comparison.md#controlled-recovery-and-rca--2026-10-20) and [sync-benchmark.md](sync-benchmark.md#controlled-web-recovery--2026-10-20).

Do not admit either candidate to Gate 2 based on this run. After a separately safe recovery state is available, resume the approved Web diagnosis by tracing fixture source, delivery, SDK local store and UI query for each candidate, then run the missing Web assertions. Native SDK 57 development builds and remaining shared cases stay outside this Gate 1 Web recovery. SDK 58 requires a WatermelonDB `0.28.0` compatibility resolution; see [framework-comparison.md](framework-comparison.md). Full matrix and reproduction: [sync-benchmark.md](sync-benchmark.md#gate-1-target-runtime-follow-up--2026-10-20).

---

# 00-D — Docker foundation tối thiểu

Ngày chạy: 2026-10-20. Đây là kết quả nền tảng ban đầu, không phải hoàn tất toàn bộ spike 00-D.

## Kết quả

**PASS — phần nền tảng tối thiểu.** Docker Compose cô lập chạy các dịch vụ Web, Laravel API, worker, MySQL, Redis, MongoDB và PowerSync. Không có cổng host cho MySQL/Redis/MongoDB/PowerSync; Web và API chỉ bind loopback.

| Kiểm tra | Kết quả | Bằng chứng |
| --- | --- | --- |
| Compose config | PASS | `docker compose config --quiet` thành công. |
| Container health | PASS | Web, API, MySQL, Redis, MongoDB và PowerSync báo healthy. Worker chạy nhưng chưa khai báo healthcheck. |
| HTTP health | PASS | `http://noteos.localhost/health` trả `ok`; `http://api.noteos.localhost/api/health` trả `{"status":"ok"}`. URL loopback `127.0.0.1:15700/health` và `:15701/api/health` cũng thành công. |
| Container network | PASS | Web gọi API qua `api:15001`; API phân giải và mở kết nối TCP tới `mysql:3306`, `redis:6379`. Redis `PING` trả `PONG`. |
| MySQL migrations | PASS | API khởi động qua `php artisan migrate --force`; `php artisan migrate:status` chạy được. |
| Persistence/restart | PASS | Ghi một note tổng hợp qua API, restart riêng MySQL rồi restart toàn stack; note vẫn đọc được sau khi dịch vụ healthy. Lần gọi đầu ngay sau restart MySQL gặp connection refused trong lúc DB khởi tạo; retry sau healthy thành công. |
| UI Lens | PASS | Capture 2/2 viewport desktop 1440×1000 và mobile 390×844; 0 console error, page error, failed request hoặc HTTP error. Chỉ là kiểm tra harness trên browser automation, không phải kiểm tra iPhone thật. |
| Search 5.000 note | BLOCKED / chưa chạy | Chưa có dữ liệu benchmark, iteration, p50/p95 hay mức dùng tài nguyên. |
| Backup/restore | BLOCKED / chưa chạy | Chưa tạo và restore backup. |

Volume được giữ nguyên trong kiểm tra: `noteos_phase00_mysql`, `noteos_phase00_redis`, `noteos_phase00_mongo`. Chỉ sử dụng note tổng hợp `phase00-docker-persist-20261020-a`; không có dữ liệu cá nhân. Không có container hoặc volume project khác bị sửa/xóa.

## Runtime đã quan sát

| Thành phần | Phiên bản |
| --- | --- |
| Host OS | macOS 15.7.7 |
| Web image | Node 22.21.1 Alpine |
| API | PHP 8.4; Laravel Framework 12.70.0 |
| MySQL | 8.4.7 |
| Redis | 7.4.3 Alpine |
| MongoDB | 8.0.16 |
| PowerSync Service | 1.20.0 |

## Dev Hub và UI Lens

Đã đăng ký duy nhất entry `noteos` trong Dev Hub với block `15700–15799`: Web `15700`, API `15701`, Admin `15702` dự trữ, MySQL `15710` và Redis `15711` dự trữ nội bộ. Web/API map tới container port `15000/15001`; hai cổng được publish loopback-only. MySQL/Redis không được publish.

Trước khi ghi registry đã kiểm tra đủ 100 port trên IPv4 và IPv6 (200 TCP probes), Docker published ports, registry và Caddy config; không phát hiện conflict trong block mới. Dev Hub discovery cuối nhận diện noteOS Web/API là OBSERVED, `conflicts: []`, `warnings: []`. Một lần discover trước đó thoáng báo conflict `Agent Corporation/ui-e2e`, nhưng trạng thái hiện tại đã sạch; không thay đổi project đó. `npm run check` PASS; `npm test` PASS 9/9. Managed Caddy routes và Compose đã validate, Caddy restart để nạp route mới.

UI Lens dùng `.ui-review.json` hiện có, không tạo công cụ mới. Capture được lưu tại `artifacts/ui-review/2026-10-20T02-36-50-028Z_2c4b2038-79dc-46d6-aacf-737ffacb7159/`.

## Tái lập

```sh
docker compose up -d --build
docker compose ps
curl --fail http://noteos.localhost/health
curl --fail http://api.noteos.localhost/api/health
docker compose exec -T redis redis-cli ping
```

Kiểm tra test sync ở [sync-benchmark.md](sync-benchmark.md). Không chạy `docker compose down -v`; lệnh đó xóa named volumes.

## Giới hạn

Đây chỉ là foundation cần thiết cho sync spike, chưa chứng minh khả năng production, sức tải, backup/restore, search, HA, TLS, hoặc hành vi trên thiết bị thật. Worker không có healthcheck độc lập. Có startup race ngắn khi MySQL vừa restart; client cần retry kết nối theo thiết kế trước khi dùng production.

## 00-C — Sync Engine decision record

Ngày cập nhật: 2026-10-20. Trạng thái: **UNDECIDED; bake-off tổng thể BLOCKED do bằng chứng chưa tương đương.** Chi tiết scenario, runtime, resource snapshot và reproduction ở [sync-benchmark.md](sync-benchmark.md).

### Bằng chứng đã có

- Bộ dữ liệu dùng chung là 100 note tổng hợp trong MySQL, được đồng bộ bởi PowerSync Node client và WatermelonDB `synchronize()`; Custom API trả về cùng snapshot nhưng test local client chưa apply full pull.
- PowerSync Open Edition `1.20.0` + `@powersync/node` `1.2.0` chạy với MySQL binlog và MongoDB state store. Node client dùng `node:sqlite` experimental. Upload/lost-ACK replay/second-client replication/full fixture sync PASS.
- WatermelonDB `0.28.0` chạy `synchronize()` với Laravel HTTP adapter. Framework yêu cầu ứng dụng sở hữu backend pull/push contract; harness dùng LokiJS. Full fixture sync, conflict preservation, tombstone và privacy prototype PASS.
- Custom Delta API/Laravel và SQLite notes/outbox prototype có idempotency, base revision conflict, tombstone, DEVICE_ONLY, outbox reopen/replay và additive schema migration với pending mutation PASS trong phạm vi prototype.

### Topology và vận hành

| Option | Runtime additions to baseline | Trách nhiệm Laravel | Chi phí maintenance nổi bật |
| --- | --- | --- | --- |
| PowerSync | PowerSync Service + MongoDB state store; MySQL binlog/GTID | Token/auth, upload connector và kiểm soát write/conflict/privacy | Thêm service vận hành, MongoDB, retention/permissions cho binlog, versioned sync rules và client connector. |
| WatermelonDB | Không cần PowerSync hoặc MongoDB | Pull/push endpoints, cursor, conflict, tombstone, privacy, migration contract | Ít service hơn; protocol backend và migration compatibility do ứng dụng duy trì. |
| Custom Delta | Không cần PowerSync hoặc MongoDB | Toàn bộ sync protocol: revisions/log, idempotency, conflict, tombstone, full pull và privacy | Ít service riêng nhất; nhiều mã ứng dụng hơn cần triển khai, version, kiểm thử trên cả Web/iPhone. |

Redis/Web/worker là app foundation; không tính là dependency riêng của PowerSync. Docker stats hiện chỉ là một snapshot sau replication, không đủ so sánh resource. PowerSync Service license FSL-1.1-ALv2 có hạn chế Competing Use; WatermelonDB MIT; `@powersync/node` Apache-2.0; Laravel MIT. Xem nguồn và giới hạn license trong báo cáo sync.

### Quyết định và điều kiện review

**Không chốt engine ở lượt này.** PASS count không tương đương vì mỗi adapter/runtime thực hiện khác scenario. Trước khi có quyết định cần: cùng test contract trên target runtime; client full pull/apply cho Custom; SQLite adapter và migration/restart cho WatermelonDB; PowerSync conflict/delete/DEVICE_ONLY/migration và process-kill tests; nhiều iteration latency p50/p95, throughput, CPU/RSS và dung lượng cùng workload. Không có kết luận iPhone thật.

Giữ block Dev Hub `15700–15799`, mapping và các entry khác nguyên trạng. 00-A, 00-B, 00-E, 00-F và Phase 01 chưa chạy.
