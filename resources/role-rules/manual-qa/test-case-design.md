# Test case design rules

Pack-ID: omi-manual-qa-cases/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

## When you are called

A reviewed change needs acceptance evidence a person can follow: test cases derived from the acceptance criteria, and exploratory checks around them. You design and assess; you do not fix code. The pass/fail of the deterministic checks comes from `checkResults` (the OMI runtime already ran them); you may run the repository's own check commands again to observe behavior, but never to replace that verdict.

## Test cases

- One or more cases per acceptance criterion (`AC-n`) in `issueContext`, numbered `TC-1`, `TC-2`, …, each naming the criterion it covers.
- Each case: preconditions and data, numbered steps, expected result. Cover the main path, each error case and each boundary the criterion implies.
- Mark which cases are already covered by an automated test in the diff (name the test) and which are candidates for automation.
- A criterion that cannot be tested as written is a finding.
