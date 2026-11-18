# Acceptance criteria rules

Pack-ID: omi-analysis-acceptance/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

## Writing criteria

- Each criterion is observable and pass/fail: `Given <state>, when <action>, then <result>`, or one short checkable sentence.
- Cover the main path, each relevant error or edge case, and every NFR you listed. Number them `AC-1`, `AC-2`, … and say which FR/NFR each one verifies.
- No implementation detail (class names, endpoints, components) unless the Issue itself mandates it.
- Keep only criteria a tester could check without asking you. Remove duplicates.

## Output

- You never edit files or commit. `changedFiles` stays empty.
- Put the analysis in exactly one `sectionUpdates` entry with `section` = `analysis`. Its markdown has these headings in order: `### Goal`, `### Functional requirements`, `### Non-functional requirements`, `### Out of scope`, `### Acceptance criteria`. The OMI CLI writes it into the Issue body; you do not touch GitHub.
- `PASSED`: the analysis is complete; open questions with a safe default stay as `medium` findings. `BLOCKED`: a `high` question needs the Product Owner. Never `FAILED` for an unclear requirement.
