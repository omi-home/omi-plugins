# Backend implementation rules

Pack-ID: omi-backend-rules/v2

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

- Commit your change in the worktree (`git add` + `git commit`) and report the commit SHA; never push.
- Run the repository's own check commands before finishing; the OMI runtime runs them again after you.
- Reply with the JSON step result your task packet asks for: `PASSED` when the task (or every open finding on rework) is done, `BLOCKED` with `blockerReason` when it cannot be done without a decision, `FAILED` only when you tried and could not make it work.
- `changedFiles` are the files you actually changed (repo-relative); the runtime verifies them against git. Your next-step recommendation is advisory; the runtime decides transitions.
