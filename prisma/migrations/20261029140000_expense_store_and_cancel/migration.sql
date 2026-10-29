-- AN EXPENSE BELONGS TO A STORE, AND CAN BE CANCELLED (P17 + P18).
--
-- P17 — until now `expenses` had no store column, so every store's profit
-- subtracted EVERY store's expenses. This adds the column, a foreign key to
-- stores and the index the profit read uses. New expenses fill it from the
-- store they were recorded in (src/app/api/finance/route.ts).
--
-- P18 — reversing the money of an expense returned it to the wallet but the
-- expense kept counting against profit. Three columns say «cancelled, when,
-- why, by whom»; a cancelled expense stays on the list and leaves the profit
-- (src/lib/expense-void.ts, src/lib/wallets.ts reverseMovement).
--
-- ADDITIVE ONLY, AND IT WRITES NO DATA. Four nullable columns, one foreign
-- key, one index. There is NO backfill in this file on purpose: this runs on
-- every container start (`prisma migrate deploy`), and filling `store_id` of
-- the old rows would move every store's profit the moment the image
-- deploys. An old row keeps a NULL store and is read exactly as before. The
-- backfill is a manual script the owner runs by his own press:
-- scripts/backfills/20261029-expenses-get-their-store.sql
--
-- Every statement is idempotent (IF NOT EXISTS), so a re-run changes nothing.
-- To undo: rollback.sql next to this file.

ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "store_id" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "voided_at" TIMESTAMP(3);
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "void_reason" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "voided_by_id" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_store_id_fkey') THEN
    ALTER TABLE "expenses" ADD CONSTRAINT "expenses_store_id_fkey"
      FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "expenses_companyId_store_id_expenseDate_idx"
  ON "expenses"("companyId", "store_id", "expenseDate");
