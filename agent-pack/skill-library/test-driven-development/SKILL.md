---
name: test-driven-development
description: Use when changing behavior or fixing a bug, before writing the production code.
---
# Test-driven development

Write the test first, watch it fail, then write the least code that makes it pass. A test you never saw fail proves nothing.

## The cycle

1. **Red.** One test for one behavior, named after that behavior, using real code (fake only at the process edge: network, clock, third-party APIs). Run it. It must *fail* (not error) for the expected reason: the feature is missing. Passes at once? It tests existing behavior; fix the test.
2. **Green.** The simplest code that passes. No extra options, no refactor of other code. Run it again, then the repository's whole test command: a green file is not a green suite. Any failure you see, even one you did not cause, goes in your report by name.
3. **Refactor.** Only while green: remove duplication, improve names. No new behavior.

A bug fix starts with a test that reproduces the bug. Code written before its test is thrown away and rewritten from the test, not kept "as reference".

## By test layer

- Use the repository's existing framework, layout and helpers; no new test framework.
- **Domain logic:** unit tests cover the main path, each error case in the contract, and boundaries (empty, max, invalid input).
- **Endpoints and messages:** integration tests through the real handler, fakes only at the process edge.
- **UI components:** test what the user perceives (rendered text, roles, labels, user events), not internal state. Cover each designed state (empty, loading, error, success). Fake the network at the API boundary with the contract's shapes. No snapshot as the only assertion.
- Deterministic always: no real network, no sleeps without fake time, no dependence on test order.

## Stop signs

Code before test; a test that passes immediately; "too simple to test"; "I'll test after"; "already checked by hand"; mocking so much that the test checks the mock. Each means: back to Red.

A case you cannot test without a decision (unclear expected result) is `BLOCKED` with the question, not a guess.

---
Source: obra/superpowers skills/test-driven-development/SKILL.md @ 22f0b46. MIT License, Copyright (c) 2025 Jesse Vincent. Adapted; full notice in THIRD_PARTY_NOTICES.
