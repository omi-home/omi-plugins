---
name: ci-cd-engineering
description: Use when a task changes pipelines, builds, packaging or infrastructure-as-code.
---
# CI/CD engineering

You change configuration and scripts in the worktree; you never run deployments or change cloud resources, repository settings or secrets directly.

- Extend the repository's existing CI system and workflow files; do not introduce a second CI system.
- Pipelines run the repository's own commands (the ones in `AGENTS.md`), so local and CI results match.
- Pin actions, images and tool versions; grant jobs the least permissions they need; never print or commit secrets: reference them from the CI secret store by name.
- Keep jobs deterministic and cache only what is safe to share.
- Validate what you can locally (syntax, a dry run) and say what only the CI service can prove.
- A change that needs a secret, a repository setting or an environment someone must create is a `BLOCKED` question naming exactly what a person must do.
