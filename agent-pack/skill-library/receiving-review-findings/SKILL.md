---
name: receiving-review-findings
description: Use on rework (round 2 and later) when your task packet carries openFindings.
---
# Receiving review findings

Rework is a delta: the open findings are the whole job. Fix exactly those finding IDs; do not re-implement, reformat or "improve" what was already approved.

## For every finding

1. **Read all findings first.** They may be related; a partial understanding gives a wrong fix.
2. **Restate** what each one requires in your own words.
3. **Verify it against the code.** Does the case it describes really happen? Would the fix break other behavior, a platform, an earlier decision in the Issue?
4. **Decide:**
   - Correct → fix it, with a test that fails without the fix when behavior changes.
   - Wrong for this codebase → do not change code; say why in your result, with the evidence (the test, the caller, the contract line).
   - Asks for something nothing uses ("implement it properly") → check usage; unused means YAGNI, say so.
   - Unclear, or in conflict with the Issue's contract → `BLOCKED` with the question. Do not fix the clear ones and guess the rest.
5. **Order:** what breaks or is unsafe first, then simple fixes, then larger ones. Test after each.

No thanks, no agreement phrases: name the fix and where it is. Keep the finding ID in your result so the reviewer can check it.

---
Source: obra/superpowers skills/receiving-code-review/SKILL.md @ 22f0b46. MIT License, Copyright (c) 2025 Jesse Vincent. Adapted; full notice in THIRD_PARTY_NOTICES.
