-- A system key may be bound to ONE country of its company (2026-11-21: Zaki Pages runs per country, each country with
-- its own key to this system).
--   "system_tokens"."countryId"         the one country the key sees. NULL = every country of the company â€” exactly what
--                                       every key made before this release does, so no existing key changes.
--   "landing_chat_threads"."countryId"  the country of the landing key that opened the thread. NULL on every thread that
--                                       exists today, and on every thread a key for every country opens.
-- Honoured by the landing door only (src/lib/v1/landing-country.ts). Every other /api/v1 door refuses a country-bound key.
-- ADDITIVE ONLY: two nullable TEXT columns with no default, one foreign key (RESTRICT: a country with a key bound to it is
-- not deleted from under the key, which would otherwise widen to every country), two indexes. No backfill, no row changed.
ALTER TABLE "system_tokens" ADD COLUMN IF NOT EXISTS "countryId" TEXT;
ALTER TABLE "landing_chat_threads" ADD COLUMN IF NOT EXISTS "countryId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_tokens_countryId_fkey') THEN
    ALTER TABLE "system_tokens"
      ADD CONSTRAINT "system_tokens_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "landing_chat_threads_companyId_countryId_idx" ON "landing_chat_threads"("companyId", "countryId");
