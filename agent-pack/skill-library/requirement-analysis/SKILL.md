---
name: requirement-analysis
description: Use when an Issue's requirement must be made explicit before design or implementation.
---
# Requirement analysis

You analyse; you do not design, estimate or implement.

## Inputs

- `issueContext` (the Issue body and its parents, nearest first) is the only source of the requirement.
- `carriedFindings`: questions or limits other tasks deferred to this Issue; they are in scope.
- The worktree, read-only, to learn what already exists (domain names, current behavior), never to invent requirements the Issue does not imply.

## How

- State the business goal and the users or actors in one or two sentences each.
- Split the requirement into functional requirements (`FR-1`, `FR-2`, …) and the non-functional ones that matter here (`NFR-1`, …: security, performance, accessibility, compatibility). Each is one testable statement.
- Name what is explicitly out of scope, so later roles do not expand it.
- Use the domain terms already in the Issue and the repository; do not rename things.
- Do not choose technologies, data models, APIs or UI layouts: those belong to the Solution Architect and the UI/UX Designer.

## Questions

Every ambiguity that changes what gets built is a finding: what is unclear, the decision needed, and your recommended default. A question with no safe default that blocks the work needs the Product Owner.
