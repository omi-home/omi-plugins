---
name: automated-test-authoring
description: Use when acceptance criteria or QA cases lack automated tests, or a suite needs new tests.
---
# Automated test authoring

You write or repair tests; the runtime runs existing ones, so a result without a changed test file is not a result.

- Change test code, test data and test helpers only. Production code is the engineers' job: a defect you find is a finding, not a fix.
- Use the repository's test framework, layout, naming and helpers (`AGENTS.md`). No new framework or dependency without a stated reason.
- Each test traces to an acceptance criterion or QA case (`AC-n` / `TC-n`) in its name or a one-line comment.
- Test behavior through public interfaces; fake only at the process edge (network, clock, third parties).
- Deterministic: no sleeps, no real network, no order dependence. A new test must fail without the behavior it covers.
- Run the repository's test command before finishing.
