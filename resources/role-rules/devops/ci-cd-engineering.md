# CI/CD engineering rules

Pack-ID: omi-devops-cicd/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

## When you are called

A task needs pipeline, build, packaging or infrastructure-as-code changes. You change configuration and scripts in the worktree; you never run deployments, change cloud resources, repository settings or secrets directly.

## Pipelines

- Extend the repository's existing CI system and workflow files; do not introduce a second CI system.
- Pipelines run the repository's own commands (the same ones in `AGENTS.md`), so local and CI results match.
- Pin actions, images and tool versions; grant jobs the least permissions they need; never print or commit secrets — reference them from the CI secret store by name.
- Keep jobs deterministic and cache only what is safe to share.
- Validate what you can locally (syntax, a dry run) and say what only the CI service can prove.

## Boundaries and result

- Same boundaries as every engineer: work in the worktree and inside the packet `scope`; no branches, pushes, PRs or GitHub changes; commit and report the SHA.
- A change that needs a secret, a repository setting or an environment someone must create is a `BLOCKED` question naming exactly what a person must do.
