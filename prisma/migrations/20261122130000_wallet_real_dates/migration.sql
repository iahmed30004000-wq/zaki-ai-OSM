-- THE REAL DATE OF A MOVEMENT AND OF A TRANSFER (2026-11-22).
--
--   "wallet_movements"."occurredAt"  when the money really moved, as the person typed it.
--   "wallet_transfers"."occurredAt"  when the transfer really happened; its two legs carry the same.
--
-- NULL = the same moment as "createdAt" (the registration). No backfill: every row that exists today keeps NULL and reads
-- exactly as before. Nothing that adds money up reads these columns: balances, daily closings, matching, profit to date and the
-- partners' statement stay on "createdAt".
--
-- ADDITIVE ONLY: two nullable columns, no default, no index, no row changed.

ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMP(3);

ALTER TABLE "wallet_transfers" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMP(3);
