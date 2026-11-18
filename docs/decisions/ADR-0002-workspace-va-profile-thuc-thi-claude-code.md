# ADR-0002 — Workspace và profile thực thi Claude Code

- **Trạng thái:** Accepted. PO duyệt phạm vi qua ChangeRequest-0001 #155 (2026-11-18); điểm kỹ thuật đã kiểm chứng ở Spike-0009 #139. Thay ADR-0001 D1 và D3; triển khai ở Feature-0024 #156 và Feature-0021 #137.
- **Ngày:** 2026-11-18
- **Người quyết định:** Product Owner (qua phiên Coordinator)
- **Nguồn:** [ChangeRequest-0001 #155](https://github.com/omi-home/omi-plugins/issues/155) (Feature-0021 #137, Milestone-0009 #136)
- **Bằng chứng:** comment `omi:evidence=Spike-0009*` trên [Spike-0009 #139](https://github.com/omi-home/omi-plugins/issues/139)
- **Môi trường:** Claude Code `2.1.325`, Windows 11

## Bối cảnh

ADR-0001 D1/D3 cho agent chạy trong worktree của repo và dặn qua prompt rằng agent phải tự đọc role rules trong `resources/`. Agent thừa hưởng env và cấu hình Claude cấp user của máy. Không có cách chạy agent bằng account hay nhà cung cấp khác với phiên chính. PO muốn mỗi agent là một phiên harness đầy đủ, repo đích sạch, và hỗ trợ nhiều harness lần lượt theo lộ trình.

## Quyết định

| # | Chủ đề | Quyết định |
| --- | --- | --- |
| D1 | Workspace | Repo đích không chứa `.claude/` hay `AGENTS.md`. Cấu hình OMI nằm trong workspace đồng cấp với repo: `<name>-workspace/{.claude/, .omi-plugins/, AGENTS.md, <repo>/}`. Coordinator chạy ở root của workspace. State chuyển vào `.omi-plugins/`. |
| D2 | Task workspace | Mỗi lần chạy agent có một task workspace riêng chứa `.claude/settings.json`, `AGENTS.md` theo role, `REPORT.md` và `<repo>/`, đều sinh từ omi-plugin. Thay thế ADR-0001 D1 về cwd. |
| D3 | Clone thay worktree | `<repo>/` là `git clone --branch develop` từ repo local vừa `fetch origin`, không shallow; `origin` trỏ về GitHub. Push/PR do CLI trên host làm. Chỉ dọn task workspace khi có receipt push hoặc merge. |
| D4 | Role knowledge native | Role rules và skills được đặt vào task workspace dưới dạng `AGENTS.md` + skills native. Thay thế ADR-0001 D3. Coordinator vẫn không thấy, vì chúng chỉ tồn tại trong task workspace. |
| D5 | Cách ly | Env của agent được dựng từ đầu theo profile (allowlist). Mỗi lần chạy có thư mục cấu hình riêng (Claude Code: `CLAUDE_CONFIG_DIR`). Đây là cách ly cấu hình, không phải ranh giới bảo mật; Docker/sandbox là tùy chọn về sau. |
| D6 | Profile | `.omi-plugins/omi.config.json` (riêng từng máy, không commit). Mỗi profile gồm `name`, `harness`, `disabled`, `auth`, `models[]`, `efforts[]`; mỗi property một dòng. `models`/`efforts` là tập giá trị profile hỗ trợ; role chọn giá trị cụ thể. Secret chỉ ở dạng tham chiếu env. Schema là discriminated union theo `harness`. |
| D7 | Auth v1 (Claude Code) | `subscription` → `CLAUDE_CODE_OAUTH_TOKEN`. `gateway` (nhà cung cấp bên thứ ba) → `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` (scheme `x-api-key`) hoặc `ANTHROPIC_AUTH_TOKEN` (scheme `bearer`). Model/effort của gateway do người dùng khai báo và `omi doctor` probe để xác nhận. |
| D8 | Harness thuộc plugin | Plugin mang registry gồm harness → adapter, khoảng phiên bản đã kiểm chứng và capability. Phiên bản ngoài khoảng thì từ chối chạy. Harness hoặc phiên bản mới = DevTask + probe live + release plugin. |
| D9 | Adapter riêng biệt | Mỗi harness có thư mục `runtime/adapters/<harness>/` riêng, không dùng interface `Harness` chung. Harness chỉ được kiểm chứng khi đến lượt làm. Lộ trình: v1 Claude Code, v2 Codex, sau đó dsh, opencode, commandcode… |
| D10 | Quota | Mỗi profile có cờ `disabled` do PO đặt khi hết hoặc sắp hết quota. Chạm quota giữa chừng: CLI dừng step và trả lý do về cho Coordinator (không tự sửa config). Coordinator chọn profile khác và chạy attempt mới của cùng step trên cùng task workspace, đồng thời nhắc PO đặt `disabled: true`. |
| D12 | Coordinator chọn profile, model, effort | Với mỗi step, Coordinator chọn profile theo chỉ dẫn của PO (chia đều, ưu tiên, giao theo từng task); không có chỉ dẫn thì chia đều cho các profile không `disabled`. Model/effort chọn theo độ phức tạp của task/step, chỉ trong `models[]`/`efforts[]` của profile đã chọn. CLI từ chối lựa chọn không hợp lệ, ghi lựa chọn + lý do vào state/báo cáo. Không truyền lựa chọn thì dùng mặc định `agents.<role>`. Bỏ cơ chế chọn tự động `priority`/LRU/cooldown/`maxConcurrent` của #137. |
| D11 | GitHub và điều khoản | GitHub token thuộc CLI; agent không cầm token. Plugin là công cụ trung lập; người dùng tự chịu trách nhiệm tuân thủ điều khoản của từng nhà cung cấp. Gateway bên thứ ba nhìn thấy code và prompt, và có thể sửa output, nên `omi doctor` cảnh báo; diff/commit/comment của agent dùng profile `gateway` được kiểm tra ký tự zero-width. |

## Hệ quả

- Thay ADR-0001 D1 (cwd, env) và D3 (cách ly kiến thức). D4–D7 của ADR-0001 giữ nguyên.
- `docs/architecture/overview.md`: cập nhật hợp đồng thư mục và vị trí state, bỏ `../.omi-worktrees/`.
- Thay DocumentationTask-0004 #93: policy chuyển hẳn ra `<workspace>/.omi-plugins/`; repo đích không còn `.omi/`, `AGENTS.md`, `.claude/` (PO, ChangeRequest-0001 #155). Triển khai trong Feature-0024 #156.
- Chi phí: mỗi task một clone + `npm ci`; phải chuyển đổi các repo đang dùng layout cũ.

## Kết quả Spike-0009 #139

- ✅ `claude -p` với cwd = task workspace nạp `AGENTS.md` + skills + `settings.json`. cwd = `repo/` không nạp skill của thư mục cha ⇒ cwd = task workspace (D2).
- ✅ `CLAUDE_CONFIG_DIR` rỗng + env allowlist cách ly cấu hình user; `--plugin-dir` nạp plugin OMI (D5). Không dùng profile thì `--setting-sources project,local`.
- ✅ `CLAUDE_CODE_OAUTH_TOKEN` chạy trong `-p`; `ANTHROPIC_API_KEY` thắng OAuth ⇒ allowlist bắt buộc (D5, D7).
- ✅ Clone local + push từ host trên Windows; phải fast-forward `develop` local theo `origin/develop` trước khi clone (D3).
- ✅ `rate_limit_event` cho `status`/`utilization`/`resetsAt` theo cửa sổ; lỗi theo `api_error_status` (401 auth, 402 gateway hết credit) (D10).
- ✅ Gateway bên thứ ba (revidapi, `x-api-key`): model đúng, có tôn trọng `--effort` (dựa vào thinking block; `thinking_tokens` qua gateway luôn là 0). Không có `rate_limit_event`; hết credit thì trả 402 (D7, D10).
- 🔴 Gateway có thể **sửa output** của model: thấy ký tự zero-width (watermark) trong câu trả lời. Profile `gateway` phải có kiểm soát ký tự zero-width trước khi commit hoặc đăng comment (D11).
- ⚠️ Chưa kiểm chứng: scheme `bearer`, trạng thái quota bị từ chối thật của subscription. Đã chuyển sang Feature-0021 #137.
