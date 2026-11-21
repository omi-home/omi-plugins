# Changelog

Mọi thay đổi đáng kể của plugin `omi-coordinator` (trước 0.2.0: `omi-engineering`) ghi ở đây. Định dạng theo [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), version theo [Semantic Versioning](https://semver.org/). Mỗi release là tag `omi-coordinator--v<version>` trên `main` (`omi release tag`; bản 0.1.0: `omi-engineering--v0.1.0`); chi tiết từng thay đổi nằm trong Issue/PR được link.

## [Unreleased]

### Added

- `omi config get|set`: validated, comment-preserving, atomic edits of `omi.config.yaml` (`--if-match`, `--confirm-commands` for `checks`/`setup`; errors `CONFIG_INVALID`, `CONFIG_CONFLICT`, `POLICY_VIOLATION`) — DevTask-0095 #284.
- `--output json` envelope carries `protocolVersion` (`MONITOR_PROTOCOL_VERSION`, bump rules in `runtime/monitor/protocol.ts`); JSON Schemas for omi-monitor in `schemas/monitor/` (a test fails on drift; regenerate with `npm run schemas:monitor`).

- Architecture check in the gate: new `GateCheck` `architecture` (order format, lint, architecture, build, test, scan), runs `omi arch check` when the worktree has a contract and `checks.architecture` is not configured, `skipped` without a contract; `omi doctor` check `architecture` (`CONTRACT_INVALID`, `ARCH_VIOLATION`, warn for missing contract or remaining `legacy`); `OmiConfig.architecture.contract` (default `omi-architecture.yaml`) — DevTask-0106 #327.
- Monitor schema change (additive only, regenerated with `npm run schemas:monitor`): `architecture` in `OmiConfig.schema.json` and `ConfigSetData.schema.json`, `checks.architecture` in the same files — DevTask-0106 #327.

### Fixed

- Without `--profile`, `agents.routing[role]` now decides the `--model`/`--effort` each step runs with (agent frontmatter is only the default, matching the schema default), and the step report records the values actually passed — DevTask-0082 #250, Bug-0005 #245.

## [0.2.0] - 2026-11-19

Gồm Milestone-0009 #136 và Milestone-0010 #182 trên [Project #2](https://github.com/orgs/omi-home/projects/2). **Breaking:** đổi tên plugin, layout workspace mới, bỏ rule pack (xem Changed/Removed); repo dùng 0.1.0 chuyển theo [runbook chuyển đổi](./docs/runbooks/workspace-migration.md).

### Added

- Workspace của Coordinator và task workspace bằng clone: `omi workspace init|migrate`, config và state trong `<workspace>/.omi-plugins/`, auto memory trong workspace (Feature-0024 #156, ADR-0002).
- Profile thực thi Claude Code: `omi.config.json`, `omi profile list`, chọn profile/model/effort cho từng step, đổi profile khi hết quota giữa chừng, `omi doctor --probe` (Feature-0021 #137); interface Harness cho nhiều nền tảng agent (Feature-0022 #138).
- `omi context plan|apply`: đo, phân loại và tắt context không cần lúc bắt đầu phiên (Feature-0028 #189).
- Usage theo run/step (token, chi phí, thời gian) hiển thị trong `omi status` (Feature-0029 #190).
- Thư viện skill trong `agent-pack/skill-library/`, tập skill mặc định/được phép theo role, `task run|analyze --skills` + `omi skill list`; chỉ cài skill của step vào task workspace (Feature-0027 #188).
- Rules `AGENTS.md` sinh theo role và hook `PreToolUse` của agent chặn `git push`, `gh`, ghi ra ngoài task workspace (Feature-0027 #188); hook Coordinator `PreToolUse` + `SessionStart`, skill `/omi-plan` (Feature-0026 #187).
- `omi task finalize` cho task không có code (Spike).

### Changed

- Plugin `omi-engineering` tách thành `omi-coordinator` (cài một lần trong workspace) mang theo gói agent `agent-pack/` (Feature-0026 #187, ADR-0003).
- Agent chạy như phiên Claude Code đầy đủ trong task workspace, xác thực bằng `CLAUDE_CODE_OAUTH_TOKEN` (ADR-0002).

### Removed

- `resources/role-rules/`, `omi:rule-pack` và code chép rule pack (thay bằng skill + rules theo role, ADR-0003).
- `.omi/` và `AGENTS.md` trong repo sản phẩm: chuyển sang workspace (ADR-0002 D1).

### Fixed

- Roll-up không đóng Feature khi Scope / Acceptance còn ô chưa tick (Bug-0001 #162).
- Mở state database song song trên Windows không còn fail `LOCK_HELD` (Bug-0002 #165).
- Đọc `thinking_tokens` từ `usage.output_tokens_details`.

## [0.1.0] - 2026-11-18

Bản phát hành đầu tiên, gồm Milestone-0001 → Milestone-0008 trên [Project #2](https://github.com/orgs/omi-home/projects/2).

### Added

- Plugin Claude Code `omi-engineering` + marketplace một-plugin (`.claude-plugin/`), 11 agent specialist với rule pack cách ly trong `resources/role-rules/` (Milestone-0002 #13, Milestone-0006 #47).
- CLI `omi` xác định: `doctor`, `ticket validate`, `task start|run|analyze|unblock|finalize`, `pr create|validate|merge`, `cleanup scan|apply`, `issue create|depend|findings|section`, `handoff`, `status` (Milestone-0003 #21, Milestone-0005 #39).
- Vòng review 2 + Architect + 2 có audit, báo cáo từng bước lên Issue qua outbox SQLite (Milestone-0004 #30).
- GitHub Projects as Code: `github project init|plan|apply|validate`, `github repo plan|apply|validate`, Issue Forms và PR template (Milestone-0007 #57).
- Release: `omi release check|tag`, skill `omi-release`, CI `check` trên Linux và Windows × Node 22.18/24; macOS chưa kiểm chứng (Milestone-0008 #64, DevTask-0036 #71).
