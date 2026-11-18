-- «رسائل اللاندينج» (18/11): the landing chat inbox — every conversation of Zaki pages' chat assistant, relayed here message by message
-- (contract oms-lp.v1 §11), answered by the staff, with the bot paused per thread while a person answers.
-- ADDITIVE ONLY: TWO NEW TABLES, empty. Nothing is altered, dropped or backfilled.
--
--   landing_chat_threads  (one Zaki pages chat session per row, unique per company on "externalId"; page, product, order, customer, pause, unread)
--   landing_chat_messages (its lines; "seq" BIGSERIAL = the company-wide reading order of `GET /chat/updates`; unique per thread on "externalId")
--
-- Hand-written (AGENTS.md: never `migrate dev`, never a reset), idempotent (IF NOT EXISTS). Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261118150000_landing_chat_inbox/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261118150000_landing_chat_inbox
--   npx prisma generate
-- and in production by `prisma migrate deploy` at the owner's Redeploy. Rollback: rollback.sql beside this file.
CREATE TABLE IF NOT EXISTS "landing_chat_threads" (
  "id"                 TEXT         NOT NULL,
  "companyId"          TEXT         NOT NULL,
  "externalId"         TEXT         NOT NULL,
  "mode"               TEXT         NOT NULL DEFAULT 'confirm',
  "pageId"             TEXT,
  "pageSlug"           TEXT,
  "pageName"           TEXT,
  "pageUrl"            TEXT,
  "productId"          TEXT,
  "productName"        TEXT,
  "orderNumber"        TEXT,
  "orderId"            TEXT,
  "customerName"       TEXT,
  "customerPhone"      TEXT,
  "botPaused"          BOOLEAN      NOT NULL DEFAULT false,
  "botPausedAt"        TIMESTAMP(3),
  "botPausedById"      TEXT,
  "unreadCount"        INTEGER      NOT NULL DEFAULT 0,
  "lastMessageAt"      TIMESTAMP(3),
  "lastMessagePreview" TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "landing_chat_threads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "landing_chat_threads_companyId_externalId_key" ON "landing_chat_threads" ("companyId", "externalId");
CREATE INDEX IF NOT EXISTS "landing_chat_threads_companyId_lastMessageAt_idx" ON "landing_chat_threads" ("companyId", "lastMessageAt");

CREATE TABLE IF NOT EXISTS "landing_chat_messages" (
  "id"         TEXT         NOT NULL,
  "seq"        BIGSERIAL    NOT NULL,
  "companyId"  TEXT         NOT NULL,
  "threadId"   TEXT         NOT NULL,
  "externalId" TEXT,
  "direction"  TEXT         NOT NULL,
  "text"       TEXT,
  "event"      TEXT,
  "authorId"   TEXT,
  "authorName" TEXT,
  "sentAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "landing_chat_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "landing_chat_messages_seq_key" ON "landing_chat_messages" ("seq");
CREATE UNIQUE INDEX IF NOT EXISTS "landing_chat_messages_threadId_externalId_key" ON "landing_chat_messages" ("threadId", "externalId");
CREATE INDEX IF NOT EXISTS "landing_chat_messages_companyId_seq_idx" ON "landing_chat_messages" ("companyId", "seq");
CREATE INDEX IF NOT EXISTS "landing_chat_messages_threadId_seq_idx" ON "landing_chat_messages" ("threadId", "seq");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'landing_chat_threads_companyId_fkey') THEN
    ALTER TABLE "landing_chat_threads" ADD CONSTRAINT "landing_chat_threads_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'landing_chat_messages_threadId_fkey') THEN
    ALTER TABLE "landing_chat_messages" ADD CONSTRAINT "landing_chat_messages_threadId_fkey"
      FOREIGN KEY ("threadId") REFERENCES "landing_chat_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
