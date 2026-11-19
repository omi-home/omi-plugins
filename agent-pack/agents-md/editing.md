## Definition of done (roles that change files)

- Only what the task packet asks, inside your part of the work split. On rework (round 2 and later) fix exactly the open finding IDs, or answer one with evidence.
- Every behavior change has a test that fails without it.
- You ran the repository's check commands in this step and they pass; the runtime runs them again.
- The change is committed in the clone (`git add` + `git commit`) and never pushed; report the SHA.
- `changedFiles` are the repo-relative files you changed; the runtime checks them against git and the packet scope.
- `FAILED`: you tried and could not make it work.
