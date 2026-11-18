# OMI Engineering Plugin

Plugin Claude Code (`omi-engineering`) và runtime cục bộ xác định cho quy trình Agile theo ticket: GitHub Issue/Project làm nguồn công việc, mỗi task một worktree, vòng review 2 + Architect + 2, báo cáo từng bước lên Issue và dọn tài nguyên sau merge.

> Có gì trong từng bản: [CHANGELOG](./CHANGELOG.md). Trạng thái và lộ trình: cây Issue trên [GitHub Project #2](https://github.com/orgs/omi-home/projects/2).

## Support matrix

| Thành phần | Hỗ trợ | Kiểm chứng |
|---|---|---|
| Node | ≥ 22.18 (type stripping) | CI: 22.18.0 và 24 |
| OS | Linux, macOS, Windows | CI cả 3; WSL chưa kiểm chứng |
| Claude Code | ≥ 2.1.277 (đọc AGENTS.md native) | 2.1.325 |
| Git, `gh` | bản hiện hành; `gh` đã `auth login` với scope `repo`, `project` | git 2.55, gh 2.100 |
| GitHub | Free/Team; repo public khuyến nghị — private trên Free không có bảo vệ branch phía server | org `omi-home`, gói Free |

`omi doctor` kiểm tra version công cụ, đăng nhập và quyền GitHub trên máy của bạn. Giới hạn và cách vận hành: [runbook](./docs/runbooks/operations.md).

## Bắt đầu (contributor)

```bash
git clone https://github.com/omi-home/omi-plugins.git
cd omi-plugins
npm ci
npm run check        # lint + typecheck + test, phải xanh
node bin/omi doctor  # môi trường, AGENTS.md, .omi/config.yaml, quyền GitHub
```

Một thay đổi đi theo đúng quy trình trong [AGENTS.md](./AGENTS.md):

1. Chọn một Issue thực thi trên [Project #2](https://github.com/orgs/omi-home/projects/2) (hoặc tạo bằng `node bin/omi issue create`), kiểm bằng `node bin/omi ticket validate <n>` và đọc `node bin/omi issue findings <n>`.
2. `node bin/omi task start <n>` — branch `<loại>/<n>-<slug>` từ `origin/develop` và worktree riêng trong `../.omi-worktrees/omi-plugins/<n>/`; làm việc trong worktree đó.
3. Code + test (`tests/<loại>/**/*.test.ts`, `node:test`), `npm run check` xanh, commit.
4. `node bin/omi pr create <n> --body-file <f>` — PR → `develop` có `Closes #<n>`; comment báo cáo bước lên Issue.
5. Sau merge: `git pull` trong checkout chính, `node bin/omi task finalize <n>` — dọn worktree/branch an toàn, Done.

Kẹt ở đâu: [runbook — escalation và khôi phục](./docs/runbooks/operations.md#6-escalation-và-khôi-phục).

## Cài plugin

Repo này đồng thời là marketplace một-plugin (`.claude-plugin/marketplace.json`, `source: "./"`). Mỗi release là tag `omi-engineering--v<version>` trên `main` (xem [CHANGELOG](./CHANGELOG.md)); ghim marketplace vào tag để có bản cố định:

```bash
claude plugin marketplace add omi-home/omi-plugins#omi-engineering--v0.1.0
claude plugin install omi-engineering@omi-plugins   # --scope project để chia sẻ qua .claude/settings.json
```

Không có `#<tag>` thì marketplace theo branch mặc định (`develop`, chưa phát hành). Máy không có SSH key GitHub: đặt `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`.

- **Update:** marketplace ghim theo tag không tự lên bản mới. Đổi tag: `claude plugin marketplace remove omi-plugins`, `add` lại với `#omi-engineering--v<mới>`, `install` lại, rồi khởi động lại Claude Code.
- **Rollback:** như update, với tag cũ. State cục bộ (`<git-common-dir>/omi/state.sqlite`) chỉ migrate tiến và bản cũ từ chối DB mới hơn ("upgrade OMI"): sao lưu file đó trước khi update, khôi phục bản sao lưu khi lùi qua một migration.

Thử plugin từ source cục bộ không cần cài: `claude --plugin-dir .`. Kiểm tra manifest: `claude plugin validate .claude-plugin/plugin.json --strict` (đã nằm trong `npm test`, tự skip khi không có `claude`).

## Tài liệu

- Spec và lộ trình: body các Issue trên [GitHub Project #2](https://github.com/orgs/omi-home/projects/2), bắt đầu từ [Epic-0001 #96](https://github.com/omi-home/omi-plugins/issues/96); chỉ mục trong [overview](./docs/architecture/overview.md)
- [Tổng quan kiến trúc & hợp đồng thư mục](./docs/architecture/overview.md)
- [ADR](./docs/decisions/)
- [Runbook vận hành](./docs/runbooks/operations.md): cấu hình, quyền GitHub, giới hạn Free, escalation, recovery, rate limit, xoá an toàn, release
- Hướng dẫn đóng góp cho agent và người: [AGENTS.md](./AGENTS.md)
- Quản lý task: [GitHub Project #2](https://github.com/orgs/omi-home/projects/2)

## License

[MIT](./LICENSE)
