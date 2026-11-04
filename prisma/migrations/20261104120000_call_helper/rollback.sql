-- Rollback for 20261104120000_call_helper.
-- Run ONLY after the code and the generated client of this release are reverted: the desk («طلباتي») of this release reads
-- call_helper_devices. Order: redeploy the old release, THEN run this file.
--
-- What is lost: every pairing (each phone is paired again from «طلباتي») and every reading (evidence only — no order, no
-- contact attempt and no number reads them). Nothing else in the database is touched.
DROP TABLE IF EXISTS "call_helper_readings";
DROP TABLE IF EXISTS "call_helper_pair_codes";
DROP TABLE IF EXISTS "call_helper_devices";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261104120000_call_helper';
