# ADR-0005 — Quy trình GitHub Project mới: issue type native, 10 status, 5 role agent, `omi sync`

- **Trạng thái:** Accepted. PO yêu cầu và duyệt hướng đi 2026-11-21 qua ChangeRequest-0013; điểm kỹ thuật đã kiểm chứng ở Spike-0012. Thay ADR-0001 D6 và phần status của ADR-0001 D7; làm rõ ADR-0003 D2. Triển khai ở Milestone-0013 #295 (Feature-0038 … Feature-0042).
- **Ngày:** 2026-11-21
- **Người quyết định:** Product Owner (qua phiên Coordinator)
- **Nguồn:** ChangeRequest-0013 (toàn văn `github-project-workflow.md` và bảng quyết định PO), Feature-0037 #296, DocumentationTask-0015 #303
- **Bằng chứng:** comment `omi:evidence` trên Spike-0012, từng API GitHub cần dùng

## Bối cảnh

Quy trình cũ dựa trên Issue Type có sẵn cộng label `type:<OMI type>` (ADR-0001 D6), Milestone dạng Issue, nhiều type riêng (Release, Spike, DevOpsTask, DocumentationTask) và bộ status nhỏ. PO muốn một quy trình gọn hơn: type native của GitHub, status có state machine khai báo, ít role agent hơn, và PO chỉ thao tác ở hai cổng `Awaiting PO` và `Acceptance`. Spike-0012 xác định API GitHub nào dùng được và API nào không có.

## Quyết định

| # | Chủ đề | Quyết định |
| --- | --- | --- |
| D1 | Issue type native | Dùng **8 issue type native của org**: `Doc`, `ADR`, `Epic`, `UserStory`, `DesignTask`, `DevTask`, `QATask`, `Bug`. Label `type:*` bị bỏ. **Thay ADR-0001 D6.** `omi github project init/apply` tạo/sửa type bằng `createIssueType`/`updateIssueType` (cần scope `admin:org`; tài khoản OMI `minibox-claude-code` là org owner từ 2026-11-21). `plan/validate` chỉ đọc và báo type thiếu; `omi doctor` kiểm scope `admin:org` khi cần tạo type. Không tự động xóa type. |
| D2 | 10 status và state machine | Project có **10 status**. Chuyển trạng thái do một **state machine khai báo** trong `workflow.yaml`: mỗi transition có `by: po\|coordinator\|auto`. `omi move` thực hiện một transition hợp lệ; `omi sync` đối soát GitHub với state machine tới **fixpoint** (lặp tới khi không còn transition `auto` nào áp dụng được). **Thay phần status của ADR-0001 D7**; các phần khác của D7 (Project #2 + Issues là nguồn duy nhất, bằng chứng bằng comment marker) giữ nguyên. Built-in workflow của Project không có API tắt, nên là bước thủ công có hướng dẫn. |
| D3 | Coordinator và agent ẩn | Coordinator chịu trách nhiệm các việc BA, Architect và DevOps. Việc nặng (PRD, Architecture, ADR) **vẫn chạy bằng agent ẩn qua `omi task analyze`**, không chạy trong phiên chính. **Làm rõ ADR-0003 D2**: Coordinator mỏng vẫn đúng; Coordinator sở hữu trách nhiệm và quyết định, không tự viết tài liệu nặng. |
| D4 | 5 role agent, reviewer trên PR | Bộ agent gồm **5 role**: Software-Engineer, QA-Engineer, UIUX-Designer, Code-Reviewer, Security-Reviewer. Reviewer làm việc trên PR; **CLI đăng PR review**, agent chỉ trả kết quả có cấu trúc. Cùng tài khoản không approve/request changes PR của chính mình (Spike-0012 #9), nên review đăng dạng `COMMENT` kèm marker `<!-- omi:review=… verdict=… -->`; `omi sync` đọc marker thay cho `reviewDecision`. |
| D5 | Vị trí cấu hình | `workflow.yaml` nằm trong plugin ở `config/github/`; ghi đè ở `<workspace>/.omi-plugins/omi.config.yaml`; snapshot lưu trong `state.sqlite`; ID (project, field, option, type) **đọc từ GitHub**, không ghi cứng. Repo đích không chứa `.omi/` hay `CLAUDE.md` (**giữ ADR-0002 D1**). |
| D6 | CI | CI = các check local của `omi` (`lint`, `typecheck`, `test`). **GitHub Actions chỉ bị cấm cho tự động hóa Project**; repo vẫn được có workflow CI riêng. |
| D7 | Type bị bỏ | Release → **GitHub Milestone**. Spike → DevTask kèm label `spike`. DevOpsTask và DocumentationTask → `DevTask`. |
| D8 | Phạm vi hỗ trợ | Chỉ hỗ trợ **organization** (issue type và Project cấp org). Tài khoản cá nhân không hỗ trợ. |
| D9 | Migration Project #2 | Project #2 của `omi-plugins` chuyển sang mô hình mới ở Feature-0042: tạo 8 type, đặt status mới, ánh xạ type cũ theo D7, gỡ label `type:*`, rồi phát hành 0.3.0. Chạy lại an toàn (read → diff → write theo ADR-0001). Chi tiết ở runbook của Feature-0042. |

## Giới hạn API (Spike-0012)

- Field Type trong Project, group/sort/cột của view và tắt built-in workflow **không có API**: bước thủ công có hướng dẫn trong `omi github project plan`; filter và layout view do `apply` đặt.
- Tạo issue type cần `admin:org` (xem D1).
- Reviewer cùng tài khoản không approve được PR (xem D4).

## Hệ quả

- ADR-0001 D6 bị thay bởi D1; phần status của ADR-0001 D7 bị thay bởi D2. ADR-0003 D2 được làm rõ bởi D3. ADR-0002 D1 giữ nguyên (D5).
- 11 role agent cũ rút còn 5 (D4); agent pack, workflow theo issue type và skill Coordinator cập nhật ở Feature-0040 và Feature-0041.
- Engine `omi move` / `sync` / `queue` / `inbox` ở Feature-0039; contract và cấu hình GitHub ở Feature-0038.
- Rủi ro: tài khoản OMI có quyền `admin:org` rộng hơn mức tối thiểu; marker review là quy ước, không phải cưỡng chế của GitHub; các bước thủ công (D1, giới hạn API) cần `omi doctor` báo rõ.
- Ngoài phạm vi: tài khoản cá nhân, điều khiển Project qua GitHub Actions.
