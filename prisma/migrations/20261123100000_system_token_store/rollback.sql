-- Rollback of 20261123100000_system_token_store.
-- Run ONLY after the previous release is redeployed: the generated client of this release selects these columns on every
-- SystemToken and LandingChatThread read, so dropping them under it would fail those reads.
-- What is lost: which store each key was bound to. AFTER THE ROLLBACK EVERY STORE-BOUND KEY SEES EVERY STORE OF ITS
-- COUNTRY again (it keeps its country) — stop the store-bound keys on «توكنات الأنظمة» first if that is not wanted.
-- Also lost: which store each landing chat thread belongs to. Nothing else is touched.
DROP INDEX IF EXISTS "landing_chat_threads_companyId_storeId_idx";
ALTER TABLE "landing_chat_threads" DROP COLUMN IF EXISTS "storeId";
ALTER TABLE "system_tokens" DROP CONSTRAINT IF EXISTS "system_tokens_storeId_fkey";
ALTER TABLE "system_tokens" DROP COLUMN IF EXISTS "storeId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123100000_system_token_store';
