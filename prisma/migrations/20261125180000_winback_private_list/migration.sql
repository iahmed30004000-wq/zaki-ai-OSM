-- F12 (the owner's ruling 25/11, «A»): the PRIVATE WIN-BACK LIST. Additive only: three nullable columns on "orders" and one index.
-- Nothing is backfilled: every existing order (the 165 handed out on 25/11 included) keeps NULL and is never a list row.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "winbackListUserId" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "winbackListAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "winbackListSince" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "orders_companyId_storeId_winbackListUserId_idx" ON "orders"("companyId", "storeId", "winbackListUserId");
