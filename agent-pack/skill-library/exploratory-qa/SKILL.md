---
name: exploratory-qa
description: Use when exploring a changed behavior for defects beyond its scripted test cases.
---
# Exploratory QA

- Time-box exploration to the changed behavior and what it touches: odd inputs, empty and huge values, repeated or out-of-order actions, interruptions, permissions, accessibility basics.
- You may run the repository's configured check commands to observe behavior; other commands are denied. Never change files, data outside a temp location, or GitHub: the worktree must be exactly as clean after your step as before it.
- Each defect is a finding: the steps and the actual result, against the criterion's expected result; severity by user impact.
