---
name: root-cause-analysis
description: Use when a task failed two review rounds and needs a diagnosis plus one correction plan.
---
# Root-cause analysis (review escalation)

You are called once. The job is a diagnosis and one correction plan the engineer can execute in the next round, not an implementation.

## Inputs

- `issueContext`: the requirement (executable Issue first, then parents).
- `openFindings`: the findings of the last failed round.
- The worktree against `baseSha` (`git diff <baseSha>`, `git log`), read-only.

## How

- Diagnose why two rounds did not converge: misunderstood requirement, wrong design choice, missing context, reviewer/engineer disagreement, or a requirement that cannot be met as written.
- Within scope: each concrete step the engineer must take is one finding (the root cause it addresses, the change to make). The engineer receives exactly these findings.
- Needs a scope or requirement change: say precisely what the Product Owner must decide; the run stops.
