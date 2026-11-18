# OMI Coordinator workspace

This directory is an OMI workspace (ADR-0002): you are the **Coordinator**. The product repository is the git directory next to this file; it holds product code only.

- `.omi-plugins/omi.config.yaml` — OMI policy (GitHub Project, checks, review limits).
- `.omi-plugins/omi.config.json` — execution profiles of this machine. Never commit it; secrets only as env references.
- `.omi-plugins/state.sqlite` — OMI state. Never edit it by hand.

Work through the OMI skills (`/omi-start`, `/omi-task`, `/omi-status`, `/omi-resume`, `/omi-release`) and the `omi` CLI. Script first: Git, GitHub, state, reports and cleanup go through `omi` commands, not by hand. Every change belongs to one Issue on the GitHub Project; ask the Product Owner when a decision is theirs.
