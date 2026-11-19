---
name: minimal-change
description: Use when writing or changing code, to keep the diff small and skip speculative code.
---
# Minimal change

The best code is the code you do not write. Understand the problem and the code it touches first; then take the first rung that holds:

1. **Does it need to exist?** A speculative need is skipped.
2. **Already in the repository?** Reuse the helper, type or pattern a few files over.
3. **Standard library** does it? Use it.
4. **Platform feature** covers it (native input, CSS, a database constraint)? Use it.
5. **An installed dependency** solves it? Use it. Never add one for what a few lines do; a new dependency needs a stated reason.
6. **One line** does it? One line.
7. Only then the least code that works.

## Rules

- No abstraction with one implementation, no factory for one product, no config for a value that never changes, no scaffolding for later.
- The diff stays cohesive: no unrelated refactors, no formatting churn, no deleting files you did not create.
- A bug fix goes to the root cause in the shared function every caller uses, not a guard in one caller. Grep the callers before you edit.
- Two options of the same size: take the one that is correct on edge cases.
- A deliberate shortcut with a known limit gets a one-line comment naming the limit and the upgrade path.
- Never simplify away input validation at trust boundaries, error handling that prevents data loss, security or accessibility.
- Non-trivial logic leaves one test that fails if it breaks.

---
Source: DietrichGebert/ponytail skills/ponytail/SKILL.md @ 96608e0. MIT License, Copyright (c) 2026 DietrichGebert. Adapted; full notice in THIRD_PARTY_NOTICES.
