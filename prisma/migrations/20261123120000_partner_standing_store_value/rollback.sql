-- Rollback for 20261123120000_partner_standing_store_value.
-- Run ONLY after the code and the generated client of this release are reverted: this release reads and writes the two columns.
-- Order: redeploy the old release, THEN run this file. Idempotent: safe to run twice.
--
-- What is lost: the store-currency equivalents typed beside the standing amounts (a pre-fill, not money). The standing amounts
-- themselves, the wallet movements and every other row stay as they are.
ALTER TABLE "partner_standing_amounts" DROP CONSTRAINT IF EXISTS "partner_standing_amounts_store_value_pair";
ALTER TABLE "partner_standing_amounts" DROP CONSTRAINT IF EXISTS "partner_standing_amounts_store_value_positive";
ALTER TABLE "partner_standing_amounts" DROP COLUMN IF EXISTS "storeCurrencyCode";
ALTER TABLE "partner_standing_amounts" DROP COLUMN IF EXISTS "storeValue";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123120000_partner_standing_store_value';
