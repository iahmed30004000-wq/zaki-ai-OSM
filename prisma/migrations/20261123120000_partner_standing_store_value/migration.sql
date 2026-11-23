-- «ليش ما تتثبت كم المسحوبات تبعتي بالدولار والدينار وكل عملة بدل ما كل مرة اسجل كم المبلغ؟» — the owner, 23/11 (F7).
--
-- TWO NULLABLE COLUMNS ON "partner_standing_amounts", NOTHING ELSE. No row is written or changed, no other table is touched, and
-- the code that ran before it never reads them. A standing amount may now also carry what it is worth in a store's currency
-- (typed once by the owner), so the wallet dialog and the one press fill «ما يعادله بعملة المتجر» — a pre-fill the person may change.
--   "storeValue"        DECIMAL(14,3) — > 0 when present;
--   "storeCurrencyCode" TEXT          — the store currency "storeValue" is in. Both or neither.
-- The two CHECKs cannot be written in schema.prisma; they live only here and are named in its comments.
--
-- Hand-written; applied locally with `prisma db execute`, recorded with `prisma migrate resolve --applied`, and in production by
-- `prisma migrate deploy` at the owner's Redeploy:
--   npx prisma db execute --file prisma/migrations/20261123120000_partner_standing_store_value/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261123120000_partner_standing_store_value
-- Idempotent (IF NOT EXISTS / guarded constraints). Rollback: rollback.sql beside this file.

ALTER TABLE "partner_standing_amounts" ADD COLUMN IF NOT EXISTS "storeValue" DECIMAL(14,3);
ALTER TABLE "partner_standing_amounts" ADD COLUMN IF NOT EXISTS "storeCurrencyCode" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_standing_amounts_store_value_positive') THEN
    ALTER TABLE "partner_standing_amounts" ADD CONSTRAINT "partner_standing_amounts_store_value_positive"
      CHECK ("storeValue" IS NULL OR "storeValue" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_standing_amounts_store_value_pair') THEN
    ALTER TABLE "partner_standing_amounts" ADD CONSTRAINT "partner_standing_amounts_store_value_pair"
      CHECK (("storeValue" IS NULL) = ("storeCurrencyCode" IS NULL));
  END IF;
END $$;
