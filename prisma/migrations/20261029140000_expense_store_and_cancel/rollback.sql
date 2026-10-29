-- Rollback for 20261029140000_expense_store_and_cancel.
--
-- ORDER OF OPERATIONS: deploy the PREVIOUS image first (it never reads these
-- columns), then run this file. Run in the other order and the running
-- container reads columns that are gone.
--
-- WHAT IS LOST, BEFORE YOU RUN IT. Save these two lists first:
--   SELECT id, store_id FROM expenses WHERE store_id IS NOT NULL;
--   SELECT id, voided_at, void_reason, voided_by_id FROM expenses WHERE voided_at IS NOT NULL;
-- After the rollback a cancelled expense counts against profit again (its
-- money is still back in the wallet: the reversing movement is not touched),
-- and every store subtracts every store's expenses again, as before P17.
--
-- Nothing else changes: no row is deleted.
BEGIN;
DROP INDEX IF EXISTS "expenses_companyId_store_id_expenseDate_idx";
ALTER TABLE "expenses" DROP CONSTRAINT IF EXISTS "expenses_store_id_fkey";
ALTER TABLE "expenses" DROP COLUMN IF EXISTS "voided_by_id";
ALTER TABLE "expenses" DROP COLUMN IF EXISTS "void_reason";
ALTER TABLE "expenses" DROP COLUMN IF EXISTS "voided_at";
ALTER TABLE "expenses" DROP COLUMN IF EXISTS "store_id";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029140000_expense_store_and_cancel';
COMMIT;
