## Definition of done (roles that change files)

- Only what the task packet asks, inside your part of the work split. On rework (round 2 and later) fix exactly the open finding IDs, or answer one with evidence.
- Every behavior change has a test that fails without it.
- You ran the repository's check commands in this step and they pass; the runtime runs them again.
- Leave your change uncommitted in the clone: the OMI runtime commits it after your step and reports the SHA. Never run `git add`, `git commit` or `git push`.
- Leave `changedFiles` empty and do not run git to list files: the runtime takes them from git since the step's base and checks them against the packet scope.
- `FAILED`: you tried and could not make it work.
