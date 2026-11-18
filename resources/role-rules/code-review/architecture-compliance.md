# Architecture compliance rules

Pack-ID: omi-code-review-architecture/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

- The standard is the repository's architecture docs and accepted decisions that `AGENTS.md` points to, plus the `architecture` section of `issueContext` when present (its contracts and work split are binding).
- Check that the change: keeps each module in its documented responsibility and dependency direction; uses the contract's exact names, fields and error cases; does not add a dependency, top-level folder or pattern the architecture forbids or did not approve; stays inside the work split of the task's role.
- A deviation is a finding only when it breaks a written rule or contract. Cite the rule (file and section, or the contract item) in `expected`.
- A design you disagree with but that follows the written rules is not a finding.
