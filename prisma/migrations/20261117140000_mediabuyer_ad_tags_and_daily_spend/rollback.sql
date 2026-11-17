-- Rollback of 20261117140000_mediabuyer_ad_tags_and_daily_spend.
-- Run ONLY after the previous release is redeployed: the generated client of this release selects the new "orders" columns on every
-- order read through the attribution door and reads "ad_spend_days", so dropping them under it would fail those reads.
-- What is lost: the ad's name, the utm source and medium and the page link stamped on landing orders since the release, and the daily spend
-- rows (the 00:10 / 06:00 pulls refill 31 days on their next run). No order, no customer, no id and no money figure is lost.
DROP TABLE IF EXISTS "ad_spend_days";
ALTER TABLE "orders"
  DROP COLUMN IF EXISTS "adName",
  DROP COLUMN IF EXISTS "utmSource",
  DROP COLUMN IF EXISTS "utmMedium",
  DROP COLUMN IF EXISTS "landingUrl";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117140000_mediabuyer_ad_tags_and_daily_spend';
