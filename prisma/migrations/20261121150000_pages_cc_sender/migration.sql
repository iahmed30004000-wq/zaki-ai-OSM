-- What Zaki Pages adds to its orders, and the order-status events this system sends back to it (2026-11-21).
--
--   "orders"."ccSender"          who sends the order's custom conversions to Meta: 'pages' = Zaki Pages does, and this
--                                system's sender skips the order; NULL = this system sends, exactly as before.
--   "orders"."lpPixelId"         the Meta pixel id the Zaki Pages page fired, for reference.
--   "orders"."externalPageSlug"  the page's slug in Zaki Pages, beside "externalLandingPageId".
--   "app_deliveries"."idempotencyKey"  one row per fact on the order-status events to Zaki Pages
--                                ('pages.order_status:<companyId>:<orderId>:<status>'); NULL on every other row.
--
-- Written only by the landing door (src/lib/v1/landing-attribution.ts) and by emitPagesOrderStatus (src/lib/apps/events.ts).
-- NULL on every row that exists today.
--
-- ADDITIVE ONLY: four nullable TEXT columns with no default, and one unique index over ("installId", "idempotencyKey").
-- No backfill, no row changed. Every existing app_deliveries row has a NULL key, and PostgreSQL never counts two NULLs as
-- the same value, so the index cannot fail on the rows already there.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "ccSender" TEXT,
  ADD COLUMN IF NOT EXISTS "lpPixelId" TEXT,
  ADD COLUMN IF NOT EXISTS "externalPageSlug" TEXT;

ALTER TABLE "app_deliveries" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "app_deliveries_installId_idempotencyKey_key" ON "app_deliveries"("installId", "idempotencyKey");
