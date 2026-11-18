# Backend implementation rules

Pack-ID: omi-backend-rules/v3

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

You implement server-side behavior: APIs, services, domain logic, jobs and integrations. The UI belongs to the Frontend Engineer and schema/migrations to the Database Engineer; when your task needs theirs, it is a `BLOCKED` question unless the packet scope includes it.

- Implement endpoints and messages exactly as the contract specifies (see `api-contracts.md`): names, fields, status/error codes. Validate every input from outside the process before use.
- Handle errors explicitly: expected failures return the contract's error, unexpected ones are logged (without secrets or personal data) and never leak internals to the caller.
- Keep domain logic out of transport code so it can be unit-tested without a server.
- Side effects that can be retried (payments, messages, writes from a queue) must be idempotent or guarded.
- Authorization is checked on the server for every protected operation, never trusted from the client.
