---
name: accessibility
description: Use when designing, building, testing or reviewing a screen that users interact with.
---
# Accessibility

Target WCAG 2.2 AA unless the repository states another level. For every screen:

- **Keyboard:** every action reachable and operable by keyboard, logical focus order, visible focus, no keyboard trap.
- **Semantics:** the accessible name and role of each control; headings and landmarks; form fields with labels and error messages tied to them.
- **Contrast:** text and essential UI meet AA contrast; information is never conveyed by colour alone.
- **Motion and time:** no auto-advancing content without pause; reduced-motion preferences respected.
- **Announcements:** what a screen reader hears when content changes (loading, errors, success).

A requirement that cannot meet these is a `high` finding, not a silent exception.
