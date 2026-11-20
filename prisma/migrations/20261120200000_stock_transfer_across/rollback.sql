-- Rollback of 20261120200000_stock_transfer_across. Idempotent: running it twice is the same as running it once.
-- Run ONLY after the previous release is redeployed: this release's Prisma client knows these columns.
--
-- The previous release knows INTERNAL transfers only. Before the columns go:
--   1. A transfer to another country still AWAITING_APPROVAL moved nothing (no batch, no ledger line): it is written
--      CANCELLED, so the narrow status check can come back and the old screens read a word they know.
--   2. A transfer ACROSS stores that was sent cannot be read by the previous release (it would think the goods are on
--      a road inside one store, and they are not — they left the source as a draw-down). Its rows stay, with their
--      kind; only this file's columns go. Do not roll back while one is SENT and not received: receive or cancel it
--      first (the units of a received or cancelled one are already in a batch and stay there — no quantity is lost by
--      this file; only the destination store, the twin and the cost figures written on the document are).
UPDATE "stock_transfers" SET "status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP,
       "cancelReason" = COALESCE("cancelReason", 'رجوع عن نسخة النقل بين المتاجر قبل اعتماد المالك')
 WHERE "status" = 'AWAITING_APPROVAL';

ALTER TABLE IF EXISTS "stock_transfer_lines" DROP CONSTRAINT IF EXISTS "stock_transfer_lines_toProductId_fkey";
ALTER TABLE IF EXISTS "stock_transfer_lines" DROP CONSTRAINT IF EXISTS "stock_transfer_lines_cost_check";
DROP INDEX IF EXISTS "stock_transfer_lines_toProductId_idx";
ALTER TABLE IF EXISTS "stock_transfer_lines" DROP COLUMN IF EXISTS "zeroCostReason";
ALTER TABLE IF EXISTS "stock_transfer_lines" DROP COLUMN IF EXISTS "costRemainder";
ALTER TABLE IF EXISTS "stock_transfer_lines" DROP COLUMN IF EXISTS "unitCostIn";
ALTER TABLE IF EXISTS "stock_transfer_lines" DROP COLUMN IF EXISTS "landedCosts";
ALTER TABLE IF EXISTS "stock_transfer_lines" DROP COLUMN IF EXISTS "costOut";
ALTER TABLE IF EXISTS "stock_transfer_lines" DROP COLUMN IF EXISTS "toProductId";

ALTER TABLE IF EXISTS "stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_toStoreId_fkey";
ALTER TABLE IF EXISTS "stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_to_store_check";
ALTER TABLE IF EXISTS "stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_status_check";
ALTER TABLE IF EXISTS "stock_transfers" ADD CONSTRAINT "stock_transfers_status_check"
  CHECK ("status" IN ('SENT', 'RECEIVED', 'RECEIVED_WITH_DIFFERENCE', 'CANCELLED'));
DROP INDEX IF EXISTS "stock_transfers_companyId_toStoreId_createdAt_idx";
ALTER TABLE IF EXISTS "stock_transfers" DROP COLUMN IF EXISTS "approvedAt";
ALTER TABLE IF EXISTS "stock_transfers" DROP COLUMN IF EXISTS "approvedById";
ALTER TABLE IF EXISTS "stock_transfers" DROP COLUMN IF EXISTS "toStoreId";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261120200000_stock_transfer_across';
