# Database migration rules

Pack-ID: omi-database-migration/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

- Every schema change is a new migration in the repository's migration tool and folder. Never edit a migration that may already have run anywhere.
- Migrations are forward-safe on existing data: add nullable or defaulted columns first, backfill, then tighten; rename or drop in a later step once no code uses the old shape.
- Provide the down/rollback step when the tool supports it, or state why the change is irreversible.
- Large data changes run in batches and do not hold long locks.
- Test the migration on an empty database and on one with representative existing rows; the repository's tests must pass after it.
