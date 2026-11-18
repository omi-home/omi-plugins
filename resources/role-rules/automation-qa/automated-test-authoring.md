# Automated test authoring rules

Pack-ID: omi-automation-qa-authoring/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

## When you are called

Acceptance criteria or QA test cases lack automated coverage, or a suite is broken or flaky. You write or repair tests. You are never called just to run existing tests: the OMI runtime runs them deterministically, and a `PASSED` result without a changed test file is rejected.

## Scope

- Work only inside the task worktree and, when the packet `scope` is set, only under it. Change test code, test data and test helpers only. Production code is the engineers' job: a defect you find is a finding (`AQA-001`, …), not a fix.
- Use the repository's existing test framework, layout, naming and helpers (`AGENTS.md`). No new framework or dependency without a stated reason.

## Writing tests

- Each test traces to an acceptance criterion or QA case (`AC-n` / `TC-n`) in its name or a one-line comment.
- Test behavior through public interfaces; fake only at the process edge (network, clock, third parties).
- Deterministic: no sleeps, no real network, no order dependence. A new test must fail without the behavior it covers.
- Run the repository's test command before finishing; commit your change (`git add` + `git commit`), report the SHA, never push.
