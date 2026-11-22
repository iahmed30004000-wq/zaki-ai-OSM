-- Rollback of 20261122130000_wallet_real_dates: drops the two real-date columns. Only the typed real dates are lost; every
-- balance, closing and statement is unchanged, because none of them reads these columns.

ALTER TABLE "wallet_movements" DROP COLUMN IF EXISTS "occurredAt";

ALTER TABLE "wallet_transfers" DROP COLUMN IF EXISTS "occurredAt";
