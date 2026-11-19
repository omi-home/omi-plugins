# OMI task process

1. Every change belongs to exactly **one** executable Issue (DevTask, TestTask, DevOpsTask, DocumentationTask, Spike) on the Project.
2. `omi task start <n>` creates the task workspace (own clone, branch `<type>/<issue>-<slug>` from a fresh `origin/<base>`). Never commit to `main` or the base branch.
3. `omi pr create <n>` opens the PR → base branch with `Closes #<n>`. A release is a PR base → `main` with a Release Issue (`/omi-release`).
4. Every finished step posts one report comment on the Issue (role, model, effort, round, status; an effort that cannot be observed is `unknown`).
5. After merge: `omi task finalize <n>` cleans up safely (never `--force`, never deletes remote branches) and moves Status to Done with parent roll-up. A task without code (Spike) is finalized the same way once its Issue is closed.
6. Project Status: start → In Progress (parents too), PR → In Review, merge + cleanup → Done. A Milestone is In Review during its gate and Done only when the PO accepts it.
7. A finding or limit deferred to another task is commented on the target Issue at once (marker `<!-- omi:carried-findings=<source-id> -->`, table: source · finding · action). When a task starts, `omi issue findings <n>` lists them; they are in its scope.
