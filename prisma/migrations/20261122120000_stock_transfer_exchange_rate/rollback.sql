-- Rollback of 20261122120000_stock_transfer_exchange_rate. Idempotent: running it twice is the same as running it once.
-- Run ONLY after the previous release is redeployed: this release's Prisma client selects this column on every
-- StockTransfer read, so dropping it under it would fail those reads.
-- What is lost: the rate each transfer between two currencies was sent at. Received transfers keep their batches and
-- their unit cost (already written); a transfer between two currencies still SENT and not received would, after the
-- rollback, be received by the previous release WITHOUT conversion — receive or cancel such transfers first.
ALTER TABLE IF EXISTS "stock_transfers" DROP CONSTRAINT IF EXISTS "stock_transfers_exchange_rate_check";
ALTER TABLE IF EXISTS "stock_transfers" DROP COLUMN IF EXISTS "exchangeRate";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261122120000_stock_transfer_exchange_rate';
