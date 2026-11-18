# Changelog

Mọi thay đổi đáng kể của plugin `omi-engineering` ghi ở đây. Định dạng theo [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), version theo [Semantic Versioning](https://semver.org/). Mỗi release là tag `omi-engineering--v<version>` trên `main` (`omi release tag`); chi tiết từng thay đổi nằm trong Issue/PR được link.

## [Unreleased]

Bản phát hành đầu tiên (dự kiến `0.1.0`), gồm Milestone-0001 → Milestone-0008 trên [Project #2](https://github.com/orgs/omi-home/projects/2).

### Added

- Plugin Claude Code `omi-engineering` + marketplace một-plugin (`.claude-plugin/`), 11 agent specialist với rule pack cách ly trong `resources/role-rules/` (Milestone-0002 #13, Milestone-0006 #47).
- CLI `omi` xác định: `doctor`, `ticket validate`, `task start|run|analyze|unblock|finalize`, `pr create|validate|merge`, `cleanup scan|apply`, `issue create|depend|findings|section`, `handoff`, `status` (Milestone-0003 #21, Milestone-0005 #39).
- Vòng review 2 + Architect + 2 có audit, báo cáo từng bước lên Issue qua outbox SQLite (Milestone-0004 #30).
- GitHub Projects as Code: `github project init|plan|apply|validate`, `github repo plan|apply|validate`, Issue Forms và PR template (Milestone-0007 #57).
- Release: `omi release check|tag`, skill `omi-release`, CI `check` trên 3 OS × Node 22.18/24 (Milestone-0008 #64).
