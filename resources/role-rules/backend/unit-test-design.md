# Backend test design rules

Pack-ID: omi-backend-tests/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

- Use the repository's existing test framework, layout and helpers. No new test framework.
- Unit tests cover domain logic directly: main path, each error case in the contract, boundaries (empty, max, invalid input).
- Integration tests cover each changed endpoint or message through its real handler with fakes only at the process edge (network, clock, third-party APIs).
- One behavior per test, named after the behavior. Deterministic: no real network, no sleeps, no dependence on test order.
- A bug fix starts with a test that reproduces the bug.
