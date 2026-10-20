# noteOS — Phase 00: Technical Validation

**Role:** Codex — Implementation Engineer  
**Lead Architect:** ChatGPT  
**Co-Architect:** Gemini  
**Status:** APPROVED FOR PHASE 00 ONLY

## 1. Mission

Thực hiện Phase 00 cho dự án **noteOS** — ứng dụng local-first AI note-taking dành cho Web và iPhone.

noteOS phục vụ ghi chú hằng ngày, ý tưởng, học tập, voice notes, công việc và meeting notes. Meeting chỉ là một module.

Mục tiêu Phase 00 là **kiểm chứng các quyết định kiến trúc bằng phần mềm chạy thật và automated tests**, không triển khai ứng dụng production.

Ưu tiên sử dụng framework và thư viện trưởng thành thay vì tự xây lại những hệ thống đã tồn tại.

Không mở rộng chức năng, không tự bắt đầu Phase 01.

## 2. Architectural Baseline

Các lựa chọn đã thống nhất:

- Monorepo: pnpm workspaces, Turborepo nếu thực sự cần.
- Web: Next.js + React + Tiptap.
- iOS: Expo + React Native.
- Backend: Laravel 12, PHP 8.4, MySQL, Redis.
- Infrastructure: Docker Compose.
- Editor: Canonical ProseMirror/Tiptap JSON AST với schema version.
- AI: adapter sử dụng pattern đã tồn tại trong MemoryOS.
- STT: adapter độc lập với LLM.
- Privacy: DEVICE_ONLY, PRIVATE_SERVER, CLOUD_ALLOWED.
- Offline sync: **CHƯA CHỐT ENGINE**, phải benchmark.
- iOS recording: `expo-audio` là ứng viên mặc định.

Không cố định phiên bản framework cũ. Kiểm tra các phiên bản stable đang được hỗ trợ và khóa dependency sau khi kiểm chứng tương thích.

Expo SDK 58 vừa phát hành; sử dụng SDK 57 làm baseline so sánh và thử SDK 58 nếu phù hợp.

## 3. Operational Rules

1. Toàn bộ backend, database, Web và worker phải chạy qua Docker Compose.
2. Không yêu cầu người dùng cài trực tiếp PHP, MySQL, Redis hoặc Node trên host để chạy server.
3. Mục tiêu server startup: `docker compose up -d --build`.
4. iOS development build có quy trình riêng; Docker không được xem là thay thế Xcode/EAS signing.
5. Không thay đổi các project hoặc container hiện có của MemoryOS, AI Gateway hay ứng dụng khác.
6. Không reset volume chứa dữ liệu thật.
7. Mọi test có khả năng phá dữ liệu phải chạy trong môi trường Docker và database cô lập.
8. Không sử dụng dịch vụ AI cloud trả phí hoặc gửi dữ liệu cá nhân ra ngoài trong Phase 00.
9. Không tự giả lập kết quả kiểm thử trên iPhone thật.
10. Nếu thiếu thiết bị, tài khoản ký ứng dụng hoặc quyền truy cập cần thiết, đánh dấu BLOCKED và mô tả bằng chứng còn thiếu.
11. Không tự tạo tài khoản bên thứ ba hoặc dùng thông tin xác thực chưa được cấp.
12. Không tự push/deploy lên môi trường bên ngoài.

## 4. Technical Spikes

### Spike 00-A — Native Audio & Recovery

Đánh giá `expo-audio` trên iPhone.

Thực hiện:

- Thu âm trực tiếp.
- Background recording khi khóa màn hình.
- Pause/resume, interruption handling.
- Ghi âm dài và thử segmented recording.
- Lưu metadata, recording state và file manifest.
- Recovery khi restart hoặc force-close.
- So sánh `.m4a`, `.wav`, `.caf` nếu các định dạng được API và thiết bị hỗ trợ.
- Kiểm tra SHA-256, kích thước file, duration và khả năng phát lại.

Không giả định có thể xoay segment trong background chính xác theo JS timer.

Phân biệt MediaRecorder timeslice blobs với những tệp audio độc lập đã finalize.

**PASS:** Các segment đã hoàn tất được phục hồi nguyên vẹn; background recording hoạt động trong điều kiện thử; các đoạn thu có thể phát lại. Phải đo và báo cáo những khoảng ngắt âm thanh.

**BLOCKED:** Không có iPhone thật để xác nhận hành vi native.

Không yêu cầu bảo đảm khôi phục 100% âm thanh của segment đang ghi dở sau force-close.

### Spike 00-B — Editor & Canonical Document

Tạo document schema v1 và benchmark:

- Web: Tiptap.
- iPhone Quick Capture: Native TextInput.
- Native Markdown editor: `@expensify/react-native-live-markdown`.
- Full Rich Editor: `@10play/tentap-editor`.

Kiểm thử:

- Tiếng Việt Telex/VNI.
- Tiếng Nhật IME.
- Heading, lists, checklist, code block, link và attachment reference.
- Text → canonical JSON.
- Canonical JSON → Markdown export.
- Đồng bộ nội dung Web ↔ iPhone.
- Unknown nodes/schema version mismatch.

Canonical JSON là nguồn dữ liệu duy nhất. Markdown chỉ là derived projection.

Khi client gặp document schema không hỗ trợ, phải bảo vệ JSON gốc và mở read-only nếu chưa có giải pháp chỉnh sửa an toàn.

**PASS:** Không mất nội dung, thứ tự, node hay thuộc tính nằm trong supported schema khi chuyển đổi và chỉnh sửa qua lại.

Các giới hạn editor phải được nêu rõ.

### Spike 00-C — Offline Sync Engine Bake-off

Đây là spike có quyền quyết định kiến trúc cao nhất.

So sánh:

**Candidate A:** PowerSync Open Edition + MySQL, self-hosted.

**Candidate B:** WatermelonDB với sync adapter thực sự.

**Candidate C:** Minimal custom Delta Sync dùng SQLite client + Laravel API.

Không loại PowerSync vì giả định MySQL chỉ hỗ trợ thương mại. Phải xác minh license, compatibility, deployment và số container cần vận hành.

Không được gọi custom protocol là WatermelonDB sync engine nếu không sử dụng adapter của WatermelonDB.

Các tình huống test bắt buộc:

1. Create offline → reconnect → sync.
2. Edit offline trên hai thiết bị.
3. Update cùng một note gây conflict.
4. Client gửi trùng mutation.
5. Server commit thành công nhưng client không nhận ACK.
6. Crash giữa quá trình sync.
7. Delete offline rồi reconnect.
8. Recreate/resurrection sau delete.
9. Schema migration khi còn unsynced changes.
10. DEVICE_ONLY không xuất hiện ở server.
11. Restart toàn bộ Docker stack nhưng dữ liệu đã commit vẫn còn.
12. Client mới sync toàn bộ dữ liệu và đối chiếu nội dung.

Nếu thử custom revision log, phải bảo đảm transaction commit ordering, cursor consistency và idempotency. Không được giả định AUTO_INCREMENT tự động biểu diễn đúng thứ tự commit trong mọi trường hợp.

**PASS:** Không phát hiện mất nội dung đã commit, duplicate mutation không tạo ra thay đổi trùng lặp, conflict được giữ và truy xuất rõ ràng.

**Deliverable:** Decision Matrix với complexity, reliability, license, maintenance, Docker topology và recommendation.

### Spike 00-D — Docker, Storage & Search

Dựng một Docker Compose stack cô lập:

- Web
- Laravel API
- MySQL
- Redis
- Worker
- Các dịch vụ phụ chỉ khi thực sự cần cho spike

Kiểm chứng:

- One-command startup.
- Named volume persistence.
- Healthcheck.
- Restart recovery.
- Cấu hình môi trường có thể tái lập.
- Backup database và media.
- Restore vào môi trường sạch.
- Kết nối Web/API qua hostname phù hợp.
- Kết nối từ iPhone qua LAN hoặc mạng riêng, không dùng Docker hostname nội bộ trên điện thoại.

Kiểm thử tìm kiếm với dataset tối thiểu 5.000 notes chứa:

- Tiếng Việt có dấu/không dấu.
- Tiếng Anh kỹ thuật.
- Kanji/Hiragana/Katakana.
- Code snippets.

Đánh giá FTS5 unicode61, trigram và phương án bổ sung khi cần.

Báo cáo search recall/precision trên bộ truy vấn mẫu và p50/p95 latency. Không tuyên bố tìm kiếm tiếng Nhật chuẩn xác chỉ dựa vào một tokenizer chưa kiểm chứng.

### Spike 00-E — Privacy & AI Integration Contracts

Xác minh API thực tế của AI Gateway và MemoryOS nếu codebase có thể truy cập.

Không tự sáng tạo endpoint hoặc model metadata rồi tuyên bố đã tương thích.

Kiểm thử:

- DEVICE_ONLY: không gửi đến server.
- PRIVATE_SERVER: không đi tới bất kỳ upstream cloud AI/STT nào.
- CLOUD_ALLOWED: chỉ cho phép gửi ra ngoài khi có cấu hình và thao tác được phép.
- Privacy inheritance cho audio, attachments, transcript và AI artifacts.
- Không hạ privacy level ngầm.
- Không đưa nội dung từ note riêng tư vào batch AI không tương thích chính sách.
- Fail closed khi không xác định được provider execution boundary.
- Gateway timeout/invalid response không ảnh hưởng note storage.

Header riêng tư không được xem là bảo mật nếu gateway không thực thi chính sách.

Kiểm tra cả cấu hình provider và khả năng chặn egress bằng môi trường kiểm thử.

MemoryOS Promotion contract chỉ được ghi nhận VERIFIED khi đã đối chiếu với implementation thực tế.

### Spike 00-F — Data Durability & Restore

Kiểm chứng đường đi của dữ liệu:

`Capture → Local Commit → Sync → Server Commit → Backup → Restore`

Bao gồm:

- Canonical JSON.
- Note version history.
- Attachments.
- Audio segments.
- Sync outbox.
- Conflict copies.
- Privacy metadata.

Mô phỏng crash, partial upload, corrupted file và backup bị thiếu attachment.

Chỉ cho phép eviction file local sau khi đủ điều kiện xác minh bản sao và chính sách giữ file.

Dữ liệu DEVICE_ONLY hoặc dữ liệu chưa đồng bộ phải được hiển thị rõ rằng chưa có trong server backup.

**PASS:** Khôi phục được dữ liệu đã đưa vào backup và xác định minh bạch phần dữ liệu chưa được backup. Không tuyên bố zero-data-loss tuyệt đối trước sự cố thiết bị không thể phục hồi.

## 5. Measurements

Với mỗi benchmark:

- Ghi rõ device/OS/browser.
- Framework/package versions.
- Dataset và số lượng iterations.
- p50/p95.
- CPU/memory nếu phù hợp.
- Expected vs actual.
- PASS / FAIL / BLOCKED.

Không dùng những mục tiêu dưới 50 ms, dưới 100 ms hoặc dưới 2 giây làm bằng chứng nếu chưa đo thực tế.

Nếu thiếu thiết bị thật, benchmark simulator chỉ có giá trị simulator.

## 6. Mandatory Deliverables

Tạo trong repository noteOS:

- `docs/phase-00/architecture-decisions.md`
- `docs/phase-00/framework-comparison.md`
- `docs/phase-00/editor-benchmark.md`
- `docs/phase-00/sync-benchmark.md`
- `docs/phase-00/audio-recovery.md`
- `docs/phase-00/privacy-contracts.md`
- `docs/phase-00/backup-restore.md`
- `docs/phase-00/phase-00-report.md`

Bằng chứng kỹ thuật:

- Source code của các spikes.
- Automated tests.
- Docker Compose configuration.
- Test outputs/logs.
- Screenshots của những prototype có UI.
- Documented reproduction steps.
- Dependency versions/license notes.
- Các giới hạn chưa được giải quyết.

Có thể dùng một báo cáo chung cho nhiều spike nếu không làm mất khả năng truy xuất bằng chứng.

## 7. Final Report Format

Báo cáo cuối cùng phải trả lời:

1. Những gì đã triển khai và thực sự chạy được.
2. Kết quả PASS / FAIL / BLOCKED của từng spike.
3. Framework nào nên chọn và lý do.
4. Thư viện nào cần loại bỏ.
5. Những rủi ro còn lại.
6. Những việc cần kiểm chứng trên iPhone thật.
7. Các điểm mâu thuẫn với thiết kế của Gemini/ChatGPT.
8. Đề xuất kiến trúc Phase 01.
9. Những quyết định ChatGPT cần phê duyệt.
10. Hướng dẫn chạy môi trường test bằng Docker.

Không báo cáo "all tests passed" nếu những trường hợp cần phần cứng thật chưa được thực hiện.

## 8. Hard Stop

Sau khi hoàn thành Phase 00:

- Không tiếp tục Phase 01.
- Không xây giao diện production.
- Không triển khai feature ngoài phạm vi spike.
- Không mở rộng thành multi-agent system.
- Không thay đổi MemoryOS hoặc Local AI Gateway production.
- Không thực hiện deployment ngoài local.

**Dừng tại Phase 00 và bàn giao báo cáo để ChatGPT (Lead Architect) cùng Gemini review.**