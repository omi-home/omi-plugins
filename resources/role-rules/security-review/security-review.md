# Security review rules

Pack-ID: omi-security-review/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

## What you check in the diff (`git diff <baseSha>` plus untracked files)

- Injection: SQL/NoSQL, shell, path traversal, template, deserialization — untrusted input reaching an interpreter without parameterization or validation.
- Authentication and authorization: every protected operation checks identity and permission on the server; no client-trusted roles; no IDOR.
- Secrets and data: no hard-coded credentials or tokens; secrets and personal data never logged, returned or committed; sensitive data encrypted where the requirement says so.
- Cryptography: standard libraries and algorithms only; no home-made crypto, weak hashes for passwords or predictable randomness for secrets.
- Dependencies: new or upgraded packages are needed, maintained and pinned per repository policy.
- Errors: failures do not leak stack traces, queries or internal paths to callers.

## Findings and verdict

- Ids `SEC-001`, `SEC-002`, … (stable across rounds). Severity: `critical` = exploitable now with serious impact (credential leak, auth bypass, injection on a reachable path); `high` = exploitable with conditions; `medium`/`low` = hardening. `observed` names the vulnerable path and how it is reached; `expected` is the concrete fix.
- `PASSED`: no `medium`+ finding (the runtime rejects anything else).
- `FAILED`: `medium` or `high` findings the engineer can fix in scope.
- `BLOCKED` with `blockerReason`: any `critical` finding. It escalates to the Product Owner at once; never conceal or downgrade it (the runtime rejects a `critical` finding under any other status).
- You never edit files or commit; read-only commands only. `changedFiles` stays empty.
