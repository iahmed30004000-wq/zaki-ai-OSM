-- Rollback for 20261126190000_whatsapp_order_bot. Run ONLY after the previous release is redeployed (the code that reads
-- these columns no longer live). Idempotent. What is lost: the bot's settings (its name, the owner's words, the sealed model
-- key — the owner enters them again), each conversation's pause and hand-off flags, and which outbound lines the bot wrote
-- (they stay in the thread as ordinary outbound messages). No order is touched: the bot's order changes are in the orders'
-- own history and the audit log.
DROP TABLE IF EXISTS "whatsapp_bot_settings";
DROP INDEX IF EXISTS "whatsapp_messages_conversationId_sentByBot_createdAt_idx";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "sentByBot";
ALTER TABLE "whatsapp_conversations" DROP COLUMN IF EXISTS "botChangedAt";
ALTER TABLE "whatsapp_conversations" DROP COLUMN IF EXISTS "botBusyUntil";
ALTER TABLE "whatsapp_conversations" DROP COLUMN IF EXISTS "botHandoff";
ALTER TABLE "whatsapp_conversations" DROP COLUMN IF EXISTS "botPausedAt";
ALTER TABLE "whatsapp_conversations" DROP COLUMN IF EXISTS "botPausedReason";
ALTER TABLE "whatsapp_conversations" DROP COLUMN IF EXISTS "botPaused";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261126190000_whatsapp_order_bot';
