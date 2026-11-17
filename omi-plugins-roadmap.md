# OMI Engineering Plugin — Implementation Roadmap for Claude Code

> Version: 2.1 · Updated: 2026-11-17 · Status: **Phase 0 complete** ([spike evidence](https://github.com/omi-home/omi-plugins/issues/1#issuecomment-6940598215), [ADR-0001](./docs/decisions/ADR-0001-phase0-outcomes.md)); next: Phase 1  
> Source of truth: [`omi-plugins-idea.md`](./omi-plugins-idea.md)  
> Preferred repository: `omi-plugins` · Target integration: GitHub Free / Projects Free

## 1. How to use this roadmap

This is an **execution plan**, not a request to implement everything in one Claude Code session. Complete tasks in dependency order, update the GitHub Issue tree, and stop at each acceptance gate. Each task must produce working behavior and executable tests rather than only files or prompts.

**Priorities:** P0 = blocked foundation, P1 = MVP critical, P2 = production hardening, P3 = optional. **Estimate** is a planning size (S/M/L, not promised calendar time). **Blocked by** is an issue dependency, NOT a sub-issue hierarchy.

### Operating constraints

- Initial local repository/bootstrap before GitHub access: explicitly logged temporary exception. After Project integration works, **every implementation task has its GitHub Issue, task branch and worktree from `origin/develop`**.
- Code PR links one primary executable Issue; aim PR → `develop`; release PR → `main` with Release Issue.
- Main Session Coordinator/PM/SM, Sonnet/Medium. Eleven specialists, medium effort each. Scripts first.
- Every completed step generates one templated issue comment with role/model/effort/round/status. CLI publishes; agents do not.
- No workflow may report fully complete with unverified cleanup after successful merge.
- No automatic Opus/high for coordinator; model overrides only when tested/authorized. No high effort defaults. `actualEffort` is recorded as `unknown` (not observable).
- `AGENTS.md` is canonical (verified on 2.1.325); `omi doctor` still checks version ≥ 2.1.277 and warns about any CLAUDE.md/CLAUDE.local.md.
- Specialist knowledge is resource-only (`resources/role-rules/`), never a skill; agents are launched by the OMI CLI, one process per agent, cwd = task worktree (ADR-0001 D1, D3).
- Repository: `omi-home/omi-plugins` (public), `develop` as default branch (ADR-0001 D4).
- GitHub Project [#2](https://github.com/orgs/omi-home/projects/2) is the single source for tasks, status and spike evidence (ADR-0001 D7).

## 2. Delivery milestones

| Milestone | Core outcome | Exit gate |
|---|---|---|
| M0 — Feasibility | 8 technical spikes; go/no-go ADRs | critical unknowns resolved or explicit fallback approved |
| M1 — Plugin skeleton | distributable plugin + minimal agent + skill | local installation, correct discovery, tests |
| M2 — Deterministic Core | CLI, SQLite, policy/state, GitHub + Git workspace | ticket validation and isolated worktree idempotent |
| M3 — Auditable Loop | structured handoff, reporter, 2+architect+2 loop | exact transitions and comments under failure simulation |
| M4 — Pull Request and Cleanup | PR checks, merge receipts, cleanup/recovery | merged issue has no orphan owned worktree |
| M5 — Full Agile Squad | 11 agents, skill/rule isolation, composing workflows | role/task matrix and acceptance evidence |
| M6 — GitHub Project as Code | hierarchy, fields, status, views, onboarding | disposable Project reconciles desired state |
| M7 — Release & Hardening | CI, deployment package, evals, docs | end-to-end fixture, repeatable clean install |

## 3. GitHub Project hierarchy to create

Create **one Milestone Issue for each M0…M7** (Issue Type `Milestone` if supported, otherwise label `type:milestone` until tested). Under each, group implementation into Feature/Spike/Dev Task Issues. Never create raw draft items for executable work. Every child is a real Issue, linked via native sub-issue API. **Numbering below is logical ID, not GitHub Issue number**; real numbers are allocated by GitHub and stored in task mapping.

```text
OMI Product / GitHub Project
├── M0 Feasibility
│   ├── F0.1 Claude Compatibility
│   │   ├── T0.1 Native workflow named-agent and model/effort spike
│   │   ├── T0.2 Main Skill metadata isolation + preload spike
│   │   ├── T0.3 Worktree execution/cwd isolation spike
│   │   └── T0.4 AGENTS.md precedence/version spike
│   ├── F0.2 GitHub Free Compatibility
│   │   ├── T0.5 Sub-issues/fields/views/types/dependencies API spike
│   │   ├── T0.6 PR–Issue association and develop-default spike
│   │   └── T0.7 Branch protection visibility/plan spike
│   └── F0.3 Recovery Feasibility
│       └── T0.8 Resume + comments + squash cleanup spike
├── M1 Plugin Foundation
│   ├── F1.1 Repository scaffold and contracts
│   │   ├── T1.1 Baseline project structure and AGENTS.md
│   │   ├── T1.2 Plugin manifest + local smoke test
│   │   └── T1.3 Config schemas, validation, error codes
│   └── F1.2 Minimal plugin proof
│       ├── T1.4 One Specialist + one resource rule pack
│       └── T1.5 One coordinator entry Skill + context test
├── M2 Deterministic Core
│   ├── F2.1 CLI + State
│   │   ├── T2.1 CLI infrastructure, JSON/human output and doctor
│   │   ├── T2.2 SQLite schema, migrations, locks, run/step repository
│   │   └── T2.3 Workflow FSM + policy engine + tests
│   ├── F2.2 GitHub + Git integration
│   │   ├── T2.4 GitHub auth and Issue/Project validation
│   │   ├── T2.5 Worktree create/validate/reuse and ownership markers
│   │   └── T2.6 Ticket state sync, dependencies, task start CLI
├── M3 Review Loop & Audit
│   ├── F3.1 Handoff and Reporting
│   │   ├── T3.1 Agent task-packet builder + step-result schema
│   │   ├── T3.2 Role-specific report templates and redaction
│   │   └── T3.3 SQLite outbox + GitHub comment idempotency
│   └── F3.2 Review/Rework policy
│       ├── T3.4 Deterministic lint/build/test gate
│       ├── T3.5 Round 1/2, architect, round 3/4, PO state machine
│       └── T3.6 Agent adapter vertical slice + integration probes
├── M4 PR + Resource Lifecycle
│   ├── F4.1 PR governance
│   │   ├── T4.1 Create PR + linked primary Issue validation
│   │   └── T4.2 Merge eligibility + CI/approval probes
│   └── F4.2 Cleanup and Recovery
│       ├── T4.3 Resource inventory + safe cleanup
│       ├── T4.4 Post-merge completion/comment and retention
│       └── T4.5 Crash recovery, outbox replay, startup reconciliation
├── M5 Full Specialist Squad
│   ├── F5.1 Requirements and design roles
│   │   ├── T5.1 BA + Architect + UI/UX agents and resource packs
│   ├── F5.2 Engineering roles
│   │   ├── T5.2 Frontend + Backend + Database agents and resource packs
│   ├── F5.3 Quality and operations roles
│   │   ├── T5.3 Code + Security reviewers, Manual + Automation QA, DevOps
│   └── F5.4 Composed workflows
│       ├── T5.4 Feature, Bug, Change Request and Refactor flows
│       └── T5.5 QA, release validation and role-routing evaluations
├── M6 GitHub Projects as Code
│   ├── F6.1 Issue hierarchy/templates
│   │   ├── T6.1 Issue Types + templates + sub-issue tree CLI
│   │   └── T6.2 Dependencies, completion roll-up policy
│   ├── F6.2 Project config
│   │   ├── T6.3 Project Fields/Status/Iteration desired-state diff/apply
│   │   └── T6.4 Views, dashboard, Project init/validate
├── M7 Release and Productionization
│   ├── F7.1 Integration and security
│   │   ├── T7.1 Security, rate-limit, failure injection tests
│   │   ├── T7.2 E2E disposable repo/Project and quota measurement
│   │   └── T7.3 Cross-platform tests and installation diagnostics
│   └── F7.2 Documentation and distribution
│       ├── T7.4 Marketplace, versioned release, changelog
│       └── T7.5 Contributor docs, ops runbooks, support matrix
```

## 4. Phase 0 — Feasibility (MUST finish before large implementation)

All spikes use disposable repositories/projects and minimal code. Post the evidence report as a comment on the Spike Issue (marker `<!-- omi:evidence=<id> -->`; ADR-0001 D7 — no report files in the repository) with: installed tool version, command/setup, actual observed outcome, logs/screenshots when helpful, conclusions, supported/unsupported, fallback and ADR reference. **No large framework implementation before this phase is complete.**

| Task | Acceptance criteria | Size | Blocked by |
|---|---|---|---|
| T0.1 Workflow named plugin-agent | Invoke one named plugin agent through real workflow and verify model, effort, context and returned result; no fabricated API calls | M | none |
| T0.2 Skill isolation | Main context contains no full specialist Skill body by default; subagent preload succeeds; test `Skill` access restriction | S | none |
| T0.3 Worktree execution | A named subagent uses explicitly assigned worktree, file edits don't leak to main checkout, no second unmanaged worktree | M | T0.1 |
| T0.4 AGENTS.md | `claude --version`, context precedence with/without CLAUDE.md, main/subagent behavior; compatibility shim decision | S | none |
| T0.5 GitHub Projects API | Create/find Issue, sub-issue, dependency, Issue Type, Project custom field and view (where allowed); document permissions and unsupported operations | M | none |
| T0.6 PR link | PR to `develop`, true associated Issue, closing keyword and merge behavior with `develop` default/non-default cases | M | T0.5 |
| T0.7 Branch protections | Actual repo visibility, Free plan rights, test branch protection configuration and unauthorized direct-push prevention | S | none |
| T0.8 Recovery/cleanup | Simulate comment published but client crashes, workflow replay, squash merge and worktree removal; determine safe idempotent algorithm | M | T0.3, T0.6 |

**Go/No-Go:** if native Dynamic Workflow cannot guarantee named specialist dispatch or worktree context, choose direct delegation + OMI CLI FSM as the MVP; keep workflow JS optional. If AGENTS.md cannot load, install a minimal `CLAUDE.md` with `@AGENTS.md` only after explicit compatibility decision. If Free/private server branch protection impossible, document non-enforceable control and request PO acceptance. No false claims.

**Outcome (2026-11-17):** all eight spikes resolved — T0.1 GO limited (workflow optional, no worktree context → direct dispatch primary), T0.2 GO (absolute isolation via resources), T0.3 GO, T0.4 GO, T0.5 GO (label fallback for OMI types, manual view filters), T0.6 GO with `develop` default, T0.7 GO public / NO-GO private Free, T0.8 GO. Decisions D1–D6 recorded in ADR-0001. Disposable fixtures kept for M2 integration tests: `omi-home/omi-spike-p0-20261117`, `omi-home/omi-spike-p0-private-20261117`, org Project #1.

## 5. Phase 1 — Working Plugin Skeleton

### T1.1 Repository and engineering guardrails

**Deliverables:** `AGENTS.md`, package scaffolding, directory contract, `.gitignore`, `README.md`, test framework, `docs/architecture/overview.md`. **Tests:** lint, typecheck, unit test smoke; no empty directories in source solely for future features. **DoD:** a developer can clone, install, run tests; source layout matches idea document. **Size:** M.

### T1.2 Plugin manifest, packaging and verification

**Deliverables:** `.claude-plugin/plugin.json`, local `claude --plugin-dir .` smoke, `claude plugin validate .`; Marketplace source decision. **DoD:** host recognizes actual plugin, no invalid manifest fields. **Size:** S. **Depends:** T1.1.

### T1.3 Configuration and typed contracts

**Deliverables:** schema validators for issue/workflow/step/comment/cleanup, error taxonomy, safe defaults. **Tests:** invalid/unknown field behavior, secret redaction and schema compatibility. **DoD:** no raw stringly-typed transitions. **Size:** M. **Depends:** T1.1.

### T1.4 Minimal specialist and resource rule pack

**Deliverables:** `agents/backend-engineer.md` (`disallowedTools: Skill`, no `skills:`) whose body reads `${CLAUDE_PLUGIN_ROOT}/resources/role-rules/backend/*.md`; one small rule/knowledge file; launcher arguments granting read access to `<plugin-root>/resources/` only. **DoD:** canary test proves the pack reaches the named agent and not main (main sees neither name nor body); Read denied without the permission argument; actual model observed, effort recorded `unknown`; interactive `/context` check performed. **Size:** M. **Depends:** T1.2, T0.2.

### T1.5 Minimal coordinator entry skill

**Deliverables:** `/omi-engineering:omi-task` with `script-first` and not taking implementation work. **DoD:** coordinator selects CLI for deterministic tasks; routing smoke test; main never reads files under `resources/role-rules/`. **Size:** S. **Depends:** T1.4.

**M1 Gate:** One plugin loads, one named agent works, its resource pack loads only in that agent, AGENTS.md behavior is proven, no unvalidated agent execution API.

## 6. Phase 2 — Deterministic Core

### T2.1 OMI CLI and diagnostics

`omi doctor`, `omi version`, `omi --help`, common config loader, compact JSON output, structured errors, no tokens in logs. **Tests:** CLI golden output and exit-code matrix. **Depends:** T1.3. **Size:** M.

### T2.2 Local transactional state

SQLite migration framework for `workflow_run`, `step_run`, `step_attempt`, `review_round`, `artifact`, `resource_owner`, `outbox`, `transition`, `lease`. **Tests:** concurrent calls, migration rollback, restart, transaction failure. **Depends:** T2.1. **Size:** L.

### T2.3 FSM/policy engine

Pure transition function with typed events, `WAITING_PO`, `CLEANUP_FAILED`, distinct technical attempt vs review round, policy checks. **Tests:** exhaustive transition table and invalid transitions. **Depends:** T2.2. **Size:** L.

### T2.4 GitHub integration

Authentication checks, real Issue lookup, Project membership, type/parent/dependencies, environment/permission diagnostics, rate-limit handling. **Tests:** mock contract + disposable integration. **Depends:** T0.5, T2.1. **Size:** L.

### T2.5 Git worktree manager

Fetch `origin/develop`, create issue branch/worktree, ownership manifest, reusing existing task, symlink/path normalization, lock/dirty check. **Tests:** repeated starts, branch collision, base SHA, Windows-compatible path behavior. **Depends:** T0.3, T2.2. **Size:** L.

### T2.6 Ticket and workspace lifecycle

`omi ticket validate`, `omi task start`, `omi task status`. Prevent work on unsupported Project item/branch. **Tests:** API failure mid-setup, blocked dependency, race two sessions, missing develop branch. **Depends:** T2.3–T2.5. **Size:** L.

**M2 Gate:** A real disposable GitHub Issue launches a unique reusable worktree with correct branch and persisted state, without an extra LLM call for setup.

## 7. Phase 3 — Structured Reporting and Rework

### T3.1 Task packet and handoff validator

Inputs: ticket scope, worktree, approved artifacts, open finding IDs, step/round, output schema. Outputs: status, artifacts/paths, evidence, findings, token metadata if available, next-action suggestion (not authority). **Tests:** missing role, fake path, invalid status, oversized output. **Depends:** T1.3, T2.3. **Size:** M.

### T3.2 Reports and sanitizer

Templates for all step categories; explicit `round`, `attempt`, `role`, `model`, `effort` and source of metadata; null model/effort for CLI. Secrets scrubber; no raw logs. **Tests:** golden Markdown templates, sanitization, missing model recorded as unknown. **Depends:** T3.1. **Size:** M.

### T3.3 GitHub reporter + transactional outbox

Persist before publish; unique marker; comment read/create/update; reconciliation after lost connection; rate-limits; store ID. **Tests:** exactly one visible logical step report across crash/retry, duplicate runner, API 429, no advance before confirmed post. **Depends:** T2.2, T2.4, T3.2. **Size:** L.

### T3.4 Deterministic pre-review validation

Per-repo configurable `lint`, `format`, `build`, `test`, scan commands with sanitized compact result, full logs in retained artifact path. **Tests:** timeout, failed command, missing tool, huge output bounded. **Depends:** T2.6. **Size:** M.

### T3.5 Review-round and Architect escalation engine

Implement **Review #1 fail → Dev #2; Review #2 fail → Architect; Dev/Review #3 fail → Dev/Review #4; Review #4 fail → WAITING_PO.** Quality failure vs transport failure distinguished. **Tests:** all 2+2 paths, no 5th Dev call, one Architect call, scope-change immediate PO stop, Reviewer must post comment per round. **Depends:** T2.3, T3.3. **Size:** L.

### T3.6 Vertical slice with actual named agents

Use Phase 0 proven adapter; one Backend Engineer, one Code Reviewer, Architect when triggered. Save and publish reports per step. **Tests:** stubbed logic + one live consented integration on test repository; monitor token usage. **Depends:** T3.1–T3.5, T0.1. **Size:** L.

**M3 Gate:** Live or test fixture issue shows unique comments for Dev Round 1, Review Round 1, Dev Round 2, Review Round 2 and Architect; transition and token evidence verified; never uses LLM to post comments.

## 8. Phase 4 — PR and Cleanup Lifecycle

### T4.1 Pull Request manager

Create and validate PR target `develop`, primary Issue, branch, owner, worktree and commit. Separate release path `develop → main`. **Tests:** wrong base, missing issue, dual-primary issue, PR already exists. **Depends:** T2.4, T2.6, T0.6. **Size:** M.

### T4.2 Merge governance

Read CI/reviews/merge state; respect public/free vs private/free server enforcement; explicit approval rules and authorized merge path. **Tests:** unresolved check, no required branch protection, squash merge. **Depends:** T4.1, T0.7. **Size:** M.

### T4.3 Owned resources inventory and cleanup

Ownership manifest for worktree, branch, PIDs, task containers, task cache dirs; safe stop/delete with no shared resources affected; dry-run and failure statuses. **Tests:** dirty worktree, lock, process active, wrong symlink, unowned container, squash merge. **Depends:** T2.5, T0.8. **Size:** L.

### T4.4 Post-merge finalization and resource retention

Record merge receipt → archive logs → cleanup → verify → post cleanup report → close/mark Done when permitted. **Tests:** failure at each step, `CLEANUP_FAILED` and no false Done. **Depends:** T3.3, T4.2, T4.3. **Size:** L.

### T4.5 Crash and orphan reconciliation

Replay incomplete outbox, detect merged-but-uncleaned, reconcile stale worktree list, enforce safe retention, `omi cleanup scan/apply --safe`. **Tests:** restart at each key boundary, duplicate dispatch prevention, no accidental `--force`. **Depends:** T2.2, T3.3, T4.4. **Size:** L.

**M4 Gate:** Given a merged, valid test PR, all owned worktree resources are safely cleaned; one cleanup comment exists; database and Project agree; interruption can recover.

## 9. Phase 5 — Full Agile Specialists and Workflows

### T5.1 Analysis and design

BA, Solution Architect, UI/UX Designer: each has standalone role prompt, resource pack (`resources/role-rules/<role>/`, shared files under `resources/shared/`) and input/output contract. Scope discipline and no role overlap. **Tests:** resource load isolation (canary), result schema, narrow evaluation tasks. **Depends:** M3. **Size:** L.

### T5.2 Engineering

Frontend, Backend, Database Engineers: focused tech-neutral core instructions, domain-specific extension references, worktree-scoped edits, unit/integration tests. **Tests:** scope restriction, delta rework, shared contract handoff. **Depends:** M3. **Size:** L.

### T5.3 Quality and DevOps

Code Reviewer, Security Reviewer, Manual QA, Automation QA, DevOps Engineer; deterministic tests/scans executed by CLI, QA agents only for analysis/authoring. **Tests:** no duplicated review responsibilities, security escalation, no QA agent solely to run existing tests. **Depends:** M3. **Size:** L.

### T5.4 Workflow composition

Feature, Bug, Change Request, Refactor; select only necessary roles and small reusable stages. **Tests:** no redundant BA/Architect for simple bug, required gates for auth/security changes, 2+2 retry loop. **Depends:** T5.1–T5.3. **Size:** L.

### T5.5 QA/Release and routing evals

QA verification and release readiness workflows, role-selection matrix, cost/latency comparison, native workflow adapter fallback. **Tests:** precise agent routing and correct model/effort observation or honest `unknown`. **Depends:** T5.4. **Size:** M.

**M5 Gate:** Eleven roles discoverable and working; specialist resource packs never reach main; use case selects minimum necessary roles and no repeat analysis without a finding.

## 10. Phase 6 — GitHub Project as Code

### T6.1 Issue Types/Templates/Hierarchy

Create/read native multi-level tree; native Issue Types where they exist (`Task/Bug/Feature`) plus authoritative `type:<OMI type>` labels (ADR-0001 D6); strict terminal executable ticket policy; template bodies and parent mapping; read-before-write for every relation (duplicates fail). **Tests:** 6-level hierarchy, prevention of cycle, invalid parent, cross-repo project membership, idempotency. **Depends:** T2.4, T0.5. **Size:** L.

### T6.2 Issue dependency/roll-up

Manage `blocked by`, compute non-destructive roll-up; do not close parent before accepted children. **Tests:** cycles, dependencies on outside repo, cancelled items, unaccepted children. **Depends:** T6.1. **Size:** M.

### T6.3 Desired-state Project fields

Configuration desired-state, plan/diff/apply, field mapping, permissions and no destructive default; iteration, priority/status, acceptance. **Tests:** reconcile twice results no second write, unknown field, duplicate field, permissions denied. **Depends:** T6.1. **Size:** L.

### T6.4 Views and onboarding

WBS, Board, Backlog, Review & QA, Roadmap created by name + layout via API (verified; duplicates are created silently, so check existing views first); filters/grouping via generated manual setup instructions (not settable via API); Project bootstrap `omi github project init/plan/apply/validate`. **Tests:** disposable Project and explicit unsupported capability report. **Depends:** T6.3. **Size:** L.

**M6 Gate:** A new empty test Project can be bootstrapped predictably; Issue hierarchy works; config can be reapplied without duplicate Issues/fields; unsupported Free capabilities surfaced.

## 11. Phase 7 — Quality, distribution and release

### T7.1 Reliability/security hardening

Rate limiting, untrusted ticket injection resistance, secrets redaction, path/PID/container ownership, SQLite concurrency, long logs. **Tests:** fault injection and red team fixtures. **Depends:** M4–M6. **Size:** L.

### T7.2 E2E and quota measurement

Run test Issue → worktree → reviewer failure and escalation → report comments → PR → merge → cleanup; compare against naive always-agent flow on a repeatable synthetic workload. **DoD:** qualitative/quantitative result; no invented token savings. **Depends:** M6. **Size:** L.

### T7.3 Platform compatibility

Windows PowerShell, Git Bash/WSL and Linux paths/process semantics as relevant; executable launcher, local PATH, `gh`, Node, Git. **DoD:** version table and blockers. **Depends:** T7.2. **Size:** M.

### T7.4 Plugin marketplace and versioned release

`plugin.json`, `marketplace.json`, semantic version, changelog, install/update/rollback instructions, `claude plugin validate`. **DoD:** clean disposable repository installs from a tagged distribution. **Depends:** T7.3. **Size:** M.

### T7.5 Operator guides and runbooks

`README`, admin/config, API permissions, Free limitations, ticket workflows, recovery from PR-merged-cleanup-failed, PO escalation, troubleshooting rate limits, safe deletion. **DoD:** a new developer follows onboarding without author. **Depends:** T7.4. **Size:** M.

**M7 Gate:** production-ready plugin within documented support boundaries, all tests pass, safe rollback validated, one clean install verified.

## 12. Acceptance tests — minimum end-to-end scenarios

| ID | Scenario | Expected |
|---|---|---|
| E01 | Dev1 Review pass | QA, PR, merge, cleanup |
| E02 | Dev1 fail, Dev2 pass | no architect; exactly 2 review comments |
| E03 | Dev1 + Dev2 fail | one architect report and correction plan |
| E04 | Dev1/2 fail; Dev3 pass | QA; three review reports |
| E05 | All four review rounds fail | WAITING_PO, no 5th Dev, keep worktree, PO escalation comment |
| E06 | Architect says requirement change | immediate WAITING_PO, no unapproved implementation |
| E07 | Network timeout during review | technical retry, not increment domain round |
| E08 | API succeeded posting comment then client crashed | reconcile marker, one logical comment |
| E09 | Comment cannot be posted | step not advanced; outbox pending |
| E10 | Two sessions start same Issue | one lease/owned worktree, no duplicate branch |
| E11 | Two different Issues | separate worktrees, no file overwrite across tasks |
| E12 | PR targets main for development task | reject (release path excepted) |
| E13 | PR has no real primary Issue association | reject |
| E14 | PR merged with squash | cleanup verifies GitHub state and remains safe |
| E15 | Worktree dirty or symlink-escaped | no force deletion; CLEANUP_FAILED |
| E16 | Merge done, crash before cleanup | startup reconciliation runs cleanup exactly as safe |
| E17 | Blocked task | preserve code/worktree and essential evidence |
| E18 | Main/Agent knowledge isolation | main never receives specialist resource packs; named agent reads its pack via `${CLAUDE_PLUGIN_ROOT}` |
| E19 | GitHub Free private branch enforcement absent | documented blocker/warning; no false guarantee |
| E20 | Rerun project desired state | no duplicate fields/views/issues |

## 13. Ticket template for implementation issues

```markdown
## Objective
One independently verifiable outcome.

## Context / Parent
Parent Issue: #...
Requirements/ADR: ...

## Scope
In: ...
Out: ...

## Dependencies
Blocked by: #...

## Deliverables
- [ ] Code / docs / schema / tests

## Acceptance Criteria
- [ ] Observable behavior 1
- [ ] Regression / failure behavior 2
- [ ] Correct CLI or plugin output

## Verification
- Commands and expected results
- GitHub integration evidence if needed

## Definition of Done
- [ ] Tests and static checks passed
- [ ] Independent review passed
- [ ] Per-step comment(s) posted
- [ ] PR linked to this Dev Task, merged into develop
- [ ] Worktree cleanup verified and reported
```

For Spike Issues, substitute the PoC/evidence and ADR for implementation output; worktree and PR required when versioned PoC code/documents are committed. No synthetic PR required when no repository change exists.

## 14. Work units, branch naming and PR policy

- GitHub Issue backing for every task. The GitHub Project contains parent milestones, features and executable sub-issues.
- Executable Issue branch examples: `feature/102-github-ticket-gate`, `chore/103-sqlite-schema`, `test/104-workflow-retry`.
- Branch created from freshly fetched `origin/develop` with recorded base SHA.
- Dedicated worktree path outside main checkout with Issue ownership file and SQLite record.
- PR only after required quality checks; exactly one designated primary Issue, linked via GitHub (not only unchecked string). Code-changing PRs preferentially Dev Task.
- Non-code planning/reporting Issue still needs Issue and audit; worktree required for tasks whose outputs change version-controlled repository files.
- Cleanup only after merge receipt, clean ownership and evidence retention. No `git worktree remove --force`, no unverified `git branch -D`.

## 15. Suggested implementation sequence for first vertical slice

**Iteration A (verify and prove):** T0.1–T0.8; T1.1–T1.5.  
**Iteration B (scripts/state first):** T2.1–T2.6.  
**Iteration C (one working LLM loop):** T3.1–T3.6.  
**Iteration D (close the lifecycle):** T4.1–T4.5.  
**Iteration E (scale roles and project operations):** M5–M7.

The vertical slice is intentionally **Backend Engineer → Code Reviewer → Architect escalation → GitHub report → PR → Merge → Cleanup**. Do not start with all 11 agents, all skills and all workflows before it works.

## 16. Claude Code task prompts (copy/paste)

### Prompt A — Bootstrap with evidence first

```text
Read omi-plugins-idea.md and omi-plugins-roadmap.md completely.
Act as the main OMI Coordinator (PM + Scrum Master), not a specialist.
Execute ONLY Phase 0 feasibility tasks T0.1–T0.8, using minimal disposable fixtures.
First inspect installed Claude Code, Git, gh, Node and GitHub permissions.
Do not fabricate Claude Code workflow API syntax or model/effort override support.
For each spike post an evidence comment on its Spike Issue with setup, actual commands,
observed behavior, tests/evidence, limits, recommendation and fallback.
Do not implement later-phase runtime or create empty agent/skill folders.
Where Github access is unavailable, mark blocked; never claim verification.
Return a concise GO/NO-GO decision table, changed files and test evidence.
```

### Prompt B — Foundation after Phase 0

```text
Read both specification files and every completed Phase 0 spike report.
Implement ONLY Phase 1 tasks T1.1–T1.5, honoring approved fallbacks.
Use AGENTS.md canonical with a compatibility shim only if proven necessary.
Follow ADR-0001: specialist knowledge is resource-only (no specialist skills).
Build a valid plugin, one Backend Engineer with one resource rule pack,
plus a lightweight Coordinator entrypoint. Keep contracts typed and tested.
Do not create all 11 agents yet. Do not introduce unapproved root folders.
Run plugin validation and tests, post step reports when GitHub integration permits.
Report real outputs and blockers; stop after the M1 acceptance gate.
```

### Prompt C — Implement one Issue only

```text
Read both OMI documents, the current phase and assigned GitHub Issue #<NUMBER>.
Do not begin code until Issue is verified in Project and worktree/branch from
origin/develop is provided by omi task start (unless a documented bootstrap exception applies).
Work ONLY on this Issue and worktree, following its acceptance criteria.
Prefer existing scripts and CLI for Git/GitHub operations, tests and reporting.
Use the minimum specialist agents required. Do not repeat approved analysis.
Return structured artifacts and evidence for the workflow reporter.
Do not merge, deploy or force-clean resources outside approved policy.
Finish by listing tests, PR linkage, step comments and worktree state.
```

### Prompt D — Review failure escalation

```text
For Issue #<NUMBER>, inspect persisted review state and only unresolved findings.
Apply exact 2 failed reviews → Solution Architect → 2 more rounds → WAITING_PO rule.
Do not reset rounds because session restarted or because a tool/API timed out.
Each logical step must be persisted and posted to the Issue by deterministic reporter
before next dispatch. Provide delta task packets, not the full conversation history.
After final failure, preserve worktree and post PO escalation with decisions required.
```

## 17. Project setup guidance (once GitHub access validated)

1. Repository `omi-home/omi-plugins` (public) and a Product Project; a repository admin sets `develop` as default (ADR-0001 D4); never silently modify repository defaults.
2. Configure Issue types/templates/status/priority/iterations based on APIs actually supported: native `Task/Bug/Feature` + `type:*` labels (D6); views created via API, filters/grouping by manual steps.
3. Create M0…M7 milestone issues and the hierarchy in Section 3 with real GitHub Issues and native sub-issue relationships.
4. Add dependencies from phase/task descriptions, assign priorities, prepare sprint/board/WBS/review views.
5. Install necessary GitHub permissions for CLI (the OMI account needs write/admin on the repository); protect `main` and `develop` with `enforce_admins` (works on public Free repos), record deviations.
6. Start tasks by `omi task start <number>` only **after** deterministic foundation exists; before that use explicit one-time bootstrap exceptions recorded in Issues/evidence.
7. Enforce PR and comment reports, review gates, cleanup and issue completion using tested policies.

## 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Native workflow cannot invoke chosen Plugin Agent reliably | Resolved: workflow can (`agentType`), but lacks `cwd` → direct dispatch is primary, workflow optional |
| Main context loads unwanted specialist material | Resolved: resource-only packs (ADR-0001 D3); canary regression test in T1.4/E18 |
| Effort cannot be observed | record `actualEffort: unknown`; never report intended effort as actual |
| Workflows disabled on a machine | `omi doctor` detects; workflow adapter switched off, direct dispatch unaffected |
| AGENTS.md ignored due to version/precedence | verify and optionally `@AGENTS.md` shim |
| GitHub Free private repo cannot protect branches | warn; require PO acceptance/manual controls or paid plan |
| Incomplete GH Project views API | manual view setup, still manage Issues/fields via supported API |
| LLM duplicates previous work | artifact ownership, delta-only prompts, stable finding IDs |
| API duplicates Issue comments | persistent outbox, marker lookup, reconciliation |
| Rate limits / API failures | exponential backoff, attempts separate from review rounds |
| Crash after merge | cleanup pending persisted, restart reconcilers |
| Disk bloat from abandoned worktrees | ownership inventory, safe cleanup scan, retention rules |
| Deleted foreign worktree/volume | strict canonical path/ownership guards, no `--force` |
| Cost/quota spiral | max 4 review rounds and 3 concurrent agents, per-step cost telemetry |

## 19. Release checklist

- [x] All Phase 0 critical spikes passed or have approved documented fallbacks (ADR-0001, 2026-11-17).
- [ ] Plugin manifest and real installation test passed.
- [ ] 11 specialist agents and documented role/resource-pack mapping validated.
- [ ] Coordinator uses Sonnet/Medium default; other roles medium; actual observations recorded.
- [ ] GitHub Issue tree, dependencies, status, PR linking work on tested plan.
- [ ] Workflow 2+Architect+2 implemented without fifth round.
- [ ] GitHub comments per step unique, sanitized and reconciled after crashes.
- [ ] Script-first deterministic operations avoid unnecessary agent calls.
- [ ] main/develop and branch/worktree isolation verified.
- [ ] PR merge and cleanup receipt; no orphan worktrees for completed test tasks.
- [ ] Safe blocked/rework/PO recovery demonstrated.
- [ ] CI tests, docs, migrations, rollback, secret handling pass.
- [ ] GitHub Free limitations and operating environment are documented.

## 20. References

Refer to official-source list in `omi-plugins-idea.md` Section 22. The architectural evidence is intentionally split: official documentation describes intended support, while **spike test reports record actual runtime compatibility**.

---

**Implementation instruction:** Begin with Phase 0. A clean, tested vertical slice is more valuable than a directory full of unimplemented agents, workflows and scripts.
