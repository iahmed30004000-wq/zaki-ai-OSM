-- «سعر تكلفة المنتج ثابت» — the table that holds it (the owner, 1/11). ADDITIVE: one new table, nothing existing is touched.
--
-- ONE ROW PER PRODUCT, IN ITS OWN TABLE. A column on `products` would be read with every product row — including the reads that
-- answer a customer — and a cost must never ride along with those. A new table is read only by the code that names it.
--
-- NOTHING IS WRITTEN. No row is inserted for any existing product: «no row» means «no fixed cost yet», and such a product costs what
-- it always did (the weighted average of its batches). An admin sets each one by hand from the products list.
--
-- THE TABLE MUST EXIST BEFORE THE NEW CODE RUNS. On the server docker-entrypoint.sh runs `prisma migrate deploy` before the server
-- starts, which is that order. For a local trial apply it by hand, never with `migrate dev`:
--   npx prisma db execute --file prisma/migrations/20261101120000_product_fixed_cost/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261101120000_product_fixed_cost
--
-- Idempotent (IF NOT EXISTS): running it twice changes nothing. Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "product_fixed_costs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "setById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_fixed_costs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_fixed_costs_productId_key" ON "product_fixed_costs"("productId");

CREATE INDEX IF NOT EXISTS "product_fixed_costs_companyId_idx" ON "product_fixed_costs"("companyId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_fixed_costs_companyId_fkey') THEN
    ALTER TABLE "product_fixed_costs"
      ADD CONSTRAINT "product_fixed_costs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_fixed_costs_productId_fkey') THEN
    ALTER TABLE "product_fixed_costs"
      ADD CONSTRAINT "product_fixed_costs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
