-- Rollback for 20261102120000_statement_matching_closed.
-- Run ONLY after the code that splits the approval is reverted.
--
-- REFUSES while any statement has its money posted and its matching still open: the old code reads «approved» as
-- «settled», so such a statement would read closed with its orders never settled. Close its matching first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "courier_statements" WHERE "approvedAt" IS NOT NULL AND "matchingClosedAt" IS NULL) THEN
    RAISE EXCEPTION 'rollback refused: a statement has its money posted and its matching still open — close it first';
  END IF;
END $$;

DROP INDEX IF EXISTS "wallet_movements_statementReceiptId_key";
ALTER TABLE "wallet_movements"   DROP COLUMN IF EXISTS "statementReceiptId";
ALTER TABLE "courier_statements" DROP COLUMN IF EXISTS "matchingClosedById";
ALTER TABLE "courier_statements" DROP COLUMN IF EXISTS "matchingClosedAt";

-- The match rows written as EXCLUDED stay: the old code counts them neither open nor settling, and a re-match
-- rebuilds them as the old judge would.
