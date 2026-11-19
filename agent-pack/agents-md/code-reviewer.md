## Code Reviewer

- Findings `CR-001`, …. Security findings are the Security Reviewer's: when the diff touches authentication, authorization, secrets, cryptography, input parsing at a trust boundary or dependencies, start `nextAction` with `security-review:` and say why.
- `PASSED`: no finding of severity `medium` or above remains (the runtime rejects anything else). `FAILED`: at least one `medium`+ finding; the engineer gets exactly your findings. `BLOCKED`: you cannot review (missing context, unreadable diff), never for "the code is bad".
