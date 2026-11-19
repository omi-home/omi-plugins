---
name: architecture-compliance
description: Use when checking a change against the repository's written architecture and the Issue's contracts.
---
# Architecture compliance

- The standard is the repository's architecture docs and accepted decisions that `AGENTS.md` points to, plus the `architecture` section of `issueContext` when present (its contracts and work split are binding).
- Check that the change keeps each module in its documented responsibility and dependency direction; uses the contract's exact names, fields and error cases; adds no dependency, top-level folder or pattern the architecture forbids or did not approve; stays inside the work split of the task's role.
- A deviation is a finding only when it breaks a written rule or contract: cite the rule (file and section, or the contract item) as the expected state.
- A design you disagree with that follows the written rules is not a finding.
