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
| Plugin Claude Code | agent chuyên môn, skill entry của Coordinator, workflow tuỳ chọn | mã nguồn plugin |
| Runtime OMI (`runtime/`, `bin/omi`) | FSM, policy, ticket, task workspace, báo cáo GitHub, cleanup | SQLite cục bộ |
| GitHub Project + Issues | cây công việc, trạng thái, PR, comment audit | GitHub |
| CI / hooks | kiểm tra độc lập với agent | bằng chứng CI |

Luồng chính ([ADR-0002](../decisions/ADR-0002-workspace-va-profile-thuc-thi-claude-code.md) D2/D4/D5): Coordinator → `omi` CLI → `claude -p --agent omi-engineering:<role>` với cwd = task workspace, `--plugin-dir <plugin>`, `CLAUDE_CONFIG_DIR` riêng mỗi lần chạy và env dựng từ allowlist → kết quả có cấu trúc → CLI lưu SQLite và đăng comment. Rule pack của role đến qua `AGENTS.md` mà CLI sinh trong task workspace, không qua lệnh Read. Profile thực thi (auth/model/effort theo profile) thuộc Feature-0021 #137; tới khi có, agent xác thực bằng `CLAUDE_CODE_OAUTH_TOKEN` của host.

## Hợp đồng thư mục gốc

Chỉ các thư mục sau được phép ở gốc repo. Thêm thư mục gốc mới cần ADR và cập nhật `ALLOWED_ROOT_DIRS` trong [tests/unit/directory-contract.test.ts](../../tests/unit/directory-contract.test.ts) — test này chặn mọi thư mục ngoài danh sách.

| Thư mục | Chủ sở hữu | Nội dung |
|---|---|---|
| `.claude-plugin/` | Claude Code | `plugin.json`, `marketplace.json` |
| `agents/` | Claude Code | 11 agent chuyên môn (`disallowedTools: Skill`) |
| `skills/` | Claude Code | **chỉ** entry skill của Coordinator (D3) |
| `workflows/` | Claude Code | adapter chỉ-đọc tuỳ chọn; cấm `isolation: worktree` |
| `hooks/` | Claude Code | `hooks.json` |
| `resources/` | OMI | `role-rules/<role>/`, `shared/` — CLI chép vào `AGENTS.md` của task workspace theo danh sách `omi:rule-pack` trong `agents/<role>.md` |
| `runtime/` | OMI | CLI, core (FSM/policy/routing/handoff/errors), adapters, reporting, persistence |
| `config/` | OMI | policy YAML, cấu hình GitHub Project |
| `schemas/` | OMI | JSON Schema cho state/step/handoff/comment/cleanup |
| `templates/` | OMI | AGENTS.md dự án, template Issue/PR/báo cáo |
| `bin/` | OMI | `omi` launcher |
| `docs/` | OMI | `decisions/`, `architecture/`, `contracts/`, `runbooks/` |
| `tests/` | OMI | `unit/`, `integration/`, `contract/`, `e2e/`, `fixtures/` |
| `evals/` | OMI | probe định tuyến/cách ly |
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
│   │   ├── omi.config.json             # profile thực thi, riêng từng máy, không commit (Feature-0021 #137)
│   │   ├── state.sqlite                # state SQLite, dùng chung cho mọi task workspace
│   │   └── evidence/<run>/             # task packet, log check; analysis: evidence/<run>/workspace/
│   ├── AGENTS.md                       # chỉ dẫn của Coordinator
│   └── <repo>/                         # checkout chính: chạy `omi` ở đây
└── <name>-workspace-task-<run>/        # task workspace: `omi task start`, dọn bằng `omi task finalize`
    ├── .claude/settings.json           # sinh lại trước mỗi lần chạy agent
    ├── .omi-home/claude/               # CLAUDE_CONFIG_DIR, tạo mới mỗi lần chạy
    ├── AGENTS.md                       # rule pack của role đang chạy
    ├── REPORT.md                       # template báo cáo của bước
    └── <repo>/                         # clone (không shallow), branch `<loại>/<issue>-<slug>`
```

- Task workspace: `git fetch origin` trong checkout chính, clone local, `remote set-url origin <github>`, rồi tạo branch từ `origin/<base>`. Push và PR do CLI làm từ clone.
- Agent có cwd = task workspace. Git chạy dạng `git -C <repo> …`, check chạy dạng `cd <repo> && <lệnh>`. Chỉ những dạng này được cấp quyền.
- Dọn chỉ khi receipt merge của GitHub khớp tip của clone và task workspace chỉ chứa repo cùng các file OMI sinh ra. Không `--force`, không xoá branch remote.

## Layout đầy đủ (spec §5)

```text
omi-plugins/
├── README.md
├── package.json                        # TypeScript/Node runtime
├── tsconfig.json
├── .gitignore
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json                # single-plugin marketplace (validate local source)
├── agents/
│   ├── business-analyst.md
│   ├── solution-architect.md
│   ├── ui-ux-designer.md
│   ├── frontend-engineer.md
│   ├── backend-engineer.md
│   ├── database-engineer.md
│   ├── code-reviewer.md
│   ├── security-reviewer.md
│   ├── manual-qa-engineer.md
│   ├── automation-qa-engineer.md
│   └── devops-engineer.md
├── skills/                             # Coordinator entry points ONLY (ADR-0001 D3)
│   ├── omi-start/SKILL.md              # bootstrap a repo (github project init → repo/project apply)
│   ├── omi-task/SKILL.md               # one ticket-driven task
│   ├── omi-resume/SKILL.md             # new session: doctor → handoff show → cleanup scan → next step
│   ├── omi-status/SKILL.md             # Milestone overview (omi status) for the PO
│   └── omi-release/SKILL.md            # release check → PR develop → main (PO merge) → release tag
├── workflows/                          # OPTIONAL read-only adapters (ADR-0001 D1); no isolation: worktree
│   └── review-gate.js                  # e.g. parallel multi-lens review; CLI publishes results
├── hooks/
│   └── hooks.json
├── resources/                          # not discovered by Claude Code; copied into the task workspace AGENTS.md
│   ├── shared/                         # knowledge reused by several roles (e.g. api-contracts.md)
│   └── role-rules/
│       ├── analysis/                   # requirement-analysis.md, acceptance-criteria.md, rules
│       ├── architecture/               # system-design.md, adr-management.md, root-cause-analysis.md
│       ├── design/                     # ux-flows.md, ui-design.md, accessibility.md
│       ├── frontend/                   # frontend-implementation.md, component-testing.md
│       ├── backend/                    # backend-implementation.md, unit-test-design.md
│       ├── database/                   # schema-design.md, database-migration.md
│       ├── code-review/                # semantic-code-review.md, architecture-compliance.md
│       ├── security-review/            # threat-assessment.md, security-review.md
│       ├── manual-qa/                  # test-case-design.md, exploratory-qa.md
│       ├── automation-qa/              # automated-test-authoring.md, test-maintenance.md
│       └── devops/                     # ci-cd-engineering.md, deployment-design.md, observability.md
├── runtime/
│   ├── cli/                            # parse, execute, compact output
│   ├── core/
│   │   ├── workflow-engine/            # transitions, deterministic gates
│   │   ├── policy-engine/
│   │   ├── agent-routing/
│   │   ├── handoff/
│   │   └── errors/
│   ├── adapters/
│   │   ├── claude/                     # tested named-agent invocation adapter
│   │   ├── github/                     # REST/GraphQL, rate limits
│   │   ├── git/
│   │   └── process/
│   ├── reporting/                      # renderer, outbox, reconciliation
│   ├── resources/                      # task workspace (clone), role files, cleanup ownership
│   └── persistence/                    # SQLite migrations and repositories
├── config/
│   ├── model-routing.yaml
│   ├── workflow-policy.yaml
│   ├── branching-policy.yaml
│   ├── resource-policy.yaml
│   ├── risk-policy.yaml                # Low/Medium/High merge tiers: `omi pr validate|merge`
│   └── github/                         # governance defaults; workspace overrides in .omi-plugins/omi.config.yaml
│       ├── project.yaml                # custom fields + initial Status (`omi github project plan|apply`)
│       ├── issue-types.yaml
│       ├── issue-hierarchy.yaml        # allowed parent → child matrix
│       ├── status-transitions.yaml     # Status lifecycle per type, drift in `omi github project plan`
│       ├── views.yaml                  # views, built-in workflows, Insights (`omi github project`)
│       └── repository.yaml             # labels, branch protection, merge methods (`omi github repo`)
├── schemas/
│   ├── workflow-state.schema.json
│   ├── step-result.schema.json
│   ├── handoff.schema.json
│   ├── review-findings.schema.json
│   ├── github-comment.schema.json
│   └── cleanup-result.schema.json
├── templates/
│   ├── project/AGENTS.md
│   ├── github/issues/                  # one Issue Form per OMI type + config.yml, rendered into target repo
│   ├── github/pull-request.md          # rendered to target repo .github/PULL_REQUEST_TEMPLATE.md
│   └── reports/
│       ├── analysis.md
│       ├── architecture.md
│       ├── implementation.md
│       ├── code-review.md
│       ├── security-review.md
│       ├── manual-qa.md
│       ├── automation-qa.md
│       ├── architect-escalation.md
│       ├── po-escalation.md
│       ├── pr.md
│       └── cleanup.md
├── bin/omi                            # CLI launcher; executable
├── docs/
│   ├── decisions/                      # ADRs
│   ├── architecture/
│   ├── contracts/
│   └── runbooks/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   ├── e2e/
│   └── fixtures/
├── evals/                              # agent/skill routing probes
└── .github/workflows/
    ├── validate.yml
    └── release.yml
```

### Directory ownership

- `.claude-plugin/`, `agents/`, `skills/`, `workflows/`, `hooks/` follow Claude Code plugin contracts (Phase 0 verified: agents register as `<plugin>:<name>`, skills as `<plugin>:<name>`, plugin workflows load from `workflows/` and run as `/<plugin>:<meta.name>`).
- `resources/`, `config/`, `schemas/`, `templates/`, `runtime/`, `tests/` are OMI-owned, not magic Claude directories.
- `workflows/*.js` **must not** duplicate state-machine logic or perform writes. Verified script API: `agent(prompt, {label, phase, schema, model, effort, isolation, agentType})`, `parallel`, `pipeline`, `phase`, `log`, `args`; no `cwd` option; no filesystem/shell/`import()`; `Date.now()`/`Math.random()` throw. Workflows are available only when the user enabled them (`"enableWorkflows": true`); `omi doctor` disables the adapter otherwise. Direct orchestration through CLI/Coordinator is the primary path.
- `bin/omi` must resolve plugin paths and environment reliably, including Windows. Never embed developer-specific absolute paths.
- No generated files are placed in arbitrary repository locations; update this directory contract through ADR before introducing new root folders.

## Công cụ

- TypeScript chạy trực tiếp trên Node ≥ 22.18 (type stripping, không build); `tsc` chỉ typecheck.
- Contract: zod là nguồn duy nhất cho TS type và validator runtime (`runtime/core/contracts.ts`, `config.ts`). Mọi tài liệu đều strict và có `schemaVersion`. Lỗi được phân loại trong `runtime/core/errors/errors.ts`: loại `transient` tính là attempt, không tính là round.
- Dữ liệu cục bộ nằm trong workspace, ngoài repo đích (ADR-0002 D1): config dự án ở `<workspace>/.omi-plugins/omi.config.yaml`; state SQLite (`node:sqlite`, WAL, migration theo `user_version`) ở `<workspace>/.omi-plugins/state.sqlite`. Mọi task workspace dùng chung một DB, và DB không bao giờ bị commit.
- Test: `node:test`. Lint/format: Biome. Một lệnh: `npm run check`.
