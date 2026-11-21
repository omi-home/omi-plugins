# ADR-0006 — Kiến trúc feature module và contract kiến trúc kiểm tự động

- **Trạng thái:** Accepted. PO duyệt thiết kế 2026-11-21 (comment quyết định trên Feature-0043 #321, cùng ARC-001/002/003). Làm rõ ADR-0002 D1 (D3); thay `resources/role-rules/` bằng `agent-pack/agents-md/` trong ràng buộc của ADR-0001 D3 theo ADR-0003 (D5).
- **Ngày:** 2026-11-21
- **Người quyết định:** Product Owner (qua phiên Coordinator)
- **Nguồn:** Feature-0043 #321 (section `architecture`), DocumentationTask-0017 #325, yêu cầu PO 2026-11-21 về harness (D7)

## Bối cảnh

`runtime/` đang chia theo lớp kỹ thuật (`adapters/`, `cli/`, `core/`, `persistence/`, `reporting/`, `monitor/`, `resources/`) chứ không theo chức năng. Một chức năng (task run, ticket, issue/project GitHub, profile/secret, report/outbox, cleanup, context, handoff) nằm rải qua nhiều thư mục; `cli/main.ts` và `cli/task.ts` rất lớn. Cấu hình ở `config/`, template ở `templates/`, schema ở `schemas/monitor/`. PO muốn tổ chức lại theo clean architecture, gom theo chức năng, và có cơ chế tự động giữ cấu trúc đó cho mọi repo OMI quản lý để không phải refactor cấu trúc thêm lần nào nữa.

Ràng buộc giữ nguyên: thư mục gốc mới cần ADR và không tạo thư mục rỗng/placeholder; ADR-0001 D1 (CLI khởi chạy agent bằng tiến trình riêng); TypeScript chạy trực tiếp bằng Node ≥ 22.18 (type stripping, `erasableSyntaxOnly`, import kèm đuôi `.ts`, không build); contract có kiểu (zod) ở một chỗ, `parseContract`, `OmiError`, `redact`; đường dẫn được tham chiếu bởi `.claude-plugin/`, `hooks/hooks.json`, `bin/omi`, `skills/`, `agent-pack/`, `package.json`, `biome.json`, CI `check.yml` và `schemas/monitor/` (repo `omi-monitor` đọc); hai mô hình legacy/v2 song song tới Feature-0042 #301.

## Quyết định

| # | Chủ đề | Quyết định |
| --- | --- | --- |
| D1 | Feature module, 4 lớp, shared kernel, composition root | Runtime chia theo **feature module** với 4 lớp `domain` / `application` / `adapters` / `cli` và hướng phụ thuộc như bảng 4 lớp bên dưới. `runtime/shared/` là shared kernel. `runtime/cli/main.ts` là composition root. |
| D2 | Asset và test | Asset giữ ở `config/`, `templates/`, `schemas/` với chủ sở hữu theo module, đọc qua `shared/plugin-paths.ts`. Test ở `tests/<loại>/<module>/`. **Không thêm thư mục gốc mới.** |
| D3 | Contract kiến trúc | Mỗi repo có `omi-architecture.yaml` (zod `ArchitectureContract`) nằm trong repo. **Làm rõ ADR-0002 D1** (ARC-002): contract là tài liệu kiến trúc của sản phẩm, không phải state của OMI, nên được phép nằm trong repo đích (ADR-0002 D1 vẫn cấm `.omi/`, `AGENTS.md` của OMI và `.claude/` trong repo đích). |
| D4 | Check tất định | `omi arch check` chạy ở gate (`GateCheck.architecture`), ở `omi doctor` và trong `npm run check` của omi-plugins. Parser bản đầu chỉ hỗ trợ TS/JS; `importParser: none` cho stack khác (chỉ kiểm placement và module). |
| D5 | Agent | Agent nhận bản trích contract trong packet. Luật cho Reviewer/Architect nằm ở `agent-pack/agents-md/` (**thay `resources/role-rules/` theo ADR-0003**, ARC-001). |
| D6 | `legacy` | `legacy` trong contract là cơ chế chuyển đổi có thời hạn. Mỗi mục gắn với một Issue và phải rỗng khi Feature-0043 Done. |
| D7 | Harness | Thêm module `runtime/harness/` với port `Harness` trung lập; mỗi harness là một adapter. Harness sau (DeepSeek, chạy qua API gateway) thêm bằng adapter mới, không sửa `task-run`. Chi tiết ở mục "D7 Harness". |

## D1 — Kiến trúc

### Bảng 4 lớp

Mỗi module có tối đa 4 lớp, mỗi lớp là một thư mục con, chỉ tạo khi có file.

| Lớp | Thư mục | Được import |
| --- | --- | --- |
| domain | `<module>/domain/` | domain; shared. Cấm `node:child_process`, `node:fs`, `node:sqlite` (`forbidPackages`) |
| application | `<module>/application/` | application, domain; shared. Dùng adapter qua interface (port) do cli truyền vào |
| adapters | `<module>/adapters/` | adapters, application (port), domain; shared |
| cli | `<module>/cli/` | mọi lớp; shared |

### Shared kernel `runtime/shared/`

`contracts.ts` (enum dùng chung giữa các module, `parseContract`), `errors/`, `redact.ts`, `config.ts` (OmiConfig), `plugin-paths.ts` (PLUGIN_ROOT và thư mục asset; thay mọi `new URL("../../…")`), `process/` (supervise, command-env), `sqlite/` (db, migrations), `github/client.ts`. Shared **không import module nào**; module nào cũng import được shared.

- Schema riêng của một module nằm trong `domain/` của module đó. Enum role/state/status dùng chung vẫn ở `shared/contracts.ts` (giữ nguyên tắc "contract có kiểu ở một chỗ").
- **Composition root** `runtime/cli/main.ts` (`bin/omi` trỏ tới, giữ nguyên đường dẫn): chỉ route lệnh tới `<module>/cli/`.
- **Phụ thuộc giữa module:** một module chỉ import module khác khi module đó có trong `dependsOn` của nó; lớp đích vẫn phải được phép theo bảng 4 lớp. Đồ thị `dependsOn` không có chu trình.

## D2 — Asset và test

Asset giữ ở thư mục gốc (không thêm thư mục gốc, tham chiếu ngoài không vỡ). Mỗi asset có một module chủ; tên file và nội dung không đổi. Chỉ đọc asset qua `shared/plugin-paths.ts`.

| Asset | Module chủ |
| --- | --- |
| `config/github/*`, `templates/github/`, `templates/github-v2/` | `github` |
| `config/risk-policy.yaml` | `release` |
| `templates/reports/` | `reporting` |
| `templates/workspace/` | `workspace` |
| `schemas/monitor/` | `monitor` |

Test: `tests/<loại>/<module>/**/*.test.ts`. Test được import mọi thứ nhưng phải nằm dưới `tests/{unit,integration,contract,e2e}/`.

## Ánh xạ thư mục cũ → mới

Đường dẫn dưới `runtime/`.

| Hiện tại | Mới |
| --- | --- |
| `core/contracts.ts`, `core/errors/`, `reporting/redact.ts`, `core/config.ts`, `workflow-engine/{supervise,command-env}.ts`, `persistence/{db,migrations}.ts`, `adapters/github/client.ts` | `shared/…` |
| `core/workspace.ts`, `cli/{workspace,init,config}.ts`, `cli/doctor.ts` | `workspace/` |
| `core/{project-config,repo-config,workflow-config,hierarchy,issue-forms}.ts`, `adapters/github/{project,project-fields,board,repo,issue,dependency}.ts`, phần `github`/`issue` của `cli/main.ts` | `github/` |
| `adapters/github/ticket.ts` | `ticket/` |
| `core/handoff/packet.ts`, `adapters/github/{handoff,context}.ts` | `handoff/` |
| `core/workflow-engine/{fsm,plan,slice,commit,checks,setup}.ts`, `resources/{worktree,role-files}.ts`, `core/attempt-liveness.ts`, `persistence/repository.ts`, `cli/{task,status}.ts` | `task-run/` (`cli/task.ts` tách theo subcommand) |
| `adapters/claude/launch.ts` | `harness/adapters/claude-code/` (không vào `task-run`, xem D7) |
| `reporting/{render,outbox}.ts` | `reporting/` |
| `resources/cleanup.ts`, `cli/cleanup.ts` | `cleanup/` |
| `adapters/github/{pr,merge}.ts`, `cli/release.ts` | `release/` |
| `core/secrets.ts`, `persistence/profiles.ts`, `cli/{profile,secret}.ts` | `profile/` |
| `monitor/{protocol,schemas}.ts` | `monitor/` |
| `core/{context-usage,context-settings}.ts`, `cli/context.ts` | `context/` |
| `cli/hook.ts` | `hook/` |
| (mới) | `architecture/` |
| (mới) | `harness/` (port `Harness` ở `domain/`, adapter `adapters/claude-code/`) |

## D3 — Contract kiến trúc và ADR-0002 D1 (ARC-002)

`omi-architecture.yaml` khai báo module, lớp, `dependsOn`, nơi đặt file, stack/ngôn ngữ, `forbidPackages`, `importParser` và `legacy`. Schema zod `ArchitectureContract` đi qua `parseContract`; field lạ bị từ chối; đường dẫn trong contract không cho path traversal. ADR-0002 D1 quy định dữ liệu và cấu hình của OMI không nằm trong repo đích. D3 làm rõ rằng contract kiến trúc khác loại: nó mô tả kiến trúc của chính sản phẩm, được review và version cùng code, nên đặt trong repo. State, profile và config của OMI vẫn nằm ngoài repo đích.

## D4 — Check và phạm vi bật cho repo đích (ARC-003)

`omi arch check` phát hiện import vượt ranh giới hoặc sai hướng, file sai chỗ, module không khai báo; mỗi vi phạm báo file, quy tắc và cách sửa bằng `OmiError`, output qua `redact`. Check không dùng LLM.

Repo đích chỉ bị chặn ở **gate `omi task run`** (`GateCheck.architecture`). Chạy check trong CI của repo đích là **follow-up**, không thuộc Feature-0043.

## D5 — Agent (ARC-001)

Packet mang bản trích contract liên quan đến scope. Luật Code Reviewer (kiểm theo contract) và Architect (cập nhật contract khi thêm module) nằm ở `agent-pack/agents-md/`. Điều này **thay `resources/role-rules/`** mà ADR-0001 D3 nêu, theo ADR-0003; không đăng ký thành skill.

## D6 — `legacy`

Trong lúc refactor, file hoặc import chưa tuân thủ khai báo trong `legacy` của contract. Mỗi mục gắn một Issue theo dõi và có thời hạn; `legacy` phải rỗng khi Feature-0043 Done.

## D7 Harness

Yêu cầu PO 2026-11-21: harness tiếp theo hỗ trợ cho runtime là **DeepSeek harness, chạy với API gateway**; bộ skills hiện tại của agent có thể mới chỉ hỗ trợ Claude Code. Hiện thực DeepSeek harness nằm **ngoài Feature-0043** (Issue riêng sau #321); ADR này chỉ chốt ranh giới để thêm harness không phải refactor lại.

### Module `runtime/harness/`

- **Port `Harness`** nằm ở `harness/domain/`, trung lập với nhà cung cấp. Trách nhiệm:
  - khởi chạy agent bằng **tiến trình riêng** (ADR-0001 D1);
  - đọc kết quả step (structured result);
  - phát hiện hết quota;
  - báo model và effort **quan sát được** (không suy ra từ cấu hình; effort không quan sát được thì `unknown`, theo ADR-0001 D2);
  - nạp agent pack.
- **Danh sách capability** của mỗi harness khai báo tường minh: `skills`, `hooks`, `subagent`, `effort`, … (tập mở rộng được trong `domain/`).
- **Adapter** nằm ở `harness/adapters/<tên>/`. `adapters/claude-code/` hiện thực từ `adapters/claude/launch.ts`. Harness sau thêm bằng adapter mới (ví dụ `adapters/deepseek/`) mà **không sửa `task-run`**.
- **Chọn harness** theo `Profile.harness`, vốn đã là `discriminatedUnion`; auth `gateway` đã có, đủ cho DeepSeek qua API gateway. `task-run` chỉ phụ thuộc port `Harness` (do `cli` truyền vào, theo bảng 4 lớp), `harness` có trong `dependsOn` của `task-run`.

### Phân loại `agent-pack/`

| Thành phần | Trung lập | Chỉ dùng được với Claude Code | Ghi chú |
| --- | --- | --- | --- |
| `agent-pack/agents-md/` (rules theo role) | Có | | Markdown thuần; vào harness qua `AGENTS.md` hoặc nhúng vào prompt |
| `agent-pack/skill-library/` (skills) | | Có (hiện tại) | Định dạng skill của Claude Code, nạp qua `.claude/skills/`; chưa kiểm với harness khác |
| `agent-pack/hooks/` | | Có | Cơ chế hook `PreToolUse`/`SessionStart` của Claude Code; ranh giới an toàn vẫn do gate và CI kiểm độc lập với hook |
| `agent-pack/agents/` frontmatter `model`/`effort` | | Có | Tên model và effort theo Claude Code; harness khác ánh xạ qua profile |
| `agent-pack/agents/` thân prompt | Có | | Phần mô tả vai trò, không phụ thuộc harness |

### Harness thiếu capability

Harness thiếu capability mà step cần thì **không được âm thầm bỏ qua**. Có hai lựa chọn:

1. **Lỗi rõ ràng** (`OmiError` nêu harness, capability thiếu và step cần nó) trước khi chạy agent.
2. **Đường thay thế** khai báo trong adapter, ví dụ nhúng rule từ `agents-md/` vào prompt khi harness không có skills; thay thế được ghi vào kết quả step để audit.

Bản ghi step luôn nêu harness và capability đã dùng.

## Hệ quả

- ADR-0002 D1 được làm rõ bởi D3; `resources/role-rules/` trong ADR-0001 D3 được thay bởi `agent-pack/agents-md/` (D5).
- Các task còn lại của #321 (contract và check, agent, refactor từng module, docs) dựa vào ADR này. `docs/architecture/overview.md` chỉ thêm link ở task này; phần mô tả layout mới thuộc T5.
- Rủi ro: parser import chỉ hỗ trợ TS/JS ở bản đầu (D4); repo đích chưa có kiểm tra ở CI (follow-up ARC-003); skills hiện tại chưa dùng được ngoài Claude Code (D7).
- Ngoài phạm vi: scaffold theo stack khi bootstrap; hiện thực DeepSeek harness; thay đổi hành vi nghiệp vụ; gộp/xóa mô hình legacy/v2 (Feature-0042 #301).
