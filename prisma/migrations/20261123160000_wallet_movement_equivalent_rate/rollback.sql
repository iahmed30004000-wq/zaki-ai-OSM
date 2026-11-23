-- Rollback of 20261123160000_wallet_movement_equivalent_rate: drops the two CHECKs and the four rate columns. Only the record of
-- WHICH rate filled an equivalent is lost; the stored equivalent (the number the partners' ledger reads) stays as it is.

ALTER TABLE "wallet_movements" DROP CONSTRAINT IF EXISTS "wallet_movements_equivalent_rate_kind_check";
ALTER TABLE "wallet_movements" DROP CONSTRAINT IF EXISTS "wallet_movements_equivalent_rate_check";
ALTER TABLE "wallet_movements" DROP COLUMN IF EXISTS "equivalentRateAt";
ALTER TABLE "wallet_movements" DROP COLUMN IF EXISTS "equivalentRateSource";
ALTER TABLE "wallet_movements" DROP COLUMN IF EXISTS "equivalentRateKind";
ALTER TABLE "wallet_movements" DROP COLUMN IF EXISTS "equivalentRate";
