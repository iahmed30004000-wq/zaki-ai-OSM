-- «السلات المهجورة» — one cart per customer per product, not one per visit (the owner, 21/11).
--
-- ONE NEW TABLE, NOTHING ELSE. Zaki pages gives every visit its own externalId; when a second visit of the same phone for
-- the same product reaches the landing door within a day while the first cart is still open, the door updates that cart and
-- keeps the second externalId here, so Zaki pages' later calls with it (a re-send, `/recovered`) find the same cart.
-- No existing table or column is touched, no row is written, and the code that ran before this never reads it. A new table
-- is a catalogue change, instant whatever the size of the database. Hand-written (what `prisma migrate diff` prints for the
-- schema change, made idempotent); applied locally with `prisma db execute`, recorded with
-- `prisma migrate resolve --applied`, and in production by `prisma migrate deploy` at the owner's Redeploy:
--   npx prisma db execute --file prisma/migrations/20261121120000_abandoned_cart_aliases/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261121120000_abandoned_cart_aliases
--
--   abandoned_cart_aliases — one row per (company, externalId) that was folded into an existing cart; goes with its cart
--                            and with its company.
--
-- Idempotent (IF NOT EXISTS / guarded constraints). Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "abandoned_cart_aliases" (
    "id"         TEXT NOT NULL,
    "companyId"  TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "cartId"     TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abandoned_cart_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "abandoned_cart_aliases_companyId_externalId_key"
  ON "abandoned_cart_aliases" ("companyId", "externalId");
CREATE INDEX IF NOT EXISTS "abandoned_cart_aliases_cartId_idx"
  ON "abandoned_cart_aliases" ("cartId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abandoned_cart_aliases_companyId_fkey') THEN
    ALTER TABLE "abandoned_cart_aliases" ADD CONSTRAINT "abandoned_cart_aliases_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abandoned_cart_aliases_cartId_fkey') THEN
    ALTER TABLE "abandoned_cart_aliases" ADD CONSTRAINT "abandoned_cart_aliases_cartId_fkey"
      FOREIGN KEY ("cartId") REFERENCES "abandoned_carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
