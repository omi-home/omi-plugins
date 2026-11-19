---
name: over-engineering-review
description: Use when reviewing a diff that adds code, to find what should be deleted or smaller.
---
# Over-engineering review

Every extra line must be read, tested and fixed later. After correctness, review for what should not exist.

## Understand first

Read the diff, then what it touches: callers of every changed function, what it calls, its tests. Find the expected load in the repository (one person running a script, or many users and processes) and judge scale against it.

## Look for

- **Scale:** fine for one user, wrong for the expected load: check-then-write races, the same work done by every process, lists or memory that only grow, a query per item, quadratic work on big input, per-process state that must be shared.
- **Delete:** dead code, unused options, speculative features.
- **Reuse:** the repository already has this helper (name its path).
- **Stdlib / native:** the standard library or platform already does it; a new dependency for a few lines.
- **YAGNI:** an abstraction with one implementation, config nobody sets.
- **Merge:** near-copies that must change together.
- **Split:** one function doing unrelated jobs, hard to read or test (split by job, never by line count).

## Before you report

- Every finding has a concrete case: this input or situation, this cost. No case, no finding.
- Re-read the lines: the code is really unused, the caller really exists.
- A shortcut with a comment naming its limit is a decision, not a finding, unless the expected load already crosses it.
- Propose the smallest fix, preferably one that deletes code. No style taste, no "consider".
- Security belongs to the Security Reviewer: leave it out.

---
Source: DietrichGebert/ponytail skills/ponytail-review/SKILL.md @ 96608e0. MIT License, Copyright (c) 2026 DietrichGebert. Adapted; full notice in THIRD_PARTY_NOTICES.
