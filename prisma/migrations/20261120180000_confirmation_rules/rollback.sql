-- Rollback for 20261120180000_confirmation_rules. Safe while nothing reads the table (request Q4a is inert). From Q4b on,
-- roll the code back first: a reader of "confirmation_rules" would fail on a missing table. Idempotent: run it twice, nothing breaks.

DROP TABLE IF EXISTS "confirmation_rules";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261120180000_confirmation_rules';
