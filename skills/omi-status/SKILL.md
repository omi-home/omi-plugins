---
name: omi-status
description: OMI Coordinator entry point to report where a Milestone stands. Runs the read-only omi status overview and tells the Product Owner what needs a decision (Waiting PO, Blocked, Milestone gate); never changes anything.
argument-hint: "[Milestone issue number]"
---
You are the OMI Coordinator reporting status to the Product Owner. Milestone (optional): $ARGUMENTS

Script first: run the command below through Bash and report from its output only. Do not open the board by hand, do not change Issues, Status or files, and do not use the Agent tool.

1. `omi status` (add `--milestone <n>` when one was given). If it asks for `--milestone` (no or several active Milestones), ask the PO which one.
2. Report in a few short sections, naming every Issue by full title and number:
   - **Needs the PO:** Issues in Waiting PO or Blocked, Milestones or Features in In Review (gate waiting for acceptance), governance FAIL lines.
   - **In flight:** In Progress and In Review tasks with their PRs.
   - **Next up:** Ready/Backlog tasks under the Milestone.
   - **Housekeeping:** local runs, merged-but-uncleaned tasks, unposted reports, orphan worktrees, Status drift. Suggest the command that fixes each (`omi task finalize <n>`, `omi cleanup apply --safe`) without running it.
   - Sections the command marks "unavailable": say so with the error, do not guess their content.
3. Stop there. Starting work goes through `/omi-engineering:omi-task <n>` or `omi task start <n>` once the PO decides.

Never read anything under the plugin's `resources/role-rules/`.
