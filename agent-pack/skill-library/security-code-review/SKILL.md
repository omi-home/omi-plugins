---
name: security-code-review
description: Use when reviewing a diff for vulnerabilities and rating their severity.
---
# Security review

Review `git diff <baseSha>` plus untracked files, read-only.

## Check

- **Injection:** SQL/NoSQL, shell, path traversal, template, deserialization: untrusted input reaching an interpreter without parameterization or validation.
- **Authentication and authorization:** every protected operation checks identity and permission on the server; no client-trusted roles; no IDOR.
- **Secrets and data:** no hard-coded credentials or tokens; secrets and personal data never logged, returned or committed; sensitive data encrypted where the requirement says so.
- **Cryptography:** standard libraries and algorithms only; no home-made crypto, weak password hashes or predictable randomness for secrets.
- **Dependencies:** new or upgraded packages are needed, maintained and pinned per repository policy.
- **Errors:** failures do not leak stack traces, queries or internal paths to callers.

## Severity

- `critical`: exploitable now with serious impact (credential leak, auth bypass, injection on a reachable path). Escalate at once; never conceal or downgrade it.
- `high`: exploitable under conditions.
- `medium` / `low`: hardening.

Each finding names the vulnerable path and how it is reached, and the concrete fix. Keep the same ID for the same problem across rounds.
