-- Rollback of 20261117140000_mediabuyer_ad_tags_and_daily_spend.
-- Run ONLY after the previous release is redeployed: the generated client of this release selects the new "orders" columns on every
-- order read through the attribution door and reads "ad_spend_days", so dropping them under it would fail those reads.
-- What is lost: the ad tags stamped on Pages orders since the release (the ad evidence the media buyer reads), and the daily spend
-- rows (the 06:00 pull refills 31 days on its next run). No order, no customer and no money figure is lost.
DROP TABLE IF EXISTS "ad_spend_days";
ALTER TABLE "orders"
  DROP COLUMN IF EXISTS "adsetId",
  DROP COLUMN IF EXISTS "adCampaignId",
  DROP COLUMN IF EXISTS "adName",
  DROP COLUMN IF EXISTS "utmSource",
  DROP COLUMN IF EXISTS "utmMedium",
  DROP COLUMN IF EXISTS "utmCampaign",
  DROP COLUMN IF EXISTS "utmTerm",
  DROP COLUMN IF EXISTS "utmContent",
  DROP COLUMN IF EXISTS "landingUrl",
  DROP COLUMN IF EXISTS "fbclidEnc",
  DROP COLUMN IF EXISTS "fbcEnc",
  DROP COLUMN IF EXISTS "fbpEnc";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117140000_mediabuyer_ad_tags_and_daily_spend';
