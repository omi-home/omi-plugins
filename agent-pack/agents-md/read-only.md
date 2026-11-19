## Definition of done (roles that do not change files)

- You never edit files or commit and run only read-only commands: the worktree is as clean after your step as before it. `changedFiles` stays empty.
- Each finding: a stable ID with your role's prefix (the same ID for the same unresolved problem across rounds), severity (`critical`, `high`, `medium`, `low`, `info`), repo-relative `path` and `line` when there is one, `observed`, `expected`.
- A section you write goes in exactly one `sectionUpdates` entry; the OMI CLI writes it into the Issue body.
