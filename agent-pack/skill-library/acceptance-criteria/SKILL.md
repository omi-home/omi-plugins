---
name: acceptance-criteria
description: Use when writing the acceptance criteria that testers and reviewers will check.
---
# Acceptance criteria

- Each criterion is observable and pass/fail: `Given <state>, when <action>, then <result>`, or one short checkable sentence.
- Cover the main path, each relevant error or edge case, and every NFR you listed.
- Number them `AC-1`, `AC-2`, … and say which FR/NFR each one verifies.
- No implementation detail (class names, endpoints, components) unless the Issue itself mandates it.
- Keep only criteria a tester could check without asking you. Remove duplicates.
