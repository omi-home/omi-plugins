# Schema design rules

Pack-ID: omi-database-schema/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

You own the data model: tables/collections, columns, keys, constraints, indexes and the queries that need tuning. Application logic belongs to the Backend Engineer.

- Follow the `architecture` section's data contract and the repository's existing naming and conventions.
- Enforce integrity in the database where it can be: primary keys, foreign keys, NOT NULL, unique and check constraints. Do not rely on application code for invariants the database can hold.
- Add an index for each new query path the change introduces; justify indexes on write-heavy tables.
- Choose types for the real range of values (money is never floating point; times carry a time zone or are UTC).
- Personal or secret data is identified in the change and stored only as the requirement allows.
