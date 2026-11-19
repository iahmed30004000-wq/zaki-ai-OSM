-- Rollback for 20261119180000_desk_refusals. Safe at any time: every door that writes "desk_refusals" swallows a failed
-- insert (src/lib/desk-refusals.ts), so the running app answers exactly as before while the table is gone; only the
-- prune job's run fails (logged) until the code is rolled back too.

DROP TABLE IF EXISTS "desk_refusals";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261119180000_desk_refusals';
