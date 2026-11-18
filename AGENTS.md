# AGENTS.md — hướng dẫn phát triển OMI Engineering Plugin

File này là chỉ dẫn canonical cho mọi phiên Claude Code làm việc **trên chính repo này**. Không tạo `CLAUDE.md` (chỉ được thêm shim `@AGENTS.md` khi có quyết định tương thích được duyệt).

## Nguồn sự thật

- Spec và lộ trình: body các Issue trên Project #2 — gốc là [Epic-0001 #96](https://github.com/omi-home/omi-plugins/issues/96), section `spec §N` nằm trong Milestone tương ứng (chỉ mục: [docs/architecture/overview.md](./docs/architecture/overview.md)); phạm vi từng task nằm trong body Task. Quyết định: [docs/decisions/](./docs/decisions/)
- Task, trạng thái, bằng chứng: GitHub Project [#2](https://github.com/orgs/omi-home/projects/2) + Issues (ADR-0001 D7). Repo không chứa báo cáo hay tracking task.
- Body của Issue là tài liệu sống và context cho agent (yêu cầu, phạm vi, quyết định, kết quả as-built); `docs/` chỉ giữ overview, ADR, contract, runbook và link tới Issue — không chép lại chi tiết tính năng (spec §6 "Issue body as living documentation").
- Kiến trúc và hợp đồng thư mục: [docs/architecture/overview.md](./docs/architecture/overview.md)

## Quy trình bắt buộc

1. Mỗi thay đổi gắn với đúng **một** Issue thực thi trong Project #2.
2. Branch `<loại>/<issue>-<slug>` tạo từ `origin/develop` vừa fetch; làm việc trong worktree riêng ngoài checkout chính (`../.omi-worktrees/omi-plugins/<issue>/`). Không commit thẳng `main`/`develop`.
3. PR → `develop`, body có `Closes #<issue>`; release là PR `develop → main` kèm Release Issue.
4. Mỗi bước hoàn tất có một comment báo cáo trên Issue (role/model/effort/round/status; effort thực tế ghi `unknown`).
5. Sau merge: dọn worktree và branch local an toàn, không `--force`, không xóa branch remote tự động.
6. Status trên Project #2 không tự đổi: bắt đầu → In Progress, mở PR → In Review, merge + dọn → Done. Cập nhật luôn status cha: khi task con bắt đầu, Feature/Milestone cha đang Backlog/Ready → In Progress (`omi task start` tự làm theo chuỗi parent); Feature đóng + Done khi task con cuối cùng đóng; Milestone In Review trong lúc chạy gate, chỉ Done khi PO chấp nhận.
7. Finding hoặc giới hạn được hoãn sang task khác phải comment ngay lên Issue đích (marker `<!-- omi:carried-findings=<T-id> -->`, bảng nguồn · finding · việc cần làm), kiểm tra Issue đích trên cây Issue của Project #2 trước khi ghi. Khi bắt đầu task, đọc các comment này và đưa vào phạm vi.
8. Issue mới: title `<IssueType>-<NNNN>-<Tiêu đề>` — type viết đầy đủ dạng PascalCase, khớp label `type:*` (`Feature`, `DevTask`, `DocumentationTask`, `ChangeRequest`, `FunctionalRequirement`…), `NNNN` là số thứ tự 4 chữ số riêng theo type (lớn nhất hiện có + 1). Title và body viết tiếng Việt, thuật ngữ kỹ thuật/quy trình giữ tiếng Anh (Business, Definition of Done, Acceptance Criteria, reproduce…); heading section và marker `<!-- omi:… -->` giữ nguyên (spec §6).

## Lệnh

```bash
npm ci            # cài đặt
npm run check     # lint + typecheck + test (phải xanh trước khi mở PR)
npm run format    # tự sửa format/lint
OMI_LIVE=1 npm test  # thêm probe chạy agent thật (tốn token): canary rule pack, model quan sát được
node bin/omi doctor  # kiểm tra môi trường, AGENTS.md, .omi/config.yaml, GitHub (thêm --output json)
node bin/omi ticket validate <n>  # gate ticket-first cho Issue #n (chỉ đọc); `task start`/`task status` tạo/xem run + worktree
node bin/omi pr create <n> --body-file <f>  # push branch task, tạo/dùng lại PR → develop, kiểm base/head/Issue chính, In Review
node bin/omi issue create --type <t> --parent <n> --title <text> --body-file <f>  # tạo Issue đánh số theo type, gắn sub-issue + Project (chạy lại an toàn)
```

- Runtime TypeScript chạy trực tiếp bằng Node ≥ 22.18 (type stripping) — không có bước build. Chỉ dùng cú pháp TS xoá được (`erasableSyntaxOnly`), import kèm đuôi `.ts`.
- Test: `node:test` + `node:assert`, đặt ở `tests/<loại>/**/*.test.ts`.

## Quy tắc thiết kế

- **Script first:** Git/GitHub/state/report/cleanup đi qua CLI/thư viện xác định, không qua suy luận LLM.
- **Cách ly kiến thức chuyên môn (ADR-0001 D3):** nội dung chuyên môn chỉ nằm trong `resources/role-rules/<role>/`, không đăng ký thành skill. `skills/` chỉ chứa entry point của Coordinator. Agent đặt `disallowedTools: Skill`.
- **Adapter thực thi (D1):** OMI CLI khởi chạy agent bằng tiến trình riêng; cấm `isolation: 'worktree'`.
- Không tạo thư mục gốc mới khi chưa có ADR; không tạo thư mục rỗng/placeholder cho tính năng tương lai.
- **Contract có kiểu:** tên state/role/status chỉ lấy từ enum trong `runtime/core/contracts.ts` (zod), không viết chuỗi trần. Dữ liệu từ ngoài (agent, GitHub, config) phải qua `parseContract`; field lạ bị từ chối; lỗi dùng `OmiError` với mã trong `runtime/core/errors/`; mọi thứ ra ngoài process đi qua `redact`.
- Không đoán API của Claude Code/GitHub: chỉ dùng những gì đã kiểm chứng (Phase 0) hoặc kiểm chứng trước khi dùng.
- Không ghi token/secret vào log, comment hay file commit.
