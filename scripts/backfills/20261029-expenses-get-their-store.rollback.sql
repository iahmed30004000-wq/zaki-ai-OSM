-- UNDO 20261029-expenses-get-their-store.sql.
--
-- Puts back NULL on exactly the expenses that script placed — the ids it wrote
-- to `expense_store_backfill_log` — and on no other. An expense recorded
-- after the migration carries its store from the day it was typed, is not in
-- the log, and keeps it. After this, those old rows count against every store
-- again, as before.
--
-- Run it with:  npx prisma db execute --file scripts/backfills/20261029-expenses-get-their-store.rollback.sql
-- The log is emptied of the ids it undid, so a re-run changes nothing.
WITH undone AS (
  UPDATE "expenses" SET "store_id" = NULL
  WHERE "id" IN (SELECT "expense_id" FROM "expense_store_backfill_log")
  RETURNING "id"
)
DELETE FROM "expense_store_backfill_log" WHERE "expense_id" IN (SELECT "id" FROM undone);
