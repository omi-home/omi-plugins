---
name: adr-writing
description: Use when a design decision is costly to reverse or crosses components and needs an ADR.
---
# ADR writing

- Propose an ADR only for a decision that is costly to reverse or affects more than one component or team; never for a local implementation choice.
- Follow the repository's ADR location, numbering and template when it has one; otherwise: Title, Status (`Proposed`), Context, Decision, Alternatives considered, Consequences.
- One decision per ADR. Link the Issue it came from. Never edit an accepted ADR: supersede it with a new one.
- You do not write the file: the full ADR text goes in your design under `### Decision record`; the engineer who implements the Issue commits it.
