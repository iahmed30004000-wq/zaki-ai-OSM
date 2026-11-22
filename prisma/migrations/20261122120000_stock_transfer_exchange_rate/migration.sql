-- The exchange rate of a stock transfer between two currencies (2026-11-22, F2).
--   "stock_transfers"."exchangeRate"   units of the destination store's currency for 1 unit of the source store's
--                                      currency, typed at the send, ONLY when the two stores' countries keep their costs
--                                      in different currencies. NULL on every row that exists today and on every
--                                      transfer of one currency, which is then costed exactly as before.
--   stock_transfers_exchange_rate_check  NULL or > 0.
-- ADDITIVE ONLY: one nullable DOUBLE PRECISION column with no default (like "costOut"), one CHECK. No backfill, no row
-- changed. Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent. Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261122120000_stock_transfer_exchange_rate/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261122120000_stock_transfer_exchange_rate
ALTER TABLE "stock_transfers" ADD COLUMN IF NOT EXISTS "exchangeRate" DOUBLE PRECISION;

DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_exchange_rate_check"
    CHECK ("exchangeRate" IS NULL OR "exchangeRate" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
