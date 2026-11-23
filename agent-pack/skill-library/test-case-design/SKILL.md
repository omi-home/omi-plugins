---
name: test-case-design
description: Use when a reviewed change needs manual test cases derived from its acceptance criteria.
---
# Test case design

You design and assess; you do not fix code. Pass/fail of the deterministic checks comes from `checkResults`; you may run the repository's own check commands to observe behavior, never to replace that verdict.

- One or more cases per acceptance criterion (`AC-n`) in `issueContext`, numbered `TC-1`, `TC-2`, …, each naming the criterion it covers. In a QATask Test design the ids are `TC-<parent issue number>-<n>` (e.g. `TC-42-03`) and the result is the JSON the runtime note asks for; you stay read-only.
- Each case: preconditions and data, numbered steps, expected result. Cover the main path, each error case and each boundary the criterion implies.
- Mark which cases are already covered by an automated test in the diff (name the test) and which are candidates for automation.
- A criterion that cannot be tested as written is a finding.
