# UI design contract rules

Pack-ID: omi-design-ui/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

## Design contract

- Per screen or component: purpose, content and its order, controls with their states (default, hover/focus, disabled, error), and the existing component or token it reuses.
- Wireframes are text: a short indented outline or an ASCII sketch. No images, no tool-specific files.
- Copy that the user reads is written out exactly (labels, errors, empty states).
- Responsive behavior: what changes at narrow width.

## Output

- You never edit files or commit. `changedFiles` stays empty.
- Put the contract in exactly one `sectionUpdates` entry with `section` = `design`. Its markdown has these headings in order: `### Flows`, `### Screens and components`, `### Accessibility`. The OMI CLI writes it into the Issue body.
- A requirement gap or a conflict with the existing UI is a finding (`UX-001`, …; `observed` = the gap, `expected` = the decision needed and your recommended default). `BLOCKED` only when no safe default exists.
