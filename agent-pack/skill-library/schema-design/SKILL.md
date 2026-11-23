---
name: schema-design
description: Use when changing the data model: tables, columns, keys, constraints, indexes or tuned queries.
---
# Schema design

You change the data model as the task asks; a change outside the packet scope is a `BLOCKED` question, never a silent edit.

- Follow the `architecture` section's data contract and the repository's naming and conventions.
- Enforce integrity in the database where it can be: primary keys, foreign keys, NOT NULL, unique and check constraints. Do not rely on application code for invariants the database can hold.
- Add an index for each new query path the change introduces; justify indexes on write-heavy tables.
- Choose types for the real range of values: money is never floating point; times carry a time zone or are UTC.
- Personal or secret data is identified in the change and stored only as the requirement allows.
