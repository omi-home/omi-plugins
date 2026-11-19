# OMI Engineering Plugin

Plugin Claude Code (`omi-coordinator`, mang theo gói agent `omi-engineering` trong `agent-pack/`) và runtime cục bộ xác định cho quy trình Agile theo ticket: GitHub Issue/Project làm nguồn công việc, mỗi task một task workspace (clone riêng), vòng review 2 + Architect + 2, báo cáo từng bước lên Issue và dọn tài nguyên sau merge.

> Có gì trong từng bản: [CHANGELOG](./CHANGELOG.md). Trạng thái và lộ trình: cây Issue trên [GitHub Project #2](https://github.com/orgs/omi-home/projects/2).

## Support matrix

| Thành phần | Hỗ trợ | Kiểm chứng |
|---|---|---|
| Node | ≥ 22.18 (type stripping) | CI: 22.18.0 và 24 |
| OS | Linux, Windows | CI: ubuntu-latest, windows-latest; **macOS chưa kiểm chứng**, WSL chưa kiểm chứng |
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
node bin/omi doctor  # môi trường, AGENTS.md, `.omi-plugins/omi.config.yaml` của workspace, quyền GitHub
```

Repo không chứa chỉ dẫn hay config OMI (ADR-0002 D1). Dựng workspace bằng `node bin/omi workspace init` (hoặc `workspace migrate` từ layout cũ, xem [runbook chuyển đổi](./docs/runbooks/workspace-migration.md)): `omi-plugins-workspace/` cạnh repo, chứa `AGENTS.md` (chỉ dẫn Coordinator + quy trình phát triển repo này), `.claude/`, `.omi-plugins/` và clone `omi-plugins/`. Mở Claude Code ở `omi-plugins-workspace/`, chạy `npm`/`node bin/omi` trong `omi-plugins-workspace/omi-plugins/`.

Một thay đổi đi theo đúng quy trình trong `AGENTS.md` của workspace:

1. Chọn một Issue thực thi trên [Project #2](https://github.com/orgs/omi-home/projects/2) (hoặc tạo bằng `node bin/omi issue create`), kiểm bằng `node bin/omi ticket validate <n>` và đọc `node bin/omi issue findings <n>`.
2. `node bin/omi task start <n>` — task workspace `<workspace>-task-<run>/omi-plugins/`: clone của repo trên branch `<loại>/<n>-<slug>` cắt từ `origin/develop` vừa fetch; làm việc trong clone đó.
3. Code + test (`tests/<loại>/**/*.test.ts`, `node:test`), `npm run check` xanh, commit.
4. `node bin/omi pr create <n> --body-file <f>` — PR → `develop` có `Closes #<n>`; comment báo cáo bước lên Issue.
5. Sau merge: `git pull` trong checkout chính, `node bin/omi task finalize <n>` — dọn task workspace an toàn (chỉ khi receipt merge khớp tip của clone), Done.

Kẹt ở đâu: [runbook — escalation và khôi phục](./docs/runbooks/operations.md#6-escalation-và-khôi-phục).

## Cài plugin

Repo này đồng thời là marketplace một-plugin (`.claude-plugin/marketplace.json`, `source: "./"`). Mỗi release là tag `<plugin>--v<version>` (từ bản sau 0.1.0: `omi-coordinator--v<version>`) trên `main` (xem [CHANGELOG](./CHANGELOG.md)); ghim marketplace vào tag để có bản cố định:

```bash
claude plugin marketplace add omi-home/omi-plugins#omi-engineering--v0.1.0
claude plugin install omi-coordinator@omi-plugins --scope project   # cài trong workspace; agent-pack đi kèm, không cài riêng
```

Không có `#<tag>` thì marketplace theo branch mặc định (`develop`, chưa phát hành). Máy không có SSH key GitHub: đặt `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`.

- **Update:** marketplace ghim theo tag không tự lên bản mới. Đổi tag: `claude plugin marketplace remove omi-plugins`, `add` lại với `#omi-coordinator--v<mới>`, `install` lại, rồi khởi động lại Claude Code.
- **Rollback:** như update, với tag cũ. State cục bộ (`<workspace>/.omi-plugins/state.sqlite`) chỉ migrate tiến và bản cũ từ chối DB mới hơn ("upgrade OMI"): sao lưu file đó trước khi update, khôi phục bản sao lưu khi lùi qua một migration.

Thử plugin từ source cục bộ không cần cài: `claude --plugin-dir .`. Kiểm tra manifest: `claude plugin validate .claude-plugin/plugin.json --strict` (đã nằm trong `npm test`, tự skip khi không có `claude`).

## Tài liệu

- Spec và lộ trình: body các Issue trên [GitHub Project #2](https://github.com/orgs/omi-home/projects/2), bắt đầu từ [Epic-0001 #96](https://github.com/omi-home/omi-plugins/issues/96); chỉ mục trong [overview](./docs/architecture/overview.md)
- [Tổng quan kiến trúc & hợp đồng thư mục](./docs/architecture/overview.md)
- [ADR](./docs/decisions/)
- [Runbook vận hành](./docs/runbooks/operations.md): cấu hình, quyền GitHub, xác thực agent, giới hạn Free, escalation, recovery, rate limit, xoá an toàn, release
- [Runbook chuyển sang layout workspace](./docs/runbooks/workspace-migration.md): từ `.omi/` + worktree sang workspace
- Hướng dẫn đóng góp cho agent và người: `AGENTS.md` của workspace (`omi-plugins-workspace/AGENTS.md`)
- Quản lý task: [GitHub Project #2](https://github.com/orgs/omi-home/projects/2)

## License

[MIT](./LICENSE)
