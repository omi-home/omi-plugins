# Tổng quan kiến trúc

Tổng quan và chỉ mục. **Nguồn sự thật là body của các Issue trên [GitHub Project #2](https://github.com/orgs/omi-home/projects/2)** (spec §6 "Issue body as living documentation", D6.3 #94); `docs/` chỉ giữ overview, ADR, contract, runbook và link. Khi mâu thuẫn, Issue và [ADR](../decisions/) thắng.

## Chỉ mục spec

Ký hiệu `spec §N` (trong code, ADR, Issue) trỏ tới section `§N` trong phần `Specification` của Issue sau. Cây Issue (Epic → Milestone → Feature → Task) thay cho roadmap; phạm vi từng task nằm trong body Task đó.

| spec § | Nội dung | Issue |
|---|---|---|
| §0–§2, §9, §15, §16, §20–§22 | quyết định cố định, mục tiêu, mô hình tương tác, script-first, bảo mật, workflow mẫu, giả định, quy tắc triển khai, tham chiếu; roadmap: cách dùng, milestone, work unit/branch/PR, rủi ro | [Epic-0001 #96](https://github.com/omi-home/omi-plugins/issues/96) |
| §17 | Phase 0 spike GO/NO-GO | [Milestone-0001 #1](https://github.com/omi-home/omi-plugins/issues/1) |
| §7, §8, §13 | branch/worktree, gate ticket-first, storage/resume | [Milestone-0003 #21](https://github.com/omi-home/omi-plugins/issues/21) |
| §10, §11, §12 | FSM workflow, handoff contract, step report/comment | [Milestone-0004 #30](https://github.com/omi-home/omi-plugins/issues/30) |
| §14 | cleanup và vòng đời tài nguyên | [Milestone-0005 #39](https://github.com/omi-home/omi-plugins/issues/39) |
| §3, §4 | role/model policy, cách ly kiến thức | [Milestone-0006 #47](https://github.com/omi-home/omi-plugins/issues/47) |
| §6 | GitHub Projects, governance, Issue body là tài liệu, quy tắc title | [Milestone-0007 #57](https://github.com/omi-home/omi-plugins/issues/57) |
| §18, §19 | testing, delivery; E2E scenario, release checklist | [Milestone-0008 #64](https://github.com/omi-home/omi-plugins/issues/64) |
| §5 | layout repository plugin | file này, mục "Layout đầy đủ" |

## Các lớp

| Lớp | Trách nhiệm | Trạng thái gốc |
|---|---|---|
| Phiên Claude chính (Coordinator/PM/SM) | hiểu ý định, chọn workflow, giao tiếp PO | hội thoại |
| Plugin Claude Code | agent chuyên môn, skill entry của Coordinator, hooks (workflow tuỳ chọn sẽ bỏ, ADR-0003 D7) | mã nguồn plugin |
| Runtime OMI (`runtime/`, `bin/omi`) | FSM, policy, ticket, task workspace, báo cáo GitHub, cleanup | SQLite cục bộ |
| GitHub Project + Issues | cây công việc, trạng thái, PR, comment audit | GitHub |
| CI / hooks | kiểm tra độc lập với agent | bằng chứng CI |

Luồng chính ([ADR-0002](../decisions/ADR-0002-workspace-va-profile-thuc-thi-claude-code.md) D2/D4/D5): Coordinator → `omi` CLI → `claude -p --agent omi-engineering:<role>` với cwd = task workspace, `--plugin-dir <plugin>`, `CLAUDE_CONFIG_DIR` riêng mỗi lần chạy và env dựng từ allowlist → kết quả có cấu trúc → CLI lưu SQLite và đăng comment. Rules của role đến qua `AGENTS.md`, skill của step qua `.claude/skills/` mà CLI sinh trong task workspace (DevTask-0065 #199). Kiến trúc đích ([ADR-0003](../decisions/ADR-0003-rules-skills-hooks-va-coordinator-mong.md), Milestone-0010 #182): Coordinator mỏng chỉ điều phối; một plugin `omi-coordinator` chứa `agent-pack/` chạy bằng `--plugin-dir <plugin root>/agent-pack`; CLI chỉ chép skill Coordinator chọn từ `agent-pack/skill-library/` vào `.claude/skills/` của task workspace; hooks chặn cứng; bỏ workflows. Profile thực thi (auth/model/effort theo profile) thuộc Feature-0021 #137; tới khi có, agent xác thực bằng `CLAUDE_CODE_OAUTH_TOKEN` của host.

**OMI Monitor** ([ADR-0004](../decisions/ADR-0004-omi-monitor-hai-repo-profile-va-token-ma-hoa.md)): web app local ở repo riêng `omi-home/omi-monitor`, chỉ là giao diện. Đọc qua `omi watch --output jsonl`, ghi qua CLI `--output json`, không mở `state.sqlite`; phân phối bằng `omi web` với bản `.tar.gz` ghim trong `config/web.json`. Profile nằm trong `state.sqlite`, token mã hóa AES-256-GCM bằng master key từ biến môi trường (thay ADR-0002 D6).

**Quy trình GitHub Project mới** ([ADR-0005](../decisions/ADR-0005-quy-trinh-github-project-moi.md), Milestone-0013 #295): 8 issue type native thay label `type:*` (thay ADR-0001 D6); 10 status với state machine khai báo trong `workflow.yaml` (`by: po|coordinator|auto`) và `omi sync` đối soát tới fixpoint (thay phần status của ADR-0001 D7); 5 role agent, reviewer làm việc trên PR và CLI đăng PR review; Coordinator chịu trách nhiệm BA/Architect/DevOps, việc nặng vẫn chạy agent ẩn qua `omi task analyze` (làm rõ ADR-0003 D2); chỉ hỗ trợ organization. Thiết lập một repo theo mô hình này: [runbook Project v2](../runbooks/github-project-v2-setup.md). Các mục trên về role/agent và status mô tả bộ cũ cho tới khi Feature-0039–0042 hoàn tất.

**Kiến trúc feature module** ([ADR-0006](../decisions/ADR-0006-kien-truc-feature-module-va-contract.md), Feature-0043 #321): runtime chia theo chức năng với 4 lớp và contract kiến trúc kiểm tự động.

## Hợp đồng thư mục gốc

Chỉ các thư mục sau được phép ở gốc repo. Thêm thư mục gốc mới cần ADR và cập nhật `ALLOWED_ROOT_DIRS` trong [tests/unit/workspace/directory-contract.test.ts](../../tests/unit/workspace/directory-contract.test.ts) — test này chặn mọi thư mục ngoài danh sách.

| Thư mục | Chủ sở hữu | Nội dung |
|---|---|---|
| `.claude-plugin/` | Claude Code | `plugin.json`, `marketplace.json` |
| `agent-pack/` | Claude Code | plugin `omi-engineering` lồng trong plugin `omi-coordinator` (ADR-0003 D3, DevTask-0059 #192): `agents/` (11 agent chuyên môn, mỗi agent khai báo tập skill `omi:skills`), `skill-library/` (33 skill theo Spike-0011 #196, DevTask-0063 #197; CLI chỉ chép skill của step vào `.claude/skills/` của task workspace, `omi skill list`, `task run --skills` — DevTask-0065 #199; nguồn ngoài ghi trong `THIRD_PARTY_NOTICES`), `agents-md/` (phần của `AGENTS.md` theo role: DoD, ranh giới, format REPORT; DevTask-0064 #198), `hooks/` (chặn `git push`, `gh`, ghi ra ngoài task workspace); CLI nạp bằng `--plugin-dir <plugin root>/agent-pack`, không cài riêng |
| `skills/` | Claude Code | **chỉ** entry skill của Coordinator (D3) |
| `hooks/` | Claude Code | `hooks.json`: `PreToolUse` chặn cứng, `SessionStart` chèn tóm tắt (ADR-0003 D6) |
| `runtime/` | OMI | feature module (`task-run`, `github`, `harness`, …), `shared/` và composition root `cli/main.ts`; xem "Kiến trúc runtime" |
| `config/` | OMI | policy YAML, cấu hình GitHub Project |
| `schemas/` | OMI | JSON Schema cho `monitor/` (omi-monitor đọc) |
| `templates/` | OMI | template Issue/PR (`github/`, `github-v2/`), báo cáo (`reports/`), workspace (`workspace/`) |
| `bin/` | OMI | `omi` launcher |
| `docs/` | OMI | `decisions/`, `architecture/`, `runbooks/` |
| `tests/` | OMI | `unit/`, `integration/`, `contract/`, `e2e/` (chia theo module), `fixtures/` |
| `.github/` | GitHub | workflow CI/release |

Thư mục chỉ được tạo khi task đầu tiên cần nó — không tạo thư mục rỗng hay placeholder.

## Workspace và task workspace

Dữ liệu và phiên làm việc của OMI nằm ngoài repo đích (ADR-0002 D1, D2). Repo đích không chứa `.omi/`, `AGENTS.md` của OMI hay `.claude/`; `omi doctor` (`layout`) cảnh báo khi còn. Repo đang ở layout cũ: [runbook chuyển đổi](../runbooks/workspace-migration.md).

```text
<parent>/
├── <name>-workspace/                   # workspace của Coordinator: `omi workspace init`
│   ├── .claude/
│   │   ├── settings.json               # settings của phiên Coordinator, có `autoMemoryDirectory`
│   │   └── agent-memory/coordinator/   # auto memory của Coordinator (`MEMORY.md` + file chủ đề); `omi doctor` `memory-dir`
│   ├── .omi-plugins/
│   │   ├── omi.config.yaml             # config dự án: github, checks, review, agents, cleanup
│   │   ├── omi.config.json             # profile thực thi cũ, riêng từng máy, không commit; bị thay bởi bảng `profile` (ADR-0004 D3), `omi profile import` đổi thành `.bak`
│   │   ├── state.sqlite                # state SQLite, dùng chung cho mọi task workspace; gồm bảng `profile` với token mã hóa
│   │   ├── web/<version>/              # bản build OMI Monitor (standalone) do `omi web` tải và giải nén (ADR-0004 D2)
│   │   └── evidence/<run>/             # task packet, log check; analysis: evidence/<run>/workspace/
│   ├── AGENTS.md                       # chỉ dẫn của Coordinator
│   └── <repo>/                         # checkout chính: chạy `omi` ở đây
└── <name>-workspace-task-<run>/        # task workspace: `omi task start`, dọn bằng `omi task finalize`
    ├── .claude/settings.json           # sinh lại trước mỗi lần chạy agent
    ├── .claude/skills/                 # chỉ skill của step (role default + --skills), chép lại mỗi lần chạy
    ├── .omi-home/claude/               # CLAUDE_CONFIG_DIR, tạo mới mỗi lần chạy
    ├── AGENTS.md                       # rules của role đang chạy (agent-pack/agents-md)
    ├── REPORT.md                       # template báo cáo của bước
    └── <repo>/                         # clone (không shallow), branch `<loại>/<issue>-<slug>`
```

- Task workspace: `git fetch origin` trong checkout chính, clone local, `remote set-url origin <github>`, rồi tạo branch từ `origin/<base>`. Push và PR do CLI làm từ clone.
- Agent có cwd = task workspace. Khi cwd ở task workspace: git chạy dạng `git -C <repo> …`, check chạy dạng `cd <repo> && <lệnh>`. Sau lệnh `cd <repo> && …` đầu tiên, Claude Code giữ cwd trong repo: khi đó git chạy trần (`git status|diff|log|show`, chỉ đọc) và check chạy trần `<lệnh>`. Mỗi check là một lệnh riêng (không `;`, pipe), có hoặc không có tham số. Chỉ những dạng này được cấp quyền.
- Dọn chỉ khi receipt merge của GitHub khớp tip của clone và task workspace chỉ chứa repo cùng các file OMI sinh ra. Không `--force`, không xoá branch remote.

## Layout đầy đủ (spec §5)

```text
omi-plugins/
├── README.md
├── package.json                        # TypeScript/Node runtime
├── tsconfig.json
├── .gitignore
├── .claude-plugin/
│   ├── plugin.json                     # omi-coordinator: the one plugin installed in a workspace
│   └── marketplace.json                # single-plugin marketplace (validate local source)
├── agent-pack/                         # omi-engineering, loaded only by the CLI (--plugin-dir)
│   ├── .claude-plugin/plugin.json
│   ├── agents-md/                      # AGENTS.md parts: core, editing | read-only, <role> (DoD, REPORT)
│   ├── hooks/hooks.json                # PreToolUse → omi hook agent-pre-tool-use (git push, gh, writes outside)
│   ├── agents/                         # one agent per role; <!-- omi:skills --> = default + allowed skills
│   │   ├── business-analyst.md
│   │   ├── solution-architect.md
│   │   ├── ui-ux-designer.md
│   │   ├── frontend-engineer.md
│   │   ├── backend-engineer.md
│   │   ├── database-engineer.md
│   │   ├── code-reviewer.md
│   │   ├── security-reviewer.md
│   │   ├── manual-qa-engineer.md
│   │   ├── automation-qa-engineer.md
│   │   └── devops-engineer.md
│   └── skill-library/<skill>/SKILL.md  # 33 role skills (Spike-0011 #196); not discovered, CLI copies the chosen ones
├── skills/                             # Coordinator entry points ONLY (ADR-0001 D3)
│   ├── omi-start/SKILL.md              # bootstrap a repo (github project init → repo/project apply)
│   ├── omi-plan/SKILL.md               # clarify a request with the PO → task Issues (omi issue create/depend)
│   ├── omi-task/SKILL.md               # one ticket-driven task
│   ├── omi-resume/SKILL.md             # new session: doctor → handoff show → cleanup scan → next step
│   ├── omi-status/SKILL.md             # Milestone overview (omi status) for the PO
│   └── omi-release/SKILL.md            # release check → PR develop → main (PO merge) → release tag
├── hooks/
│   └── hooks.json
├── omi-architecture.yaml               # contract kiến trúc của chính repo này (ADR-0006), legacy: []
├── runtime/                            # feature module, mỗi module tối đa 4 lớp (mục "Kiến trúc runtime")
│   ├── cli/main.ts                     # composition root: chỉ route lệnh tới <module>/cli/; bin/omi trỏ tới
│   ├── shared/                         # shared kernel: contracts, config, workflow, workspace, plugin-paths, redact, errors/, process/, sqlite/, github/client
│   ├── architecture/                   # contract kiến trúc, `omi arch check|show`
│   ├── task-run/                       # FSM, plan, slice, commit, checks, setup, worktree, `omi task`, `omi status`
│   ├── harness/                        # port Harness (domain/), adapter claude-code (adapters/)
│   ├── github/                         # Project, repo, issue, hierarchy: config và adapter
│   ├── ticket/  handoff/  context/     # ticket-first; handoff và task packet; đo context
│   ├── profile/  monitor/  hook/       # profile và secret; giao thức omi-monitor; hook Coordinator và agent-pack
│   ├── reporting/  cleanup/  release/  # render và outbox; dọn task đã merge; gate release, PR, merge
│   └── workspace/                      # workspace init/migrate, config, `omi doctor`
├── config/
│   ├── risk-policy.yaml                # Low/Medium/High merge tiers: `omi pr validate|merge` (chủ: release)
│   └── github/                         # mặc định governance (chủ: github); override ở .omi-plugins/omi.config.yaml
│       ├── project.yaml  project-v2.yaml
│       ├── issue-types.yaml
│       ├── issue-hierarchy.yaml  issue-hierarchy-v2.yaml
│       ├── status-transitions.yaml
│       ├── workflow.yaml               # state machine v2 (ADR-0005 D2); override: key `github.workflow` của omi.config.yaml
│       ├── views.yaml  views-v2.yaml
│       └── repository.yaml  repository-v2.yaml
├── schemas/
│   └── monitor/                        # JSON Schema cho omi-monitor đọc (ADR-0004 D1); chủ: monitor
├── templates/
│   ├── github/                         # ISSUE_TEMPLATE/ + PULL_REQUEST_TEMPLATE.md, render vào repo đích (chủ: github)
│   ├── github-v2/ISSUE_TEMPLATE/       # mô hình v2 (chủ: github)
│   ├── reports/                        # template báo cáo của step (chủ: reporting)
│   └── workspace/                      # AGENTS.md, .claude/, .omi-plugins/ mẫu cho workspace (chủ: workspace)
├── bin/omi                             # CLI launcher; executable
├── docs/
│   ├── decisions/                      # ADR
│   ├── architecture/
│   └── runbooks/
├── tests/
│   ├── unit/<module>/
│   ├── integration/<module>/
│   ├── contract/                       # khớp với tham chiếu ngoài (manifest, skill, agent)
│   ├── e2e/<module>/
│   └── fixtures/
└── .github/workflows/check.yml
```

## Kiến trúc runtime (ADR-0006)

Runtime chia theo **feature module**. Mỗi module có tối đa 4 lớp, mỗi lớp là một thư mục con và chỉ tạo khi có file. Hướng phụ thuộc khai báo trong [omi-architecture.yaml](../../omi-architecture.yaml); `omi arch check` kiểm tự động.

| Lớp | Thư mục | Được import | Ghi chú |
|---|---|---|---|
| domain | `<module>/domain/` | domain, `shared/` | cấm `node:child_process`, `node:fs`, `node:sqlite` (`forbidPackages`) |
| application | `<module>/application/` | application, domain, `shared/` | dùng adapter qua port do cli truyền vào |
| adapters | `<module>/adapters/` | adapters, application (port), domain, `shared/` | I/O: fs, process, GitHub, SQLite |
| cli | `<module>/cli/` | mọi lớp, `shared/` | route lệnh, dựng adapter, định dạng output |

- **Shared kernel** `runtime/shared/` không import module nào; module nào cũng import được. Gồm `contracts.ts` (enum dùng chung, `parseContract`), `config.ts`, `workflow.ts`, `workspace.ts`, `plugin-paths.ts`, `redact.ts`, `errors/`, `process/`, `sqlite/`, `github/client.ts`. Schema riêng của một module nằm ở `domain/` của module đó.
- **Composition root** `runtime/cli/main.ts` chỉ route lệnh tới `<module>/cli/`. Phụ thuộc chéo (ví dụ `cleanupScan`) được inject từ đây.
- **Giữa module:** module A chỉ import module B khi B có trong `dependsOn` của A, và lớp đích vẫn phải được phép theo bảng trên. `dependsOn` không có chu trình.
- **Asset** ở thư mục gốc, mỗi asset có một module chủ (xem layout trên), chỉ đọc qua `shared/plugin-paths.ts`; tên file và nội dung không đổi vì tham chiếu ngoài (`omi-monitor`, `.claude-plugin/`, CI) phụ thuộc vào chúng.
- **Test** ở `tests/<loại>/<module>/**/*.test.ts` với loại là `unit`, `integration`, `contract` hoặc `e2e`; test được import mọi thứ nhưng không nằm cạnh source.

| Module | Chức năng | `dependsOn` |
|---|---|---|
| `shared` | shared kernel | không |
| `architecture` | contract kiến trúc, `omi arch` | không |
| `github` | Project, repo, issue, hierarchy | không |
| `profile` | profile thực thi, secret | không |
| `monitor` | giao thức omi-monitor | không |
| `ticket` | ticket-first | github |
| `handoff` | handoff, task packet | github |
| `harness` | port Harness, adapter claude-code | profile |
| `task-run` | engine chạy task | github, ticket, harness, profile, handoff, architecture |
| `context` | đo context | github, harness, task-run |
| `reporting` | render, outbox | task-run |
| `release` | gate release, PR, merge | github, task-run, ticket |
| `cleanup` | dọn task đã merge | task-run, github, reporting, release, handoff |
| `hook` | hook Coordinator và agent-pack | handoff, task-run |
| `workspace` | workspace, config, `omi doctor` | architecture, context, github, harness, monitor, profile, task-run |

Thêm module mới: Architect khai báo vào contract trước khi thêm code; `omi arch check` báo `undeclared-module` cho code ngoài contract. Bật cho repo khác: [runbook contract kiến trúc](../runbooks/architecture-contract.md).

### Directory ownership

- `.claude-plugin/`, `skills/`, `hooks/` and `agent-pack/` (its own `.claude-plugin/`, `agents/`) follow Claude Code plugin contracts (Phase 0 verified: agents register as `<plugin>:<name>`, skills as `<plugin>:<name>`; Spike-0010 #185: a session with the plugin does not scan `agent-pack/`).
- `config/`, `schemas/`, `templates/`, `runtime/`, `tests/` are OMI-owned, not magic Claude directories.
- No `workflows/` (ADR-0003 D7): orchestration goes through `omi task run`.
- `bin/omi` must resolve plugin paths and environment reliably, including Windows. Never embed developer-specific absolute paths.
- No generated files are placed in arbitrary repository locations; update this directory contract through ADR before introducing new root folders.

## Công cụ

- TypeScript chạy trực tiếp trên Node ≥ 22.18 (type stripping, không build); `tsc` chỉ typecheck.
- Contract: zod là nguồn duy nhất cho TS type và validator runtime (`runtime/shared/contracts.ts`, `config.ts`). Mọi tài liệu đều strict và có `schemaVersion`. Lỗi được phân loại trong `runtime/shared/errors/errors.ts`: loại `transient` tính là attempt, không tính là round.
- Dữ liệu cục bộ nằm trong workspace, ngoài repo đích (ADR-0002 D1): config dự án ở `<workspace>/.omi-plugins/omi.config.yaml`; state SQLite (`node:sqlite`, WAL, migration theo `user_version`) ở `<workspace>/.omi-plugins/state.sqlite`. Mọi task workspace dùng chung một DB, và DB không bao giờ bị commit.
- Test: `node:test`. Lint/format: Biome. Một lệnh: `npm run check` (lint, typecheck, `npm run arch`, test).
