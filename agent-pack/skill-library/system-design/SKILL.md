---
name: system-design
description: Use when an Issue needs a technical design before engineers start.
---
# System design

Called for a new component, a cross-cutting change, a contract between frontend, backend and database, or a risky change.

## Inputs

- The requirement: the `analysis` section when present, else Scope / Acceptance. You do not change it; a requirement problem is a finding.
- The worktree, read-only: `AGENTS.md`, the architecture docs and decisions it points to, and the code the change touches. The existing architecture is the default; deviate only with a reason.

## Design

- The smallest design that meets the acceptance criteria. Reuse existing modules, patterns and dependencies; a new dependency or top-level folder needs a stated reason.
- Name the components touched, their responsibilities, the data that flows between them, and the contracts (`api-contract-design`).
- Split the work by role (Frontend, Backend, Database, DevOps) so each engineer has one clear, non-overlapping part. Do not write their code.
- List the risks (security, data migration, compatibility, performance) and how each is tested.
- A decision that is hard to reverse or crosses components gets an ADR (`adr-writing`).
- A requirement gap or conflict is a finding; a choice only the Product Owner can make blocks the design.
