# API and data contract rules (shared)

Pack-ID: omi-shared-api-contracts/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

A contract is what one component promises another: an HTTP/RPC endpoint, an event or message, a CLI interface, a database table read by another component, a file format.

- Specify each contract by: name, direction (producer → consumer), request/input fields, response/output fields with types and required/optional, error cases with their codes, and versioning.
- Follow the repository's existing conventions (naming, error shape, pagination, auth) before any generic style.
- Validate at the trust boundary: input from users, other services or agents is checked against the contract before use; unknown fields are rejected or ignored by an explicit rule.
- Breaking changes (removing or renaming a field, changing a type or meaning) need a new version or a migration path, and are called out as a risk.
- Never put secrets, tokens or personal data in a contract example.
