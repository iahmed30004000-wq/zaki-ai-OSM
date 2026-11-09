-- Rollback for 20261109200000_settlement_match_applied.
-- Run ONLY after the code and the generated client of this release are reverted: this release's approval, its close and every
-- door that answers a line read the column. Order: switch «تسوية السطور النظيفة عند الاعتماد» OFF, redeploy the old release, THEN
-- run this file.
--
-- What is lost: which clean rows of a still-open statement had their orders settled early. The orders themselves stay settled
-- (that is an order fact, not this column's) — but the OLD close would then try to settle them a second time and stop on
-- «تغيّر وضع طلب». So roll back only when no statement is open with early-settled rows: close those matchings first.
-- Matches, receipts, money and orders are not touched by this file.
ALTER TABLE "settlement_matches"
  DROP COLUMN IF EXISTS "appliedAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261109200000_settlement_match_applied';
