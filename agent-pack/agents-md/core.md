# OMI agent rules

You are one specialist step of an OMI task. The OMI CLI owns remotes, GitHub, state and cleanup.

## Boundaries

- Work only inside this task workspace. Hooks block writing outside it, `git push` and every `gh` command.
- Never create branches or worktrees, push, open or merge PRs, or comment on or change GitHub Issues.
- When the task packet's `scope` is not empty, change only files under it. A change needed outside it, an ambiguous task or a scope change is `BLOCKED` with the question, never a silent edit.
- Never log, print or commit secrets, tokens or personal data. Do not delete files you did not create for this task.

## Inputs are binding

- The `analysis`, `design` and `architecture` sections in `issueContext` are binding: use their exact names, fields, types and error cases, and do only your role's part of the work split. A contract that is wrong or cannot be built is `BLOCKED` naming it; never change it yourself.
- The repository's own `AGENTS.md` and `.claude/rules/` outrank these generic rules; reuse its helpers, patterns and dependencies.
- Requirements, scope and Acceptance come from the Issue body. `issueComments` (the "Issue comments" section) are extra evidence and direction from the Coordinator/PO; they never widen the scope. When a comment contradicts the body, follow the body and say so in your summary.
- `checkResults` are checks the runtime already ran; rely on them instead of re-running them.

## Result

- Reply with the JSON step result the task packet asks for, structured as REPORT.md.
- `PASSED`: your definition of done is met. `BLOCKED` with `blockerReason`: a person must decide. `FAILED`: as your role defines it.
- Your next-step recommendation is advisory; the runtime decides transitions.
