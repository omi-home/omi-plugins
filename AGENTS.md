# AGENTS.md — hướng dẫn phát triển OMI Engineering Plugin

File này là chỉ dẫn canonical cho mọi phiên Claude Code làm việc **trên chính repo này**. Không tạo `CLAUDE.md` (chỉ được thêm shim `@AGENTS.md` khi có quyết định tương thích được duyệt).

## Nguồn sự thật

- Spec: [omi-plugins-idea.md](./omi-plugins-idea.md) · Lộ trình: [omi-plugins-roadmap.md](./omi-plugins-roadmap.md) · Quyết định: [docs/decisions/](./docs/decisions/)
- Task, trạng thái, bằng chứng: GitHub Project [#2](https://github.com/orgs/omi-home/projects/2) + Issues (ADR-0001 D7). Repo không chứa báo cáo hay tracking task.
- Kiến trúc và hợp đồng thư mục: [docs/architecture/overview.md](./docs/architecture/overview.md)

## Quy trình bắt buộc

1. Mỗi thay đổi gắn với đúng **một** Issue thực thi trong Project #2.
2. Branch `<loại>/<issue>-<slug>` tạo từ `origin/develop` vừa fetch; làm việc trong worktree riêng ngoài checkout chính (`../.omi-worktrees/omi-plugins/<issue>/`). Không commit thẳng `main`/`develop`.
3. PR → `develop`, body có `Closes #<issue>`; release là PR `develop → main` kèm Release Issue.
4. Mỗi bước hoàn tất có một comment báo cáo trên Issue (role/model/effort/round/status; effort thực tế ghi `unknown`).
5. Sau merge: dọn worktree và branch local an toàn, không `--force`, không xóa branch remote tự động.

## Lệnh

```bash
npm ci            # cài đặt
npm run check     # lint + typecheck + test (phải xanh trước khi mở PR)
npm run format    # tự sửa format/lint
OMI_LIVE=1 npm test  # thêm probe chạy agent thật (tốn token): canary rule pack, model quan sát được
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
