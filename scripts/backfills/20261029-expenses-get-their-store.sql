-- EVERY OLD EXPENSE GETS THE STORE THAT BORE IT.
--
-- Until the column `expenses.store_id` existed, every store's profit subtracted
-- every store's expenses. New expenses now carry their store; the old ones
-- carry NULL, and a NULL row is read exactly as it always was — it counts
-- against every store. This file fills the NULLs it can place with certainty,
-- and ONLY those. After it runs, a store's profit stops subtracting expenses
-- that were another store's.
--
-- THAT MOVES PROFIT FIGURES, so nothing runs it by itself.
--
-- THIS IS A MANUAL SCRIPT, NOT A MIGRATION. It lives in scripts/backfills/ on
-- purpose: nothing in prisma/migrations/ may write production data, because
-- the container runs `prisma migrate deploy` on every start.
--
-- WHO RUNS IT, AND WHEN: the owner, by his own press, after the migration
-- 20261029140000_expense_store_and_cancel has deployed. Steps:
--   1. Run the read-only counts below. Look at the numbers.
--   2. If they are not what you expect, stop.
--   3. Run it:   npx prisma db execute --file scripts/backfills/20261029-expenses-get-their-store.sql
--      (safe to run again: a second run finds nothing left to place).
--   4. To undo it: scripts/backfills/20261029-expenses-get-their-store.rollback.sql
-- No `prisma migrate resolve` is needed: it is not in the migrations table.
--
-- HOW EACH EXPENSE IS PLACED, in this order, NULL rows only:
--   1. The wallet the money left belongs to a store → that store.
--   2. The wallet belongs to no store yet, but its country has exactly ONE real
--      (non-test) store in that company → that store.
--   3. The company has exactly ONE real store at all → that store.
-- An expense that none of the three can place (several stores, wallet not
-- placed, or no wallet) is LEFT NULL and keeps counting everywhere. The owner
-- places those himself; this file never guesses.
--
-- ADDITIVE AND SAFE TO RUN TWICE. Nothing is deleted. Only rows whose
-- `store_id` IS NULL are touched. The ids it fills are written to the log table
-- `expense_store_backfill_log` (created here, outside the Prisma schema), which
-- is how the rollback undoes exactly this and not an expense recorded since.
--
-- READ-ONLY COUNTS (run these first):
--   -- how many old expenses there are, and how many carry no store:
--   SELECT count(*) AS all_rows, count(*) FILTER (WHERE store_id IS NULL) AS no_store, COALESCE(SUM(amount) FILTER (WHERE store_id IS NULL), 0) AS no_store_amount FROM expenses;
--   -- which companies have more than one real store (their expenses split):
--   SELECT "companyId", count(*) FROM stores WHERE is_test = false GROUP BY 1 HAVING count(*) > 1;
--   -- how many step 1 will place:
--   SELECT count(*) FROM expenses e JOIN wallets w ON w.id = e.wallet_id
--   WHERE e.store_id IS NULL AND w."companyId" = e."companyId" AND w.store_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS "expense_store_backfill_log" (
  "expense_id" TEXT PRIMARY KEY,
  "ran_at"     TIMESTAMP(3) NOT NULL DEFAULT now()
);

-- 1. The wallet the money left knows its store.
WITH placed AS (
  UPDATE "expenses" AS e SET "store_id" = w."store_id"
  FROM "wallets" AS w
  WHERE e."store_id" IS NULL
    AND e."wallet_id" = w."id"
    AND w."companyId" = e."companyId"
    AND w."store_id" IS NOT NULL
  RETURNING e."id"
)
INSERT INTO "expense_store_backfill_log" ("expense_id") SELECT "id" FROM placed ON CONFLICT DO NOTHING;

-- 2. An unplaced wallet whose country has exactly one real store in that company.
WITH placed AS (
  UPDATE "expenses" AS e SET "store_id" = s."id"
  FROM "wallets" AS w, "stores" AS s
  WHERE e."store_id" IS NULL
    AND e."wallet_id" = w."id"
    AND w."companyId" = e."companyId"
    AND w."store_id" IS NULL
    AND s."companyId" = e."companyId"
    AND s."countryId" = w."countryId"
    AND s."is_test" = false
    AND NOT EXISTS (
      SELECT 1 FROM "stores" o
      WHERE o."companyId" = e."companyId" AND o."countryId" = w."countryId"
        AND o."is_test" = false AND o."id" <> s."id")
  RETURNING e."id"
)
INSERT INTO "expense_store_backfill_log" ("expense_id") SELECT "id" FROM placed ON CONFLICT DO NOTHING;

-- 3. A company with exactly one REAL store: every expense still unplaced was that store's.
--    (A bench store does not make a company multi-store.)
WITH placed AS (
  UPDATE "expenses" AS e SET "store_id" = s."id"
  FROM "stores" AS s
  WHERE e."store_id" IS NULL
    AND s."companyId" = e."companyId"
    AND s."is_test" = false
    AND NOT EXISTS (
      SELECT 1 FROM "stores" o
      WHERE o."companyId" = e."companyId" AND o."is_test" = false AND o."id" <> s."id")
  RETURNING e."id"
)
INSERT INTO "expense_store_backfill_log" ("expense_id") SELECT "id" FROM placed ON CONFLICT DO NOTHING;
