---
name: systematic-debugging
description: Use when a test or check fails, behavior is unexpected, or a rework follows a FAILED step.
---
# Systematic debugging

No fix without the root cause. A fix for a symptom is a second bug.

## 1. Investigate

- Read the whole error: message, stack trace, file, line, code. It often names the fix.
- Reproduce it reliably with exact steps. Not reproducible: gather more data, do not guess.
- Check what changed: `git diff <baseSha>`, recent commits, dependencies, config, environment.
- Several components (CI → build → script, API → service → DB)? Log what enters and leaves each boundary once, find *where* it breaks, then look only there.
- Trace a bad value back up the call chain to where it starts; fix it there.

## 2. Compare

Find similar code in the repository that works. Read the reference completely and list every difference, however small. Know what the code depends on (settings, environment, assumptions).

## 3. One hypothesis at a time

Write it down: "X is the cause because Y". Test it with the smallest change, one variable at a time. Wrong? Undo it and form a new hypothesis; never stack fixes.

## 4. Fix

- First a failing test that reproduces the problem (`test-driven-development`, when you have it).
- One change at the root cause. No "while I'm here" edits.
- Verify: the test passes, the rest of the suite passes, the original symptom is gone.

## When it does not converge

After three failed fixes, stop: each fix revealing a new problem elsewhere points at the design, not at the next fix. Report `BLOCKED` with what you tried, the evidence and the decision needed. A truly external cause (timing, environment) gets a written record of what you investigated plus explicit handling (retry, timeout, clear error).

---
Source: obra/superpowers skills/systematic-debugging/SKILL.md @ 22f0b46. MIT License, Copyright (c) 2025 Jesse Vincent. Adapted; full notice in THIRD_PARTY_NOTICES.
