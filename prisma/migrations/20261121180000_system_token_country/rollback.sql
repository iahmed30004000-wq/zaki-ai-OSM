-- Rollback of 20261121180000_system_token_country.
-- Run ONLY after the previous release is redeployed: the generated client of this release selects these columns on every
-- SystemToken and LandingChatThread read, so dropping them under it would fail those reads.
-- What is lost: which country each key was bound to. AFTER THE ROLLBACK EVERY COUNTRY-BOUND KEY SEES EVERY COUNTRY of its
-- company again (the old door has no notion of a country) â€” stop the country-bound keys on آ«طھظˆظƒظ†ط§طھ ط§ظ„ط£ظ†ط¸ظ…ط©آ» first if that
-- is not wanted. Also lost: which country each landing chat thread belongs to. Nothing else is touched.
DROP INDEX IF EXISTS "landing_chat_threads_companyId_countryId_idx";
ALTER TABLE "landing_chat_threads" DROP COLUMN IF EXISTS "countryId";
ALTER TABLE "system_tokens" DROP CONSTRAINT IF EXISTS "system_tokens_countryId_fkey";
ALTER TABLE "system_tokens" DROP COLUMN IF EXISTS "countryId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121180000_system_token_country';
