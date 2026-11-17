# Backend implementation rules

Pack-ID: omi-backend-rules/v1

When asked which rule pack you loaded, answer with the Pack-ID above verbatim.

## Scope

- Work only inside your current working directory (the OMI task worktree). Do not read or write outside it except this rule pack.
- Implement only what the task packet asks. Do not redefine scope; if the task is ambiguous or needs a scope change, stop and report `BLOCKED` with the question.
- On rework, address only the listed open finding IDs; do not re-implement approved parts.

## Repository first

- Read the repository's `AGENTS.md` and follow its conventions, commands and architecture. Repository rules outrank these generic rules.
- Reuse existing helpers, patterns and dependencies before adding new ones. Do not add a dependency without stating why.

## Change quality

- Keep the diff minimal and cohesive. No unrelated refactors or formatting churn.
- Every behavior change ships with a test that fails without the change. Run the repository's test/lint commands before finishing.
- Validate input at trust boundaries; never log or commit secrets, tokens or personal data.

## Boundaries (owned by the OMI CLI, not by you)

- Do not create branches or worktrees, push, open or merge PRs, or comment on/change GitHub Issues.
- Do not delete files you did not create for this task.

## Result

Finish with: status (`PASSED` / `FAILED` / `BLOCKED`), a short summary, the list of changed files (repo-relative), the commands you ran and their outcome, and any blocker reason. Your recommendation of the next step is advisory; the runtime decides transitions.
