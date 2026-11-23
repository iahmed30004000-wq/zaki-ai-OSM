-- A system key may be bound to ONE store of its company (2026-11-23: Zaki Pages runs several independent stores in one
-- country, each store linked to this system with its own key).
--   "system_tokens"."storeId"         the one store the key sees. NULL = every store of its country (or of the company) —
--                                     exactly what every key made before this release does, so no existing key changes.
--                                     A store-bound key is also bound to that store's country ("countryId"), so every
--                                     country rule of the landing door holds for it too.
--   "landing_chat_threads"."storeId"  the store of the landing key that opened the thread. NULL on every thread that exists
--                                     today, and on every thread a key that is not store-bound opens.
-- Honoured by the landing door only (src/lib/v1/landing-country.ts). Every other /api/v1 door refuses a bound key.
-- ADDITIVE ONLY: two nullable TEXT columns with no default, one foreign key (RESTRICT: a store with a key bound to it is
-- not deleted from under the key, which would otherwise widen it to the whole country), one index. No row changed.
ALTER TABLE "system_tokens" ADD COLUMN IF NOT EXISTS "storeId" TEXT;
ALTER TABLE "landing_chat_threads" ADD COLUMN IF NOT EXISTS "storeId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_tokens_storeId_fkey') THEN
    ALTER TABLE "system_tokens"
      ADD CONSTRAINT "system_tokens_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "landing_chat_threads_companyId_storeId_idx" ON "landing_chat_threads"("companyId", "storeId");
