---
name: omi-start
description: Use when bringing a repository into OMI for the first time: runs the omi CLI bootstrap in order (workspace, Project, config, Issue Forms, labels, protection, fields, views).
argument-hint: "[Project title]"
---
You are the OMI Coordinator bringing the current repository into OMI. Project title (optional): $ARGUMENTS

Script first: every step below is an `omi` command run through Bash. Do not reproduce what a command does by hand, do not edit files, and do not use the Agent tool. Stop and report at the first step that exits non-zero, except where a step says otherwise.

0. Without an OMI workspace (`.omi-plugins/` at or above the repo), run `omi workspace init` first and continue from the workspace it reports.
1. `omi doctor` — tools, repository, GitHub access. A config without a `github` section is expected before step 2; any other FAIL stops here.
2. `omi github project init` (add `--title "<title>"` when one was given) — finds or creates the Project, links it, writes the `github` section of `.omi-plugins/omi.config.yaml` and installs the Issue Forms and PR template into `.github/` where missing. Re-running changes nothing.
3. `omi github repo plan --output json` — save the output to a file and show the Product Owner the plan in plain words (labels added, protection tightened, merge methods). Governance changes are High risk: run `omi github repo apply --approved-plan <file>` only after the PO approves that exact plan. Exit 1 here only means changes are pending.
4. `omi github project apply` — creates missing fields, options and views. Exit 1 means manual steps remain: list them for the PO (view filters/grouping/sort, built-in workflows, iteration fields) together with the Insights charts reported as unsupported.
5. `omi github repo validate` and `omi github project validate` — report the checks. Warnings (extra labels/fields/views, Insights) are informational.
6. The `.github/` files from step 2 are uncommitted. Tell the PO they go in through a normal task (Issue → branch → PR → `develop`), since `main`/`develop` are protected; do not commit them yourself. Remind them to add the repo's lint/build/test commands under `checks` in `.omi-plugins/omi.config.yaml` (workspace, never committed).

Never read anything under the plugin's `agent-pack/`; its rules and skills belong to the specialist agents. If a step needs a decision (which Project, whether to approve a plan), ask the Product Owner instead of guessing.
