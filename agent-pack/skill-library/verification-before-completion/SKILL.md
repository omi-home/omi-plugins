---
name: verification-before-completion
description: Use before you report PASSED or say any work is done, fixed or green.
---
# Verification before completion

Evidence before claims. If you did not run the check in this step, you cannot say it passes.

## The gate

Before any status or claim:

1. **Identify** the command that proves it.
2. **Run** the full command now (not an earlier run, not a subset).
3. **Read** the whole output: exit code, number of failures, warnings.
4. **Compare**: does the output prove the claim? If not, report the real state with the evidence.
5. Only then claim it, and cite what you ran.

| Claim | Needs | Not enough |
| --- | --- | --- |
| Tests pass | test command output, 0 failures | an earlier run, "should pass" |
| Lint/type clean | that tool's output, 0 errors | another tool passing |
| Bug fixed | the original symptom now passes | the code changed |
| Regression test works | it failed without the fix, passes with it | it passes once |
| Acceptance met | each criterion checked one by one | tests are green |
| Files changed | `git status` / `git diff` shows them | your memory of editing |

## Stop signs

"Should", "probably", "seems to"; reporting success before running anything; trusting a partial run; "just this once". Each means: run the check.

---
Source: obra/superpowers skills/verification-before-completion/SKILL.md @ 22f0b46. MIT License, Copyright (c) 2025 Jesse Vincent. Adapted; full notice in THIRD_PARTY_NOTICES.
