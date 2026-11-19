# Coordinator memory

- Auto memory of this session lives in `.claude/agent-memory/coordinator/` (`autoMemoryDirectory` in `.claude/settings.json`), never in `~/.claude/projects/`.
- Claude Code loads only `MEMORY.md` at session start, at most **200 lines or 25KB**; the rest is dropped. Topic files are read on demand, so each index line must say when to open its file.
- Keep `MEMORY.md` at **≤ 150 lines and ≤ 15KB**: one line per memory, `- [Title](file.md) — hook`, ≤ 150 characters; details go in the topic file.
- Before adding a memory, update an existing file instead of duplicating; merge memories on the same topic; delete wrong or stale ones.
- When the index nears the limit (`omi doctor` warns in `memory-dir`), merge, shorten or prune in the same session.
- Do not store what the repo or an Issue already records; store a pointer to it.
