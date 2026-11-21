# Runbook thiết lập Project theo mô hình v2

Thiết lập một repository và GitHub Project theo mô hình v2 ([ADR-0005](../decisions/ADR-0005-quy-trinh-github-project-moi.md); Feature-0038 [#297](https://github.com/omi-home/omi-plugins/issues/297); DocumentationTask-0016 [#312](https://github.com/omi-home/omi-plugins/issues/312)). Runbook chỉ giữ thứ tự thao tác và cách kiểm tra; chi tiết mô hình (8 issue type, 10 status, state machine) nằm trong ADR-0005 và Issue, cấu hình nằm trong `config/github/`. Khi lệnh in hướng dẫn khác runbook này, lệnh thắng.

## 1. Điều kiện

- Owner của repo là **organization**. Tài khoản cá nhân bị từ chối (issue type native chỉ có ở org).
- Đã có workspace (`omi workspace init`, xem [overview](../architecture/overview.md#workspace-và-task-workspace)); chạy `omi` trong checkout `<name>-workspace/<repo>/`.
- Token của `gh` có scope **`admin:org`** (tạo/sửa issue type) và **`project`** (field, view). Thiếu `admin:org` thì lệnh bị từ chối trước khi ghi gì:

  ```bash
  gh auth refresh -s admin:org -s project
  ```

- Người dùng token có quyền ghi Project (admin hoặc write); thiếu thì `apply` báo `GITHUB_AUTH`.
- Không đọc được scope (token fine-grained/app) thì CLI không kiểm trước được; lỗi nếu có đến từ GitHub.

## 2. Đặt `github.model: v2`

Mặc định là `legacy` (label `type:*`). Trong `<name>-workspace/.omi-plugins/omi.config.yaml`:

```yaml
github:
  model: v2
```

`omi github project init` không ghi khoá `model`; đặt nó **trước** `init` để `init` tạo issue type. Muốn đổi state machine, ghi đè tại khoá `github.workflow` (được kiểm khi nạp config; mặc định `config/github/workflow.yaml`).

## 3. Thiết lập bằng CLI

Chạy theo thứ tự:

```bash
omi github project init [--title <text>]   # tìm hoặc tạo Project, link repo, ghi config, cài template .github/, tạo 8 issue type ở org
omi github project plan                    # chỉ đọc: field, view, issue type, workflow built-in còn lệch
omi github project apply                   # tạo field/option/view/issue type còn thiếu, đặt filter + layout view
omi github project validate                # cùng diff dưới dạng check
```

Quy tắc chung: chạy lại an toàn (không đổi gì khi đã đúng), không bao giờ xoá field, view hay issue type, không ghi đè file template đã có.

- `init`: tạo/cập nhật 8 issue type của org (`Doc`, `ADR`, `Epic`, `UserStory`, `DesignTask`, `DevTask`, `QATask`, `Bug`); Project mặc định đặt tên theo repo.
- `plan`: thoát `1` khi còn việc cần làm, bước thủ công hoặc lệch. Đọc `project-v2.yaml` (Status 10 option, Priority P0–P2, Story Type, Severity, Start, Target), `views-v2.yaml` (7 view) và `issue-types.yaml`; liệt kê từng workflow built-in đang bật.
- `apply`: thoát `1` khi sau khi ghi vẫn còn bước thủ công; đó là kết quả bình thường ở lần chạy đầu, làm tiếp mục 4.
- `validate`: `fields`, `issue-types`, `views`, `workflows`, `status-drift` phải `pass`; phần không có API gộp thành một cảnh báo `manual-steps` (không làm fail).

Label cờ của repo (`ui`, `security`, `needs-po`, `superseded`) đi qua `omi github repo plan` → `apply --approved-plan <file>` → `validate` (xem skill `omi-start`).

## 4. Bước thủ công (không có API)

Làm trong giao diện Project, sau `apply`. Mỗi mục đã làm xong thì `plan` thôi báo (trừ mục `Fields` của view: không đọc lại được, `plan` luôn in).

1. **Field `Type`** (và `Parent issue`, `Sub-issues progress` nếu `plan` báo `field <tên>: add it to the Project in the UI`): Project → `+` ở đầu bảng → bật field. View lọc `type:...` cần field này.
2. **Group by, sort, cột board** của từng view (`plan` in dòng `manual` cho đến khi khớp `views-v2.yaml`):

   | View | Group by | Sort | Cột board |
   |---|---|---|---|
   | 🗺 Roadmap | Milestone | | |
   | 📥 PO Inbox | | Type asc | |
   | 📖 Stories | | | Status |
   | 📋 Work Board | Type | | |
   | 🐞 Bugs | | Severity asc, Priority asc | |
   | 📚 Knowledge | Type | | |
   | 🌳 Tree | Parent issue | | |

   Filter và layout do `apply` đặt; không sửa tay.
3. **Field hiển thị** (`show`): 🗺 Roadmap hiện Start, Target, Sub-issues progress; 📖 Stories hiện Story Type, Sub-issues progress. Project → view → Fields.
4. **Tắt mọi workflow built-in**: Project → `…` → Workflows, tắt Auto-add, Item added, Item closed, Item reopened, Pull request merged, Auto-close, Auto-archive. `omi` là nơi duy nhất ghi Status; workflow bật sẽ ghi đè state machine. `plan` báo từng workflow còn bật, kể cả tên không có trong danh sách này.
5. **Hai view trùng tên**: nếu `plan` báo `N views share this name`, xoá bản thừa trong UI (CLI không xoá).

## 5. Kiểm tra lại

```bash
omi github project plan       # mong đợi: không còn dòng pending/manual, thoát 0
omi github project validate   # mong đợi: mọi check pass; chỉ còn cảnh báo manual-steps (show) và extra
omi github repo validate
omi doctor                    # scope admin:org và quyền Project
```

`plan` thoát `0` nghĩa là field, view (filter/layout/group/sort/cột), issue type và workflow đã khớp. Cảnh báo `manual-steps` còn lại chỉ gồm các mục không đọc lại được (field hiển thị của view) hoặc built-in field đã thêm; tự kiểm bằng mắt trong UI.

Sửa một bước thủ công xong thì chạy lại `plan`; lệch tới đâu in tới đó. Muốn quay về trạng thái mong muốn của field/view/issue type thì chạy lại `apply`.

## 6. Sự cố thường gặp

| Triệu chứng | Cách xử lý |
|---|---|
| Lỗi nhắc `admin:org` | `gh auth refresh -s admin:org`, chạy lại |
| Tài khoản cá nhân bị từ chối | Chuyển repo vào organization; mô hình v2 chỉ hỗ trợ org |
| `GITHUB_AUTH` no write access to Project | Cấp quyền ghi Project cho tài khoản, hoặc `gh auth refresh -s project` |
| `CONFIG_INVALID` Project not found | `projectNumber` trong config sai hoặc Project đã bị xoá; kiểm `omi.config.yaml` |
| `plan` vẫn báo workflow sau khi tắt | Tải lại trang Workflows để chắc đã lưu, chạy lại `plan` |
