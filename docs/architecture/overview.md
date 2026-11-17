# Tổng quan kiến trúc

Tóm tắt từ [omi-plugins-idea.md](../../omi-plugins-idea.md) §1, §5 và [ADR-0001](../decisions/ADR-0001-phase0-outcomes.md). Khi mâu thuẫn, spec và ADR thắng.

## Các lớp

| Lớp | Trách nhiệm | Trạng thái gốc |
|---|---|---|
| Phiên Claude chính (Coordinator/PM/SM) | hiểu ý định, chọn workflow, giao tiếp PO | hội thoại |
| Plugin Claude Code | agent chuyên môn, skill entry của Coordinator, workflow tuỳ chọn | mã nguồn plugin |
| Runtime OMI (`runtime/`, `bin/omi`) | FSM, policy, ticket, worktree, báo cáo GitHub, cleanup | SQLite cục bộ |
| GitHub Project + Issues | cây công việc, trạng thái, PR, comment audit | GitHub |
| CI / hooks | kiểm tra độc lập với agent | bằng chứng CI |

Luồng chính (D1): Coordinator → `omi` CLI → `claude -p --agent omi-engineering:<role>` (cwd = worktree của task) → kết quả có cấu trúc → CLI lưu SQLite và đăng comment.

## Hợp đồng thư mục gốc

Chỉ các thư mục sau được phép ở gốc repo. Thêm thư mục gốc mới cần ADR và cập nhật `ALLOWED_ROOT_DIRS` trong [tests/unit/directory-contract.test.ts](../../tests/unit/directory-contract.test.ts) — test này chặn mọi thư mục ngoài danh sách.

| Thư mục | Chủ sở hữu | Nội dung |
|---|---|---|
| `.claude-plugin/` | Claude Code | `plugin.json`, `marketplace.json` |
| `agents/` | Claude Code | 11 agent chuyên môn (`disallowedTools: Skill`) |
| `skills/` | Claude Code | **chỉ** entry skill của Coordinator (D3) |
| `workflows/` | Claude Code | adapter chỉ-đọc tuỳ chọn; cấm `isolation: worktree` |
| `hooks/` | Claude Code | `hooks.json` |
| `resources/` | OMI | `role-rules/<role>/`, `shared/` — đọc bằng đường dẫn tường minh |
| `runtime/` | OMI | CLI, core (FSM/policy/routing/handoff/errors), adapters, reporting, persistence |
| `config/` | OMI | policy YAML, cấu hình GitHub Project |
| `schemas/` | OMI | JSON Schema cho state/step/handoff/comment/cleanup |
| `templates/` | OMI | AGENTS.md dự án, template Issue/PR/báo cáo |
| `bin/` | OMI | `omi` launcher |
| `docs/` | OMI | `decisions/`, `architecture/`, `contracts/`, `runbooks/` |
| `tests/` | OMI | `unit/`, `integration/`, `contract/`, `e2e/`, `fixtures/` |
| `evals/` | OMI | probe định tuyến/cách ly |
| `.github/` | GitHub | workflow CI/release |

Thư mục chỉ được tạo khi task đầu tiên cần nó — không tạo thư mục rỗng hay placeholder.

## Công cụ

- TypeScript chạy trực tiếp trên Node ≥ 22.18 (type stripping, không build); `tsc` chỉ typecheck.
- Test: `node:test`. Lint/format: Biome. Một lệnh: `npm run check`.
