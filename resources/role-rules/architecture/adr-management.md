# ADR rules

Pack-ID: omi-architecture-adr/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

- Propose an ADR only for a decision that is costly to reverse or affects more than one component or team. Not for local implementation choices.
- Follow the repository's existing ADR location, numbering and template when it has one; otherwise use: Title, Status (`Proposed`), Context, Decision, Alternatives considered, Consequences.
- One decision per ADR. Link the Issue it came from. Never edit an accepted ADR: supersede it with a new one.
- You do not write the file. Put the full ADR text under `### Decision record` in your `architecture` section update; the engineer who implements the Issue commits it.
