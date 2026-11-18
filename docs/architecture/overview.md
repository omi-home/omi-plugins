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
| Runtime OMI (`runtime/`, `bin/omi`) | FSM, policy, ticket, worktree, báo cáo GitHub, cleanup | SQLite cục bộ |
| GitHub Project + Issues | cây công việc, trạng thái, PR, comment audit | GitHub |
| CI / hooks | kiểm tra độc lập với agent | bằng chứng CI |

Luồng chính (D1): Coordinator → `omi` CLI → `claude -p --agent omi-engineering:<role>` (cwd = worktree của task) → kết quả có cấu trúc → CLI lưu SQLite và đăng comment.

## Hợp đồng thư mục gốc

Chỉ các thư mục sau được phép ở gốc repo. Thêm thư mục gốc mới cần ADR và cập nhật `ALLOWED_ROOT_DIRS` trong [tests/unit/directory-contract.test.ts](../../tests/unit/directory-contract.test.ts) — test này chặn mọi thư mục ngoài danh sách.

| Thư mục | Chủ sở hữu | Nội dung |
|---|---|---|
| `.claude-plugin/` | Claude Code | `plugin.json`, `marketplace.json` |
| `agents/` | Claude Code | 11 agent chuyên môn (`disallowedTools: Skill`) |
| `skills/` | Claude Code | **chỉ** entry skill của Coordinator (D3) |
| `workflows/` | Claude Code | adapter chỉ-đọc tuỳ chọn; cấm `isolation: worktree` |
| `hooks/` | Claude Code | `hooks.json` |
| `resources/` | OMI | `role-rules/<role>/`, `shared/` — đọc bằng đường dẫn tường minh |
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

## Layout đầy đủ (spec §5)

```text
omi-plugins/
├── AGENTS.md                           # Contributor/development instructions for OMI itself
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
│   ├── omi-start/SKILL.md
│   ├── omi-task/SKILL.md
│   ├── omi-resume/SKILL.md
│   ├── omi-status/SKILL.md
│   └── omi-release/SKILL.md
├── workflows/                          # OPTIONAL read-only adapters (ADR-0001 D1); no isolation: worktree
│   └── review-gate.js                  # e.g. parallel multi-lens review; CLI publishes results
├── hooks/
│   └── hooks.json
├── resources/                          # not discovered by Claude Code; read by explicit path only
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
│   ├── resources/                      # worktree, cache, cleanup ownership
│   └── persistence/                    # SQLite migrations and repositories
├── config/
│   ├── model-routing.yaml
│   ├── workflow-policy.yaml
│   ├── branching-policy.yaml
│   ├── resource-policy.yaml
│   ├── risk-policy.yaml                # Low/Medium/High merge tiers: `omi pr validate|merge`
│   └── github/                         # governance defaults; target repo overrides in .omi/config.yaml
│       ├── project.yaml                # custom fields + initial Status (`omi project plan|apply`)
│       ├── issue-types.yaml
│       ├── issue-hierarchy.yaml        # allowed parent → child matrix
│       ├── status-transitions.yaml     # Status lifecycle per type, drift in `omi project plan`
│       ├── views.yaml
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
- Dữ liệu cục bộ trong repo đích: config dự án ở `.omi/config.yaml`; state SQLite (`node:sqlite`, WAL, migration theo `user_version`) ở `<git-common-dir>/omi/state.sqlite`. Mọi worktree của repo dùng chung một DB, và DB không bao giờ bị commit.
- Test: `node:test`. Lint/format: Biome. Một lệnh: `npm run check`.
