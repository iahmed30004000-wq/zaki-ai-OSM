-- «افصل المطابقة عن التحصيل» (the owner, 2/11): two acts, two stamps.
--
--   "approvedAt"       — the MONEY was posted: one wallet IN per receipt (unchanged).
--   "matchingClosedAt" — the MATCHING was closed: the orders settled. The approval closes it in the same act when no
--                        line is open; otherwise «إغلاق المطابقة» closes it later and writes no money.
--
-- Additive only: two nullable columns, one nullable column with a plain unique index, and a backfill that writes
-- ONLY the new columns. Hand-written; applied locally with `prisma db execute`, recorded with
-- `prisma migrate resolve --applied`, and in production by `prisma migrate deploy` at the owner's Redeploy.

ALTER TABLE "courier_statements" ADD COLUMN IF NOT EXISTS "matchingClosedAt"   TIMESTAMP(3);
ALTER TABLE "courier_statements" ADD COLUMN IF NOT EXISTS "matchingClosedById" TEXT;

-- Every statement approved before this migration settled its orders in the same act: its matching is closed.
-- Idempotent. A statement approved by the old code during the Redeploy needs no second run: «إغلاق المطابقة»
-- recognises it (its movements carry no receipt) and only stamps it.
UPDATE "courier_statements"
   SET "matchingClosedAt"   = COALESCE("approvedAt", "updatedAt"),
       "matchingClosedById" = "approvedById"
 WHERE "matchingClosedAt" IS NULL
   AND ("approvedAt" IS NOT NULL OR "status" = 'APPROVED');

-- One wallet movement per statement receipt, held by the database. A plain unique index: Postgres treats every
-- NULL as distinct, so the movements that are not a receipt's (all of them before this migration, every hand row,
-- every reversal — a reversal does not copy the column) never meet it.
ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "statementReceiptId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_movements_statementReceiptId_key"
  ON "wallet_movements"("statementReceiptId");
