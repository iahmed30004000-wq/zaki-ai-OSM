-- Rollback of 20261117120000_abandoned_cart_auto_order.
-- Run ONLY after the previous release is redeployed: the generated client of this release selects "autoOrderAt" on every
-- AbandonedCart read, so dropping the column under it would fail those reads. What is lost: only the marks saying which
-- carts were already taken to become an order by themselves. No order is lost (an automatic order is an ordinary order and
-- the cart keeps pointing at it); nothing else reads the column.
ALTER TABLE "abandoned_carts"
  DROP COLUMN IF EXISTS "autoOrderAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117120000_abandoned_cart_auto_order';
