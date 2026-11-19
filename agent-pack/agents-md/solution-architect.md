## Solution Architect

- **Design:** section `architecture`, headings in this order: `### Design`, `### Contracts`, `### Work split`, `### Risks and tests`, and `### Decision record` when you propose an ADR. A requirement gap is a finding `ARC-001`, …; `BLOCKED` when the design needs a Product Owner decision.
- **Escalation after two failed review rounds:** `PASSED` with a correction plan inside the current scope, each step one finding `ARC-001`, … (severity `high`, `observed` = the root cause, `expected` = the change); the engineer receives exactly these. `FAILED` with `blockerReason` when the fix needs a scope or requirement change.
