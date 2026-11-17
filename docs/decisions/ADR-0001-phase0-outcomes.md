# ADR-0001 — Kết quả Phase 0 và các quyết định của PO

- **Trạng thái:** Accepted
- **Ngày:** 2026-11-17
- **Người quyết định:** Product Owner (qua phiên Coordinator)
- **Bằng chứng:** comment bằng chứng trên Spike Issue #3–#12 (T0.1–T0.8); bảng tổng hợp trên [M0 #1](https://github.com/omi-home/omi-plugins/issues/1#issuecomment-6940598215)
- **Môi trường:** Claude Code `2.1.325`, Git `2.55.0.windows.5`, gh `2.100.0`, Node `v24.22.2`, Windows 11; org `omi-home` gói GitHub Free

## Bối cảnh

Spec ([omi-plugins-idea.md](../../omi-plugins-idea.md) §17) yêu cầu 8 spike GO/NO-GO trước khi xây dựng. Các spike đã chạy trên fixture dùng một lần; kết quả và giới hạn nằm trong từng báo cáo. ADR này chốt các lựa chọn mà spec để mở hoặc mà kết quả spike buộc phải đổi.

## Quyết định

| # | Chủ đề | Quyết định | Căn cứ |
| --- | --- | --- | --- |
| D1 | Adapter thực thi MVP | OMI CLI khởi chạy agent có tên bằng tiến trình riêng (`claude -p --agent <plugin>:<role>`, cwd = worktree OMI). Native workflow chỉ là adapter **tùy chọn** cho bước chỉ-đọc song song (`agentType` + `schema`). **Cấm** `isolation: 'worktree'` (cả frontmatter agent lẫn `agent()`). | [T0.1](https://github.com/omi-home/omi-plugins/issues/3#issuecomment-6940599133), [T0.3](https://github.com/omi-home/omi-plugins/issues/5#issuecomment-6940600927) |
| D2 | Ghi nhận effort | `actualEffort: unknown`; `actualModel` lấy từ `modelUsage` / `message.model`; `requestedModel`/`requestedEffort` từ policy. | [T0.1](https://github.com/omi-home/omi-plugins/issues/3#issuecomment-6940599133) |
| D3 | Cách ly kiến thức chuyên môn | **Cách ly tuyệt đối**: kiến thức/quy tắc chuyên môn chỉ nằm trong `resources/role-rules/<role>/`, **không đăng ký thành skill**. Agent đọc qua `${CLAUDE_PLUGIN_ROOT}/resources/...` ghi trong body agent; agent đặt `disallowedTools: Skill`. Skill chỉ dùng cho entry point của Coordinator (`omi-start`, `omi-task`, ...). | [T0.2](https://github.com/omi-home/omi-plugins/issues/4#issuecomment-6940600016) (bổ sung D3) |
| D4 | Default branch | Đặt `develop` làm default branch trên repo thật, để native closing và `closingIssuesReferences` hoạt động với PR → `develop`. | [T0.6](https://github.com/omi-home/omi-plugins/issues/9#issuecomment-6940603316) |
| D5 | Visibility repo | Ưu tiên repo **public** (có branch protection phía server trên gói Free). Repo bắt buộc private trên Free phải ghi rõ chấp nhận rủi ro "không có cưỡng chế phía server"; `omi doctor` cảnh báo. | [T0.7](https://github.com/omi-home/omi-plugins/issues/10#issuecomment-6940604210) |
| D6 | Issue Type | Dùng Issue Type có sẵn của org (`Task`, `Bug`, `Feature`) + label `type:<OMI type>` cho các loại còn lại. Không tạo Issue Type cấp org khi chưa có owner phê duyệt riêng. | [T0.5](https://github.com/omi-home/omi-plugins/issues/8#issuecomment-6940602505) |
| D7 | Nguồn quản lý task | GitHub Project #2 "OMI Engineering Plugin" + Issues là **nguồn duy nhất** cho task, trạng thái và bằng chứng spike (comment có marker `<!-- omi:evidence=... -->`). Repo chỉ giữ spec, ADR, contract, runbook và code — không giữ báo cáo/tracking task. | PO, 2026-11-17 (#72) |

Các quy tắc kỹ thuật bắt buộc rút ra từ spike (không cần PO chọn):

- Mọi thao tác GitHub theo mẫu **read → diff → write** (API báo lỗi khi trùng sub-issue/dependency/field, và âm thầm tạo trùng view).
- Validator PR poll `closingIssuesReferences` có backoff (dữ liệu điền bất đồng bộ, ≤ ~15 giây trong test).
- Bằng chứng merge = receipt GitHub (`merged`, base, head, `headRefOid` == tip cục bộ == tip remote); không dùng `git branch --merged`.
- Outbox comment: lưu pending trước khi gọi API; thiếu `commentId` thì tìm marker trước khi POST.
- Không `--force` khi xóa worktree/branch; không tự xóa branch remote.

## Hệ quả

- **Thay đổi so với spec:** D3 thay thế phần "Specialist skills are native plugin skills preloaded into named subagents via `skills:`" (idea §0 mục 5, §4, bảng role-skill map §4, cây `skills/` §5) và deliverable "one preloaded skill" của T1.4 trong roadmap. Spec cần được cập nhật theo ADR này: thư mục `skills/` chỉ còn các entry skill của Coordinator; nội dung chuyên môn chuyển sang `resources/`.
- **Quyền đọc:** plugin khi cài nằm ngoài thư mục project, nên Read vào `resources/` cần allow rule `Read(//<plugin-root>/resources/**)` hoặc `--add-dir <plugin-root>/resources` — CLI phải truyền khi khởi chạy agent (đã xác minh cả hai cách).
- **Giới hạn của D3:** đây là cách ly *khỏi context main theo mặc định*, không phải ranh giới bảo mật — main vẫn có thể chủ động `Read` file trong `resources/` nếu có quyền.
- **Workflow tùy chọn:** phụ thuộc `"enableWorkflows": true` trong user settings; `omi doctor` phát hiện và tắt adapter khi không có.

## Quyết định bổ sung (2026-11-17)

- **Repo:** `omi-home/omi-plugins`, public (đã tồn tại, rỗng, default `main`).
- **Fixture GitHub:** giữ lại `omi-home/omi-spike-p0-20261117`, `omi-home/omi-spike-p0-private-20261117` và org Project #1 cho integration test M2; xóa khi không còn cần.
- **Spec:** `omi-plugins-idea.md` và `omi-plugins-roadmap.md` đã được cập nhật lên v2.1 cho khớp với ADR này.
- **Project:** org Project [#2](https://github.com/orgs/omi-home/projects/2) với 71 issue sinh từ roadmap §3; `develop` là default branch, `main`/`develop` được bảo vệ (bắt buộc PR, `enforce_admins`).
- **D7:** báo cáo spike chuyển từ repo sang comment trên Spike Issue; thư mục báo cáo trong repo đã bị xóa (#72).

## Việc còn mở

- Project #2 đang private (tài khoản không có quyền đổi visibility Project cấp org).
- Filter/group của các view cần cấu hình thủ công (API không hỗ trợ).
