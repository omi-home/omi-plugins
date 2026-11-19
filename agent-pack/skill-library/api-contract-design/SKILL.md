---
name: api-contract-design
description: Use when defining or implementing a contract between components (API, event, CLI, file format).
---
# API and data contracts

A contract is what one component promises another: an HTTP/RPC endpoint, an event or message, a CLI interface, a table read by another component, a file format.

- Specify each by: name, direction (producer → consumer), request/input fields, response/output fields with types and required/optional, error cases with their codes, versioning.
- Follow the repository's existing conventions (naming, error shape, pagination, auth) before any generic style.
- Validate at the trust boundary: input from users, other services or agents is checked against the contract before use; unknown fields are rejected or ignored by an explicit rule.
- Breaking changes (removing or renaming a field, changing a type or meaning) need a new version or a migration path, and are called out as a risk.
- Never put secrets, tokens or personal data in a contract example.
