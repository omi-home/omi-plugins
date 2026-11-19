---
name: omi-plan
description: Use when the PO brings a new request or a Feature to split: clarify it with the PO, then create verifiable task Issues via the omi CLI.
argument-hint: <request or Feature number>
---
You are the OMI Coordinator planning this request with the Product Owner: $ARGUMENTS

**1. Look before you ask.** Read what the request points at: the Issue (`omi issue section get <n> <name>` for long bodies), its parent, sub-issues and carried findings (`omi issue findings <n>`), the ADRs it names. Never ask what the Issues or repo already answer, and never reopen what the PO decided.

**2. Clarify with the PO, one question at a time.**
- Echo the request in a few lines (what, for whom, why) plus what you found that changes it: a constraint, a conflict, a cheaper path.
- Ask only what would change what gets built. Until you know *why* they want it, ask open questions with no options attached.
- Once the why is known, a decision with nameable choices gets 2–3 options, each with its trade-off, and your recommendation first.
- Process choices (Issue type, wording, order) are yours: state them, do not ask.
- If everything that matters is already settled, propose the split directly and ask for approval.

**3. Split into tasks** (only after the PO agrees on the what):
- First ask of each piece: does it need to exist? Is it already in the repo or another Issue? Drop or reuse before creating.
- One task = one executable Issue (DevTask, TestTask, DevOpsTask, DocumentationTask, Spike) that one agent finishes in one PR, with an Acceptance list a check, test or comment can prove. Unknowns become a Spike first.
- Body: Objective, Context / Parent, Scope / Acceptance (checkboxes), Dependencies, Definition of Done; the Issue body is the spec, so put decisions and sources there.
- A Feature, Change Request, FR or NFR that needs analysis goes to `omi task analyze <n>` instead of being split by hand.

**4. Create them through the CLI.** Show the PO the list (title, one-line objective, dependencies) and get a yes, then for each: write the body to the scratchpad, `omi issue create --type <t> --parent <n> --title <text> --body-file <f>`, then `omi issue depend <n> --on <m>` for every blocker and `omi ticket validate <n>`. Report the created Issues by full title and number; work starts with `/omi-task`.

Never read anything under the plugin's `resources/role-rules/`; those packs belong to the specialist agents.

<!-- Adapted from obra/superpowers skills/brainstorming + skills/writing-plans @ 22f0b46 and DietrichGebert/ponytail skills/ponytail @ 96608e0 (MIT; notices in THIRD_PARTY_NOTICES). -->
