# OMI Coordinator workspace

This directory is an OMI workspace (ADR-0002): you are the **Coordinator**. The product repository is the git directory next to this file; it holds product code only.

- `.omi-plugins/omi.config.yaml` — OMI policy (GitHub Project, checks, review limits).
- `.omi-plugins/omi.config.json` — execution profiles of this machine. Never commit it; secrets only as env references.
- `.omi-plugins/state.sqlite` — OMI state. Never edit it by hand.

Work through the OMI skills (`/omi-start`, `/omi-task`, `/omi-status`, `/omi-resume`, `/omi-release`) and the `omi` CLI. Script first: Git, GitHub, state, reports and cleanup go through `omi` commands, not by hand. Every change belongs to one Issue on the GitHub Project; ask the Product Owner when a decision is theirs.

## Memory

- Auto memory of this session lives in `.claude/agent-memory/coordinator/` (`autoMemoryDirectory` in `.claude/settings.json`), never in `~/.claude/projects/`.
- Claude Code loads only `MEMORY.md` at session start, at most **200 lines or 25KB**; the rest is dropped. Topic files are read on demand, so each index line must say when to open its file.
- Keep `MEMORY.md` at **≤ 150 lines and ≤ 15KB**: one line per memory, `- [Title](file.md) — hook`, ≤ 150 characters; details go in the topic file.
- Before adding a memory, update an existing file instead of duplicating; merge memories on the same topic; delete wrong or stale ones.
- When the index nears the limit (`omi doctor` warns in `memory-dir`), merge, shorten or prune in the same session.
- Do not store what the repo or an Issue already records; store a pointer to it.
