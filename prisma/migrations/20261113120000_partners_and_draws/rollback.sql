-- Rollback for 20261113120000_partners_and_draws.
-- Run ONLY after the code and the generated client of this release are reverted: this release's wallet movements, profit screen,
-- wallets dialog and settings card read and write the table and the two columns. Order: redeploy the old release, THEN run this file.
--
-- What is lost: the partners and their shares, and — on each partner draw — the link to its partner and its value in the store's
-- currency. The draws THEMSELVES are not lost: each one is a wallet movement (an OUT of its wallet, category PARTNER_DRAW, with the
-- partner's name as its party) and stays in its wallet's ledger and in its balance, so the cash book still ties; the old release
-- shows the category by its raw key. Nothing else in the database is touched.
ALTER TABLE "wallet_movements" DROP CONSTRAINT IF EXISTS "wallet_movements_partnerId_fkey";
DROP INDEX IF EXISTS "wallet_movements_partnerId_idx";
ALTER TABLE "wallet_movements"
  DROP COLUMN IF EXISTS "partnerId",
  DROP COLUMN IF EXISTS "valueInStoreCurrency";
DROP TABLE IF EXISTS "partners";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113120000_partners_and_draws';
