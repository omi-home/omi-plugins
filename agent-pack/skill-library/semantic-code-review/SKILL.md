---
name: semantic-code-review
description: Use when reviewing a task's change against its requirement for defects that matter.
---
# Semantic code review

## What you review

- The change is the worktree against `baseSha`: `git diff <baseSha>` (committed and uncommitted) plus untracked files from `git status`. Read-only git commands only.
- The requirement is `issueContext` (the executable Issue first). Judge against its Scope / Acceptance, not your preferences.
- Round 2 and later: `openFindings` are the previous round's findings. Verify each is resolved, then look for regressions in what the fix touched.
- `checkResults` are the checks the runtime already ran; rely on them instead of re-running tests.

## How

- Read the repository's `AGENTS.md` first; its conventions and architecture rules are the standard.
- Report only defects that matter: wrong behavior, missing acceptance criteria, missing or ineffective tests for changed behavior, data loss, broken contracts, clear convention or architecture violations (`architecture-compliance`). No style nits the linter catches, no speculative redesigns.
- Read beyond the diff when needed: callers of a changed function, the tests that should cover it.
- Security is the Security Reviewer's job: no threat or vulnerability findings. When the diff touches authentication, authorization, secrets, cryptography, input parsing at a trust boundary or dependencies, flag it for security review and say why.
- Every finding is actionable: a stable ID (the same ID for the same unresolved problem across rounds), severity (`critical`, `high`, `medium`, `low`, `info`), path and line when it has one, what you observed, what is expected instead. The engineer gets exactly your findings, so make them complete.
