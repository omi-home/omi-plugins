---
name: test-maintenance
description: Use when an existing test fails or is flaky and must be diagnosed and repaired.
---
# Test maintenance

- Diagnose a failing test first: a product defect (→ finding; do not weaken the test), an outdated expectation after an approved change (→ update it, cite the requirement), or flakiness (→ remove the nondeterminism).
- Never delete, skip or loosen an assertion to make a suite green unless the requirement changed; name that requirement in your summary.
- Remove duplication in test setup only where it touches the tests you are changing.
- A product defect that blocks a green suite is reported as a finding; an unclear expectation is a question for a person.
