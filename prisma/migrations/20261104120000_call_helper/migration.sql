-- «مساعد الاتصال» — the OMS side of the Android call helper (docs/call-helper/CONTRACT.md, v1 + v1.1; the app is PR #198).
--
-- THREE NEW TABLES, NOTHING ELSE. No existing table gains, loses or changes a column, and no row anywhere is written: a new
-- table is a catalogue change only, instant on any database. Hand-written; applied locally with `prisma db execute`,
-- recorded with `prisma migrate resolve --applied`, and in production by `prisma migrate deploy` at the owner's Redeploy:
--   npx prisma db execute --file prisma/migrations/20261104120000_call_helper/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261104120000_call_helper
--
--   call_helper_devices    — her paired phone. The token is kept as its SHA-256 only; the callKey (the HMAC key the app
--                            checks a call link with) is encrypted at rest with APP_ENCRYPTION_KEY (src/lib/secrets.ts).
--                            One active device per person: pairing a new one stamps the old one revoked, never deletes it.
--   call_helper_pair_codes — the one-time code in the pairing link: its SHA-256, ten minutes, spent once.
--   call_helper_readings   — what the phone's call log said about ONE call she placed from «طلباتي»: answered or not,
--                            talk and ring seconds. EVIDENCE ONLY — no contact attempt, no order field, no count reads it.
--                            NO PHONE NUMBER is stored: the number is compared with the order's customer, then dropped.
--                            The same reading sent twice is one row (unique device + order + startedAt).
--
-- Idempotent (IF NOT EXISTS / guarded constraints). Rollback: rollback.sql beside this file.

CREATE TABLE IF NOT EXISTS "call_helper_devices" (
  "id"               TEXT NOT NULL,
  "companyId"        TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "deviceName"       TEXT NOT NULL,
  "tokenHash"        TEXT NOT NULL,
  "callKeyEncrypted" TEXT NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"       TIMESTAMP(3),
  "revokedAt"        TIMESTAMP(3),

  CONSTRAINT "call_helper_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "call_helper_devices_tokenHash_key" ON "call_helper_devices" ("tokenHash");
CREATE INDEX IF NOT EXISTS "call_helper_devices_userId_revokedAt_idx" ON "call_helper_devices" ("userId", "revokedAt");
CREATE INDEX IF NOT EXISTS "call_helper_devices_companyId_idx" ON "call_helper_devices" ("companyId");

CREATE TABLE IF NOT EXISTS "call_helper_pair_codes" (
  "id"        TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "codeHash"  TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "call_helper_pair_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "call_helper_pair_codes_codeHash_key" ON "call_helper_pair_codes" ("codeHash");
CREATE INDEX IF NOT EXISTS "call_helper_pair_codes_userId_idx" ON "call_helper_pair_codes" ("userId");

CREATE TABLE IF NOT EXISTS "call_helper_readings" (
  "id"          TEXT NOT NULL,
  "companyId"   TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "deviceId"    TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "startedAt"   TIMESTAMP(3) NOT NULL,
  "answered"    BOOLEAN NOT NULL,
  "talkSeconds" INTEGER NOT NULL,
  "ringSeconds" INTEGER NOT NULL,
  "receivedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "call_helper_readings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "call_helper_readings_deviceId_orderId_startedAt_key"
  ON "call_helper_readings" ("deviceId", "orderId", "startedAt");
CREATE INDEX IF NOT EXISTS "call_helper_readings_userId_orderId_startedAt_idx"
  ON "call_helper_readings" ("userId", "orderId", "startedAt");
CREATE INDEX IF NOT EXISTS "call_helper_readings_companyId_idx" ON "call_helper_readings" ("companyId");

-- The foreign keys: a company, a person or a device that goes takes its own rows with it (a person CAN be deleted —
-- src/app/api/users/[id]/route.ts). No key points at orders: a reading is not part of the order and must never stand in
-- the way of anything done to one.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_helper_devices_companyId_fkey') THEN
    ALTER TABLE "call_helper_devices" ADD CONSTRAINT "call_helper_devices_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_helper_devices_userId_fkey') THEN
    ALTER TABLE "call_helper_devices" ADD CONSTRAINT "call_helper_devices_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_helper_pair_codes_companyId_fkey') THEN
    ALTER TABLE "call_helper_pair_codes" ADD CONSTRAINT "call_helper_pair_codes_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_helper_pair_codes_userId_fkey') THEN
    ALTER TABLE "call_helper_pair_codes" ADD CONSTRAINT "call_helper_pair_codes_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_helper_readings_companyId_fkey') THEN
    ALTER TABLE "call_helper_readings" ADD CONSTRAINT "call_helper_readings_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_helper_readings_userId_fkey') THEN
    ALTER TABLE "call_helper_readings" ADD CONSTRAINT "call_helper_readings_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_helper_readings_deviceId_fkey') THEN
    ALTER TABLE "call_helper_readings" ADD CONSTRAINT "call_helper_readings_deviceId_fkey"
      FOREIGN KEY ("deviceId") REFERENCES "call_helper_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
