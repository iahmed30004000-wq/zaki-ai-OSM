-- The WhatsApp order bot. Additive only: new columns with defaults, one new table, one index. No row is rewritten.
--
-- whatsapp_conversations: the bot's state per conversation — paused (and why, and since when), handed to staff,
-- busy with a turn (one at a time; the inbox draws «يكتب…» from it), and when it last changed an order there.
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "botPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "botPausedReason" TEXT;
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "botPausedAt" TIMESTAMP(3);
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "botHandoff" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "botBusyUntil" TIMESTAMP(3);
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "botChangedAt" TIMESTAMP(3);

-- whatsapp_messages: which outbound lines the bot wrote (the thread labels them, and the hourly cap counts them).
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "sentByBot" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "whatsapp_messages_conversationId_sentByBot_createdAt_idx" ON "whatsapp_messages"("conversationId", "sentByBot", "createdAt");

-- whatsapp_bot_settings: one row per company — the switch, the name, the owner's words, the model and its sealed key.
CREATE TABLE IF NOT EXISTS "whatsapp_bot_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL DEFAULT 'سارة',
    "avatarText" TEXT,
    "persona" TEXT NOT NULL DEFAULT '',
    "productNotes" JSONB,
    "baseUrl" TEXT NOT NULL DEFAULT 'https://glm.erv.zakiai.io/v1',
    "model" TEXT,
    "apiKeyEncrypted" TEXT,
    "apiKeyHint" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_bot_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_bot_settings_companyId_key" ON "whatsapp_bot_settings"("companyId");
DO $$ BEGIN
  ALTER TABLE "whatsapp_bot_settings" ADD CONSTRAINT "whatsapp_bot_settings_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
