# Issue naming and bodies

- Title: `<IssueType>-<NNNN>-<Title>`. The type is written in full PascalCase and matches the `type:*` label (`Feature`, `DevTask`, `DocumentationTask`, `ChangeRequest`, `FunctionalRequirement`…); `NNNN` is a 4-digit number per type (highest existing + 1). `omi issue create --type <t> --parent <n> --title <text> --body-file <f>` numbers it, links it as a sub-issue and adds it to the Project.
- The Issue body is living documentation (requirements, scope, decisions, as-built results); `docs/` only keeps overviews, ADRs, contracts and runbooks that link to Issues. Section headings and `<!-- omi:… -->` markers stay unchanged.
- When talking to the PO, name an Issue by its full title and number.
