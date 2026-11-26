-- WhatsApp inbox: every message kind, not text alone. Additive only: nullable columns, one index, one backfill.
-- whatsapp_messages gains what Meta sends with a photo, a voice note, a video, a file, a sticker, a place, a contact card,
-- a reaction, a reply and a button press; the media file itself is fetched from Graph and kept under uploads/ (mediaKey).
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "mediaId" TEXT;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "mimeType" TEXT;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "fileName" TEXT;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "mediaSha256" TEXT;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "mediaKey" TEXT;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "mediaSize" INTEGER;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "mediaStatus" TEXT;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "replyToExternalId" TEXT;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "reactionToExternalId" TEXT;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "meta" JSONB;
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "statusError" TEXT;
-- The open thread's poll asks «what changed since» (a new message, or a tick that moved): by conversation and updatedAt.
CREATE INDEX IF NOT EXISTS "whatsapp_messages_companyId_conversationId_updatedAt_idx" ON "whatsapp_messages"("companyId", "conversationId", "updatedAt");

-- whatsapp_conversations: the kind of the last message (the list draws its icon) and when the customer last wrote
-- (Meta's 24-hour customer-service window opens from that moment).
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "lastMessageType" TEXT;
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "lastInboundAt" TIMESTAMP(3);
UPDATE "whatsapp_conversations" c
SET "lastInboundAt" = m."at"
FROM (
  SELECT "conversationId", MAX("createdAt") AS "at"
  FROM "whatsapp_messages"
  WHERE "direction" = 'INBOUND'
  GROUP BY "conversationId"
) m
WHERE m."conversationId" = c."id" AND c."lastInboundAt" IS NULL;
