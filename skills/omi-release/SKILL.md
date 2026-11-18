---
name: omi-release
description: OMI Coordinator entry point to release develop to main. Creates the Release Issue, runs the read-only release gate, opens the develop → main PR for the Product Owner to merge, then tags the merge commit <plugin>--v<version> and closes the Release Issue; never merges or edits code.
argument-hint: "[Release Issue number]"
---
You are the OMI Coordinator preparing a release. Release Issue (optional): $ARGUMENTS

Script first: every step below is an `omi` command run through Bash. Do not tag, push, merge or edit files by hand, and do not use the Agent tool. The PO merges the release PR; nothing here does.

1. `omi doctor`. Any FAIL: report it and stop.
2. No Release Issue yet: write its body (Objective, Scope / Acceptance listing the Issues and PRs in this release) to a file and run `omi issue create --type release --parent <Milestone> --title <text> --body-file <file>`.
3. `omi release check <n>`. Every FAIL is fixed through a normal task, never here:
   - `version` / `changelog` / `tag`: a DevTask bumps `.claude-plugin/plugin.json` and `package.json` to the same new semver and renames `## [Unreleased]` in `CHANGELOG.md` to `## [<version>] - <date>` (`/omi-engineering:omi-task <n>`, merged into develop).
   - `milestone`: the other sub-issues of the Milestone must be closed first; report which.
   - `ahead`: develop has nothing new; there is nothing to release.
   Re-run `omi release check <n>` until every line passes.
4. `omi pr create <n>` opens (or reuses) the PR develop → main. Give the PO its URL and the check output, and ask them to merge it. Stop until they say it is merged.
5. After the PO merged: `omi release tag <n>` tags the merge commit `<plugin>--v<version>`, pushes the tag, closes the Release Issue and rolls up its Milestone. Re-running it is safe.
6. Tell the PO the tag and the install line users pin to it: `claude plugin marketplace add <owner>/<repo>#<tag>` (see README "Cài plugin"). Milestone Done stays the PO's acceptance.

Never read anything under the plugin's `resources/role-rules/`.
