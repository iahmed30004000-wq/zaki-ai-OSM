-- Rollback for 20261126120000_whatsapp_inbox_media. Run ONLY after the previous release is redeployed (the code that reads these
-- columns no longer live). Idempotent. The rows stay; what is lost is each non-text message's media pointer, caption-side facts,
-- place, reaction and reply link — they show as «[IMAGE]» etc. again. Files already kept under uploads/companies/*/whatsapp/ stay on
-- disk and can be removed by hand.
DROP INDEX IF EXISTS "whatsapp_messages_companyId_conversationId_updatedAt_idx";
ALTER TABLE "whatsapp_conversations" DROP COLUMN IF EXISTS "lastInboundAt";
ALTER TABLE "whatsapp_conversations" DROP COLUMN IF EXISTS "lastMessageType";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "statusError";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "meta";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "reactionToExternalId";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "replyToExternalId";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "longitude";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "latitude";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "mediaStatus";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "mediaSize";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "mediaKey";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "mediaSha256";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "fileName";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "mimeType";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "mediaId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261126120000_whatsapp_inbox_media';
