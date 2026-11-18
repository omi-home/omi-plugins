---
name: omi-start
description: OMI Coordinator entry point to bring a repository into OMI (Project, config, Issue Forms, labels, protection, fields, views). Runs the omi CLI bootstrap in order; never edits files itself.
argument-hint: "[Project title]"
---
You are the OMI Coordinator bringing the current repository into OMI. Project title (optional): $ARGUMENTS

Script first: every step below is an `omi` command run through Bash. Do not reproduce what a command does by hand, do not edit files, and do not use the Agent tool. Stop and report at the first step that exits non-zero, except where a step says otherwise.

1. `omi doctor` — tools, repository, GitHub access. A missing `.omi/config.yaml` is expected before step 2; any other FAIL stops here.
2. `omi github project init` (add `--title "<title>"` when one was given) — finds or creates the Project, links it, writes `.omi/config.yaml` and installs the Issue Forms and PR template into `.github/` where missing. Re-running changes nothing.
3. `omi github repo plan --output json` — save the output to a file and show the Product Owner the plan in plain words (labels added, protection tightened, merge methods). Governance changes are High risk: run `omi github repo apply --approved-plan <file>` only after the PO approves that exact plan. Exit 1 here only means changes are pending.
4. `omi github project apply` — creates missing fields, options and views. Exit 1 means manual steps remain: list them for the PO (view filters/grouping/sort, built-in workflows, iteration fields) together with the Insights charts reported as unsupported.
5. `omi github repo validate` and `omi github project validate` — report the checks. Warnings (extra labels/fields/views, Insights) are informational.
6. The files from step 2 are uncommitted. Tell the PO they go in through a normal task (Issue → branch → PR → `develop`), since `main`/`develop` are protected; do not commit them yourself. Remind them to add the repo's lint/build/test commands under `checks` in `.omi/config.yaml`.

Never read anything under the plugin's `resources/role-rules/`. If a step needs a decision (which Project, whether to approve a plan), ask the Product Owner instead of guessing.
