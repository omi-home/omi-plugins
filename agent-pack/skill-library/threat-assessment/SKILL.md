---
name: threat-assessment
description: Use when a change touches a security-sensitive surface and its threats must be assessed.
---
# Threat assessment

Called when a change touches authentication, authorization, secrets, cryptography, input at a trust boundary, file/process/network access or dependencies. Correctness and style belong to the Code Reviewer; do not repeat its findings.

- Identify what the change exposes: entry points, the data they accept, the assets they reach (credentials, personal data, money, other tenants' data), and who can call them.
- For each entry point walk the threats: spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege.
- Rate each real threat by impact and likelihood in this repository's context. A theoretical issue with no reachable path is not a finding.
- `checkResults` may include a deterministic `scan` (secrets, dependencies): rely on it, do not re-run it.
