---
name: backend-implementation
description: Use when implementing server-side APIs, services, domain logic, jobs or integrations.
---
# Backend implementation

You implement server-side behavior. A change outside the packet scope is a `BLOCKED` question, never a silent edit.

- Implement endpoints and messages exactly as the contract specifies (`api-contract-design`): names, fields, status/error codes. Validate every input from outside the process before use.
- Handle errors explicitly: expected failures return the contract's error; unexpected ones are logged (without secrets or personal data) and never leak internals to the caller.
- Keep domain logic out of transport code so it can be unit-tested without a server.
- Side effects that can be retried (payments, messages, writes from a queue) are idempotent or guarded.
- Authorization is checked on the server for every protected operation, never trusted from the client.
