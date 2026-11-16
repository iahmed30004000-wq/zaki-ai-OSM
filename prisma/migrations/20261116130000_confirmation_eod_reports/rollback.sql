-- Rollback for 20261116130000_confirmation_eod_reports.
-- Run ONLY after the code that reads or writes the table is reverted. THIS DROPS THE REPORTS THE TEAM LEADER SUBMITTED: export them first if they are wanted
-- (SELECT * FROM "confirmation_eod_reports"). Nothing else references the table.
DROP TABLE IF EXISTS "confirmation_eod_reports";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261116130000_confirmation_eod_reports';
