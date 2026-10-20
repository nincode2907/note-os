# noteOS Phase 00 — report for architecture review

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
