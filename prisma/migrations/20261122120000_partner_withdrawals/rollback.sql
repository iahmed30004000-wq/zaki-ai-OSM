-- Rollback for 20261122120000_partner_withdrawals.
-- Run ONLY after the code and the generated client of this release are reverted: this release's «المسحوبات» tab and its door read
-- and write the two tables. Order: redeploy the old release, THEN run this file.
--
-- What is lost: the standing amounts and the record of withdrawals (and their cancels). No money is lost with them: they moved no
-- wallet and were never part of the profit or of the partners' statement. Nothing else in the database is touched.
DROP TABLE IF EXISTS "partner_withdrawals";
DROP TABLE IF EXISTS "partner_standing_amounts";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261122120000_partner_withdrawals';
