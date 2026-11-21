-- Rollback of 20261121150000_pages_cc_sender.
--
-- Run ONLY after the previous release is redeployed: the generated client of this release selects these columns on every
-- Order and AppDelivery read, so dropping them under it would fail those reads. What is lost: which Zaki Pages orders
-- Pages sends the custom conversions for (after the rollback this system sends them again, as before the release), the
-- pixel id and slug those orders reported, and the idempotency keys of the queued order-status events (a queued row is
-- still sent; a repeat of the same status could then be queued twice).

DROP INDEX IF EXISTS "app_deliveries_installId_idempotencyKey_key";

ALTER TABLE "app_deliveries" DROP COLUMN IF EXISTS "idempotencyKey";

ALTER TABLE "orders"
  DROP COLUMN IF EXISTS "ccSender",
  DROP COLUMN IF EXISTS "lpPixelId",
  DROP COLUMN IF EXISTS "externalPageSlug";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121150000_pages_cc_sender';
