-- «أبواب الميديا باير — PR-A» (the media buyer's doors, 17/11): what the media buyer's link adds to a landing order, and the daily spend per ad.
-- ADDITIVE ONLY: four NULLABLE columns on "orders" and one NEW table. Nothing is dropped, renamed, retyped or backfilled.
--
--   orders."adName" "utmSource" "utmMedium" "landingUrl"   — the ad's name, the utm source and medium, and the link the visitor opened (no query): nothing about a customer.
--                                                            The ad, ad set and campaign ids already have their columns (migration 20261117130000_landing_ad_attribution:
--                                                            "adId", "refCode", "metaCampaignId") and the click/browser cookies "fbcEnc" / "fbpEnc" — none is added here.
--   ad_spend_days                                          — what one ad spent on one day (the grain `GET /api/v1/ad-spend` reads)
--
-- A nullable ADD COLUMN without a default is a catalogue-only change in PostgreSQL: no row is rewritten and the code that ran
-- before never selects the columns. NULL on every order that exists today, which is what the media buyer's frozen contract
-- already says for an order that carried no tag (`ad_name` and `landing_page` are null).
-- The new table starts EMPTY: the 00:10 and 06:00 spend pulls fill it (31 days the first time an account is seen, 7 afterwards).
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS). Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261117140000_mediabuyer_ad_tags_and_daily_spend/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261117140000_mediabuyer_ad_tags_and_daily_spend
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy (docker-entrypoint.sh runs it BEFORE the new image serves).
-- Rollback: rollback.sql beside this file.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "adName"     TEXT,
  ADD COLUMN IF NOT EXISTS "utmSource"  TEXT,
  ADD COLUMN IF NOT EXISTS "utmMedium"  TEXT,
  ADD COLUMN IF NOT EXISTS "landingUrl" TEXT;

CREATE TABLE IF NOT EXISTS "ad_spend_days" (
  "id"          TEXT           NOT NULL,
  "companyId"   TEXT           NOT NULL,
  "storeId"     TEXT           NOT NULL,
  "adAccountId" TEXT           NOT NULL,
  "date"        DATE           NOT NULL,
  "adId"        TEXT           NOT NULL,
  "adsetId"     TEXT,
  "campaignId"  TEXT,
  "spend"       DECIMAL(14,3)  NOT NULL,
  "currency"    TEXT           NOT NULL,
  "impressions" INTEGER,
  "linkClicks"  INTEGER,
  "pulledAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ad_spend_days_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ad_spend_days_companyId_date_adId_key"    ON "ad_spend_days" ("companyId", "date", "adId");
CREATE INDEX        IF NOT EXISTS "ad_spend_days_companyId_date_adId_idx"    ON "ad_spend_days" ("companyId", "date", "adId");
CREATE INDEX        IF NOT EXISTS "ad_spend_days_companyId_date_adsetId_idx" ON "ad_spend_days" ("companyId", "date", "adsetId");
CREATE INDEX        IF NOT EXISTS "ad_spend_days_companyId_date_campaignId_idx" ON "ad_spend_days" ("companyId", "date", "campaignId");
