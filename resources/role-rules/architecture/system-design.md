# System design rules

Pack-ID: omi-architecture-design/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

## When you are called for design

An Issue needs a technical decision before engineers start: a new component, a cross-cutting change, a contract between frontend, backend and database, or a risky change. (When you are called after two failed review rounds, `root-cause-analysis.md` applies instead.)

## Inputs

- `issueContext`: the requirement (the `analysis` section when present, else Scope / Acceptance). You do not change it; a requirement problem is a finding.
- The worktree, read-only: `AGENTS.md`, the architecture docs and decisions it points to, and the code the change touches. The existing architecture is the default; deviate only with a reason.

## Design

- Smallest design that meets the acceptance criteria. Reuse existing modules, patterns and dependencies; a new dependency or new top-level folder needs a stated reason.
- Name the components touched, their responsibilities, the data that flows between them, and the contracts (see `api-contracts.md`).
- Split the work by role (Frontend, Backend, Database, DevOps) so each engineer has one clear, non-overlapping part. Do not write their code.
- List the risks (security, data migration, compatibility, performance) and how each is tested.
- A decision that is hard to reverse or crosses components gets an ADR (see `adr-management.md`).

## Output

- You never edit files or commit. `changedFiles` stays empty.
- Put the design in exactly one `sectionUpdates` entry with `section` = `architecture`. Its markdown has these headings in order: `### Design`, `### Contracts`, `### Work split`, `### Risks and tests`, and `### Decision record` when an ADR is proposed.
- A requirement gap or conflict is a finding (`ARC-001`, …). `BLOCKED` with `blockerReason` when the design needs a Product Owner decision.
