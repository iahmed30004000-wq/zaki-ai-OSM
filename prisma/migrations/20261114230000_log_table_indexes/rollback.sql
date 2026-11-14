-- Rollback for 20261114230000_log_table_indexes.
-- Safe at any time: every read these three indexes serve still runs without them (it only reads more, as it did until 14/11), and nothing else uses
-- them. This file only removes the indexes and the migration's record.
--
-- What is lost: the speed of the team reports' window reads, of the claim-history window reads and of the bell's list; nothing else. No row, column or
-- constraint is touched. (The schema.prisma `@@index` lines must go with it, or the next `migrate diff` will ask for the indexes again.)
DROP INDEX IF EXISTS "order_contact_attempts_companyId_createdAt_idx";
DROP INDEX IF EXISTS "order_claim_history_companyId_createdAt_idx";
DROP INDEX IF EXISTS "notifications_companyId_userId_createdAt_idx";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114230000_log_table_indexes';
