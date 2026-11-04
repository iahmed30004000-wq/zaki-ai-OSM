-- الجلسة — two devices per account at once (the owner's ruling 4/11). src/lib/sign-in.ts, src/lib/auth.ts.
--
-- ONE NEW TABLE, NOTHING ELSE. No existing table gains, loses or changes a column, and no row anywhere is written: a new
-- table is a catalogue change only, instant on any database. Hand-written; applied locally with `prisma db execute`,
-- recorded with `prisma migrate resolve --applied`, and in production by `prisma migrate deploy` at the owner's Redeploy:
--   npx prisma db execute --file prisma/migrations/20261104180000_user_sessions/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261104180000_user_sessions
--
--   user_sessions — one row per signed-in device. The session cookie names its row (`sid`). A sign-in keeps the newest
--                   two live rows of the account and stamps the rest revoked ('REPLACED'); a sign-out stamps only its
--                   own ('LOGOUT' / 'IDLE'). Rows are never deleted to end a session.
--
-- NOBODY IS SIGNED OUT BY THIS MIGRATION. A cookie issued before it carries no `sid` and is still read by the old
-- tokenVersion rule until it expires (src/lib/auth.ts).
--
-- Idempotent (IF NOT EXISTS / guarded constraint). Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id"           TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"    TIMESTAMP(3),
  "userAgent"    TEXT,
  "revokeReason" TEXT,

  CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "user_sessions_userId_revokedAt_idx" ON "user_sessions" ("userId", "revokedAt");

-- A person CAN be deleted (src/app/api/users/[id]/route.ts): her sessions go with her.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_sessions_userId_fkey') THEN
    ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
