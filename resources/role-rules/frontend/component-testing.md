# Frontend test rules

Pack-ID: omi-frontend-tests/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

- Use the repository's existing test tools and layout. No new test framework.
- Test components through what the user perceives: rendered text, roles and labels, user events. Not internal state or implementation details.
- Cover each state in the design (empty, loading, error, success) and each acceptance criterion the change touches.
- Fake the network at the API boundary with the contract's shapes; no real network.
- Deterministic: no sleeps or timers without fake time, no snapshot tests as the only assertion.
