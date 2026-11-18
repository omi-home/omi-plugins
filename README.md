# OMI Engineering Plugin

Plugin Claude Code (`omi-engineering`) và runtime cục bộ xác định cho quy trình Agile theo ticket: GitHub Issue/Project làm nguồn công việc, mỗi task một worktree, vòng review 2 + Architect + 2, báo cáo từng bước lên Issue và dọn tài nguyên sau merge.

> Trạng thái: **Phase 1 — đang dựng khung**. Có agent đầu tiên `backend-engineer` với rule pack trong `resources/`; chưa có CLI. Lộ trình: cây Issue trên [GitHub Project #2](https://github.com/orgs/omi-home/projects/2).

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

## Cài plugin

Repo này đồng thời là marketplace một-plugin (`.claude-plugin/marketplace.json`, `source: "./"`). Mỗi release là tag `omi-engineering--v<version>` trên `main` (xem [CHANGELOG](./CHANGELOG.md)); ghim marketplace vào tag để có bản cố định:

```bash
claude plugin marketplace add omi-home/omi-plugins#omi-engineering--v0.1.0
claude plugin install omi-engineering@omi-plugins   # --scope project để chia sẻ qua .claude/settings.json
```

Không có `#<tag>` thì marketplace theo branch mặc định (`develop`, chưa phát hành). Máy không có SSH key GitHub: đặt `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`.

- **Update:** marketplace ghim theo tag không tự lên bản mới. Đổi tag: `claude plugin marketplace remove omi-plugins`, `add` lại với `#omi-engineering--v<mới>`, `install` lại, rồi khởi động lại Claude Code.
- **Rollback:** như update, với tag cũ. State cục bộ (`<git-common-dir>/omi/state.sqlite`) chỉ migrate tiến và bản cũ từ chối DB mới hơn ("upgrade OMI"): sao lưu file đó trước khi update, khôi phục bản sao lưu khi lùi qua một migration.

Đã kiểm chứng (Claude Code 2.1.325, config cô lập, DevTask-0035 #70): cài từ tag, lên tag mới, lùi về tag cũ; `omi version` chạy từ cache plugin.

Thử plugin từ source cục bộ không cần cài: `claude --plugin-dir .`. Kiểm tra manifest: `claude plugin validate .claude-plugin/plugin.json --strict` (đã nằm trong `npm test`, tự skip khi không có `claude`).

## Tài liệu

- Spec và lộ trình: body các Issue trên [GitHub Project #2](https://github.com/orgs/omi-home/projects/2), bắt đầu từ [Epic-0001 #96](https://github.com/omi-home/omi-plugins/issues/96); chỉ mục trong [overview](./docs/architecture/overview.md)
- [Tổng quan kiến trúc & hợp đồng thư mục](./docs/architecture/overview.md)
- [ADR](./docs/decisions/)
- Hướng dẫn đóng góp cho agent và người: [AGENTS.md](./AGENTS.md)
- Quản lý task: [GitHub Project #2](https://github.com/orgs/omi-home/projects/2)

## License

[MIT](./LICENSE)
