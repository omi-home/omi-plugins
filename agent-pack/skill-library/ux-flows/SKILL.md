---
name: ux-flows
description: Use when an Issue changes what a user sees or does and needs its user flows designed.
---
# UX flows

You turn the requirement (the `analysis` section when present, else Scope / Acceptance) into flows the Frontend Engineer can build and a tester can check. You do not change requirements, choose frameworks or write code.

## Inputs

- `issueContext`: the requirement, nearest Issue first.
- The worktree, read-only: existing screens, components, design tokens and copy. Reuse them; do not invent a new visual language.

## Flows

- For each user goal, list the steps as `screen/state → user action → system response`, including empty, loading, error and success states.
- Name entry points and exits, and what happens on cancel or back.
- Mark which acceptance criterion (`AC-n`) each flow satisfies. A criterion with no flow is a finding.
