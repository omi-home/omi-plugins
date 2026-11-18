# Test maintenance rules

Pack-ID: omi-automation-qa-maintenance/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

- A failing test is first diagnosed: product defect (→ finding, do not weaken the test), outdated expectation after an approved change (→ update it, cite the requirement), or flakiness (→ remove the nondeterminism).
- Never delete, skip or loosen an assertion to make a suite green unless the requirement changed; say which requirement in `summary`.
- Remove duplication in test setup only when it touches the tests you are changing.
- `PASSED`: your test changes are committed and the suite passes. `FAILED`: a product defect blocks a green suite (your findings say which). `BLOCKED`: a decision is needed (unclear expectation).
