-- «السلة صارت طلب لحالها» — an abandoned cart with a name and a phone becomes an order by itself (the owner, 17/11):
-- ONE NULLABLE COLUMN ON ONE TABLE.
--
--   abandoned_carts."autoOrderAt" TIMESTAMP(3)
--       When the cart was taken to become an order by itself. Written once, by a conditional update
--       (`WHERE "autoOrderAt" IS NULL`) that only one caller can win — the landing door's upsert and the job that converts
--       the carts that waited may reach the same cart at the same moment, and only one of them makes the order. NULL on
--       every row that exists today, which is what lets the job convert the carts that were already waiting.
--
-- ADDITIVE ONLY: no default, no backfill, no index, no row changed. A nullable ADD COLUMN without a default is a
-- catalogue-only change in PostgreSQL. The code that ran before never selects the column and is not affected by its being
-- there. Hand-written (AGENTS.md: never `migrate dev`, never a reset), with IF NOT EXISTS. Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261117120000_abandoned_cart_auto_order/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261117120000_abandoned_cart_auto_order
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy (docker-entrypoint.sh runs it BEFORE the new image
-- serves, so the column exists first).
-- Idempotent (IF NOT EXISTS). Rollback: rollback.sql beside this file.
ALTER TABLE "abandoned_carts"
  ADD COLUMN IF NOT EXISTS "autoOrderAt" TIMESTAMP(3);
