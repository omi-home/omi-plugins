# OMI Engineering Plugin

Plugin Claude Code (`omi-engineering`) và runtime cục bộ xác định cho quy trình Agile theo ticket: GitHub Issue/Project làm nguồn công việc, mỗi task một worktree, vòng review 2 + Architect + 2, báo cáo từng bước lên Issue và dọn tài nguyên sau merge.

> Trạng thái: **Phase 1 — đang dựng khung**. Chưa có CLI hay agent chạy được. Xem [lộ trình](./omi-plugins-roadmap.md).

## Yêu cầu

- Node ≥ 22.18 (đã kiểm thử trên v24), npm
- Git, GitHub CLI (`gh`), Claude Code ≥ 2.1.277 (đã kiểm chứng 2.1.325)

## Bắt đầu

```bash
git clone https://github.com/omi-home/omi-plugins.git
cd omi-plugins
npm ci
npm run check
```

## Tài liệu

- [Spec kiến trúc](./omi-plugins-idea.md) · [Lộ trình](./omi-plugins-roadmap.md)
- [Tổng quan kiến trúc & hợp đồng thư mục](./docs/architecture/overview.md)
- [ADR](./docs/decisions/)
- Hướng dẫn đóng góp cho agent và người: [AGENTS.md](./AGENTS.md)
- Quản lý task: [GitHub Project #2](https://github.com/orgs/omi-home/projects/2)
