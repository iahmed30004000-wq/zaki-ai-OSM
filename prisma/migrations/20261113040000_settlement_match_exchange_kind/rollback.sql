-- Rollback for 20261113040000_settlement_match_exchange_kind.
-- Run ONLY after the code and the generated client of this release are reverted: this release's close, its answer doors, its statement
-- read and its per-person tally read and write the column. Order: redeploy the old release, THEN run this file.
--
-- REFUSES while a statement whose matching is still open carries a line answered «طلب تبديل». The old release does not know the mark: its
-- close would read such a line as a plain «اعتُمد رقم الشركة» and propose a «فرق تحصيل» on the employee at the door for the whole price of an
-- order that was never to be paid for. Close those matchings first (or answer those lines again), then run this file. A closed statement's
-- exchange lines are history: the orders are settled and nobody was charged, and the mark is all this file removes.
--
-- What is lost: which answered lines were exchanges (they read as «اعتُمد رقم الشركة» again, and count as accepted discounts in the tally).
-- Matches, receipts, money, orders and penalties are not touched by this file.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "settlement_matches" m
      JOIN "courier_statements" s ON s."id" = m."statementId"
     WHERE m."resolutionKind" IS NOT NULL
       AND s."matchingClosedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'exchange rollback refused: a statement with an open matching has lines answered as an exchange';
  END IF;
END $$;

ALTER TABLE "settlement_matches"
  DROP COLUMN IF EXISTS "resolutionKind";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113040000_settlement_match_exchange_kind';
