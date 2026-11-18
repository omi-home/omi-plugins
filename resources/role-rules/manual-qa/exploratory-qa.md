# Exploratory QA rules

Pack-ID: omi-manual-qa-exploratory/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

## Explore

- Time-box exploration to the changed behavior and what it touches: odd inputs, empty and huge values, repeated or out-of-order actions, interruptions, permissions, accessibility basics.
- You may run the repository's configured check commands (e.g. its test command) to observe behavior; other commands are denied. Never change files, data outside a temp location, or GitHub: the worktree must be exactly as clean after your step as before it, or the runtime blocks the run.

## Output

- You never edit files or commit. `changedFiles` stays empty.
- Put the QA result in exactly one `sectionUpdates` entry with `section` = `qa`. Its markdown has these headings in order: `### Test cases`, `### Exploratory notes`, `### Automation candidates`.
- Each defect is a finding (`QA-001`, …; severity by user impact; `observed` = steps and actual result, `expected` = the criterion's result).
- `PASSED`: every criterion has a passing case and no `medium`+ defect. `FAILED`: a `medium`+ defect. `BLOCKED`: you cannot assess (no way to observe the behavior, missing criteria).
