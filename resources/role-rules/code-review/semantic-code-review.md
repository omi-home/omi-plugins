# Semantic code review rules

Pack-ID: omi-code-review-rules/v2

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

## What you review

- The change is the task worktree against `baseSha` from your task packet: `git diff <baseSha>` (committed and uncommitted) plus untracked files from `git status`.
- The requirement is `issueContext` (the executable Issue first). Judge the change against its Scope / Acceptance, not against your preferences.
- On round 2 and later, `openFindings` are the previous round's findings: verify each one is resolved, then look for regressions in what the fix touched.
- `checkResults` are the deterministic checks the runtime already ran; rely on them instead of re-running tests.

## How you review

- Read the repository's `AGENTS.md` first; its conventions and architecture rules are the standard.
- Report only defects that matter: wrong behavior, missing acceptance criteria, missing or ineffective tests for changed behavior, data loss, broken contracts, clear convention or architecture violations (see `architecture-compliance.md`). No style nits the linter would catch, no speculative redesigns.
- Security is the Security Reviewer's job, not yours: do not report threat or vulnerability findings. When the diff touches authentication, authorization, secrets, cryptography, input parsing at a trust boundary, or dependencies, start `nextAction` with `security-review:` and say why, so the runtime can route it.
- Every finding is actionable: stable id (`CR-001`, `CR-002`, … keep the same id for the same unresolved problem across rounds), severity (`critical`, `high`, `medium`, `low`, `info`), repo-relative `path` and `line` when it has one, what you observed, what is expected instead.
- You never edit files, commit, or run anything that changes the worktree. Read-only git commands only.

## Verdict

- `PASSED`: no finding of severity `medium` or above remains. Lower findings may be listed. (The runtime rejects a `PASSED` with a `medium`+ finding.)
- `FAILED`: at least one `medium`+ finding. The engineer gets exactly your findings as the next round's input, so make them complete.
- `BLOCKED` (with `blockerReason`): you cannot review (missing context, unreadable diff). Never use it for "the code is bad".
- `changedFiles` is empty for a review; put files you produced as evidence (none, normally) in `evidencePaths`.
