-- Which ad a standalone landing-page order came from (contract oms-lp.v1 §4): SIX NULLABLE TEXT COLUMNS ON "orders".
--
--   "metaCampaignId"        the Meta campaign id (utm_campaign). NOT "campaignId", which is a foreign key to this system's campaigns.
--   "externalLandingPageId" the landing system's own page id ("landingPageId" is a foreign key to this system's pages).
--   "fbcEnc", "fbpEnc"      Meta's click and browser cookies, ENCRYPTED with encryptSecret (like "ctwaClidEnc").
--   "clientUserAgent"       the visitor's browser, for Meta's user_data.
--   "lpPurchaseEventId"     the landing system's own Purchase event id for the order, kept for reference.
--
-- Written only by the landing door (src/lib/v1/landing-attribution.ts), after the order is created. NULL on every row that exists today.
--
-- ADDITIVE ONLY: no default, no backfill, no index, no row changed. A nullable ADD COLUMN without a default is a catalogue-only change in PostgreSQL.
-- The code that ran before never selects these columns and is not affected by their being there. Hand-written (AGENTS.md: never `migrate dev`,
-- never a reset), with IF NOT EXISTS. Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261117130000_landing_ad_attribution/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261117130000_landing_ad_attribution
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy (docker-entrypoint.sh runs it BEFORE the new image serves, so the columns exist first).
--
-- Idempotent (IF NOT EXISTS). Rollback: rollback.sql beside this file.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "metaCampaignId" TEXT,
  ADD COLUMN IF NOT EXISTS "externalLandingPageId" TEXT,
  ADD COLUMN IF NOT EXISTS "fbcEnc" TEXT,
  ADD COLUMN IF NOT EXISTS "fbpEnc" TEXT,
  ADD COLUMN IF NOT EXISTS "clientUserAgent" TEXT,
  ADD COLUMN IF NOT EXISTS "lpPurchaseEventId" TEXT;
