-- Rollback of 20261117130000_landing_ad_attribution.
--
-- Run ONLY after the previous release is redeployed: the generated client of this release selects these columns on every Order read, so dropping
-- them under it would fail those reads. What is lost: the ad attribution of landing-page orders written since the release (the landing system keeps
-- its own copy of the utm values per order), and the sealed click ids the conversions sender would have sent to Meta.

ALTER TABLE "orders"
  DROP COLUMN IF EXISTS "metaCampaignId",
  DROP COLUMN IF EXISTS "externalLandingPageId",
  DROP COLUMN IF EXISTS "fbcEnc",
  DROP COLUMN IF EXISTS "fbpEnc",
  DROP COLUMN IF EXISTS "clientUserAgent",
  DROP COLUMN IF EXISTS "lpPurchaseEventId";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117130000_landing_ad_attribution';
