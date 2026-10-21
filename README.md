# noteOS

noteOS là dự án kiểm chứng kiến trúc cho ứng dụng ghi chú local-first trên Web và iPhone. Repository hiện ở **Phase 00**: chạy các spike kỹ thuật và thu thập bằng chứng trước khi quyết định kiến trúc. Đây chưa phải ứng dụng production; chưa bắt đầu Phase 01.

> **Product milestone update (MVP-01.2):** Data-safety findings F-01–F-05 are patched with serialized autosave, live editor recovery, guarded navigation/lifecycle and shared import validation. Targeted browser acceptance passed; durability limits remain explicit. See [MVP-01.2 report](docs/mvp/mvp-01.2-report.md).

## Trạng thái hiện tại

| Hạng mục | Trạng thái | Bằng chứng / giới hạn |
| --- | --- | --- |
| MVP-01 local-first Web notes | **MVP-01.2 — ready for architecture review** | F-01–F-05 patched; xem [báo cáo và giới hạn MVP-01.2](docs/mvp/mvp-01.2-report.md). |
| Dev Hub registration | **PASS** | noteOS đăng ký block `15700–15799`; 200 TCP probes IPv4/IPv6 và Docker publications không phát hiện conflict tại lần recheck trước khi ghi. |
| Docker foundation tối thiểu (00-D) | **PASS** | Web/API/worker/MySQL/Redis/Mongo/PowerSync khởi động; health, kết nối network và persistence qua restart đã được kiểm tra. Search 5.000 note và backup/restore còn **BLOCKED / chưa chạy**; xem [báo cáo nền tảng](docs/phase-00/architecture-decisions.md). |
| Sync bake-off (00-C) | **BLOCKED — engine UNDECIDED** | Suite cuối 5/5 PASS với fixture tổng hợp chung 100 notes. PowerSync Node SQLite full sync/lost ACK/reopen, WatermelonDB LokiJS sync/conflict/tombstone/privacy, Custom SQLite outbox/idempotency/migration prototype. Scenario chưa đồng nhất; Web/iPhone thật chưa chạy; chưa đủ chọn engine. Xem [bảng kiểm thử sync](docs/phase-00/sync-benchmark.md). |
| Các spike 00-A, 00-B, 00-E, 00-F | **NOT STARTED** | Ngoài phạm vi khởi đầu được duyệt. |

Kế hoạch và tiêu chí chính thức nằm trong [technical validation plan](docs/phase-00/technical-validation-plan.md), kèm [bản tổng quan](docs/phase-00/technical-validation-plan.html). Mọi kết quả đo phải ghi thiết bị/OS/browser, phiên bản dependency, dataset, số lần chạy, p50/p95, mức dùng tài nguyên phù hợp và trạng thái PASS/FAIL/BLOCKED. Không suy diễn kết quả từ mã nguồn hoặc cấu hình.

## Baseline kiến trúc đã duyệt

- Monorepo pnpm; chỉ thêm Turborepo nếu spike chứng minh cần thiết.
- Web: Next.js, React, Tiptap. iPhone: Expo, React Native.
- Backend: Laravel 12, PHP 8.4, MySQL, Redis; server chạy bằng Docker Compose.
- Tài liệu chuẩn: ProseMirror/Tiptap JSON có version schema. Markdown là bản chiếu dẫn xuất.
- Engine đồng bộ offline vẫn chưa được quyết định. So sánh PowerSync Open Edition + MySQL, WatermelonDB với adapter thật, và custom sync tối thiểu trước khi khuyến nghị.
- Quyền riêng tư: `DEVICE_ONLY`, `PRIVATE_SERVER`, `CLOUD_ALLOWED`; không tự hạ mức riêng tư và phải fail closed khi ranh giới provider chưa rõ.

## Nội dung repository

- `docker-compose.yml`: cấu hình harness cô lập cho Web, API, worker, MySQL, Redis, MongoDB và PowerSync.
- `api/`: Laravel API thử nghiệm; route health và các route sync prototype.
- `spikes/phase-00/web/`: trang harness tối giản, không phải UI sản phẩm.
- `spikes/phase-00/sync/`: test thử nghiệm cho PowerSync, WatermelonDB/Laravel và Custom Delta.
- `docs/phase-00/`: brief kỹ thuật và tài liệu Phase 00.

Phiên bản runtime đã quan sát: Node `22.21.1`, PHP `8.4.26` (Laravel `12.70.0`), MySQL `8.4.7`, Redis `7.4.3`, MongoDB `8.0.16`, PowerSync Service `1.20.0`, WatermelonDB `0.28.0`, `@powersync/node` `1.2.0`. PowerSync Node SDK đã chạy với experimental `node:sqlite`; đây chưa phải kiểm thử Web hay iPhone. Phiên bản/license và giới hạn xác minh ghi ở [báo cáo Phase 00](docs/phase-00/phase-00-report.md).

## Cổng và dịch vụ dự kiến

Mapping mới đã được đăng ký trong Dev Hub:

| Dịch vụ | Cổng dự kiến | Ghi chú |
| --- | ---: | --- |
| Web | `15700` | Loopback host → container `15000` |
| API | `15701` | Loopback host → container `15001` |
| Admin | `15702` | Chỉ dự trữ |
| MySQL | `15710` | Chỉ dự trữ; nội bộ mặc định |
| Redis | `15711` | Chỉ dự trữ; nội bộ mặc định |

Hostname: `noteos.localhost` và `api.noteos.localhost`, đã khai báo route managed trong Dev Hub. MySQL và Redis không được publish ra network. Không dùng hostname Docker nội bộ từ iPhone; truy cập qua LAN/mạng riêng chỉ sau khi có cấu hình phù hợp và kiểm tra riêng.

## Chạy harness

Yêu cầu Docker Engine/Desktop và Docker Compose. Từ thư mục repository:

```sh
docker compose up -d --build
docker compose ps
curl --fail http://noteos.localhost/health
curl --fail http://api.noteos.localhost/api/health
```

Chạy các test sync trong profile riêng:

```sh
docker compose --profile tests run --rm sync-tests
```

Stack dùng project name `noteos-phase00` và named volumes `noteos_phase00_mysql`, `noteos_phase00_redis`, `noteos_phase00_mongo`. Health, network, và dữ liệu synthetic còn nguyên sau restart đã PASS trong lần chạy ngày 2026-10-20. Các lệnh trên là hướng dẫn tái lập. Không dùng `docker compose down -v` trên môi trường có dữ liệu cần giữ. Backup/restore chưa được kiểm chứng.

Theo dõi trước tiên:

1. Rerun các lệnh harness/test ở trên khi cần tái lập môi trường.
2. Cần đưa từng ứng viên tới cùng bộ scenario và target runtime Web/iPhone; kiểm tra WatermelonDB trên SQLite và đo migration/crash/restart nhiều vòng để có đủ dữ liệu lập decision matrix.
3. Search và backup/restore của 00-D đang được hoãn; báo cáo trạng thái hiện tại và chờ review Phase 00 trước khi mở rộng phần kiểm chứng này.

Xem [báo cáo bàn giao hiện tại](docs/phase-00/phase-00-report.md). Không tự chạy 00-A, 00-B, 00-E, 00-F hoặc Phase 01.

## Privacy và dữ liệu

Chỉ dùng dữ liệu tổng hợp trong spike. Không gửi dữ liệu cá nhân tới dịch vụ ngoài hoặc dùng AI cloud trả phí. `DEVICE_ONLY` không được xuất hiện trên server. JSON canonical phải được giữ nguyên khi schema chưa hỗ trợ; mở read-only nếu chưa thể chỉnh sửa an toàn.

