-- Rollback for 20261117100000_leads.
-- Run ONLY after the code that reads or writes the table is reverted. THIS DROPS THE LEADS THE PAGES SYSTEM SENT: export them first if they are wanted
-- (SELECT * FROM "leads"). Nothing else references the table.
DROP TABLE IF EXISTS "leads";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117100000_leads';
