-- Rollback for «أقفل القديمة بلا باركود» (POST /api/ops/tracking/close-legacy, 12/11).
-- Puts every order that press closed back to the settlement state it had before. Run by the owner, the same way as the
-- backfills beside it:   npx prisma db execute --file scripts/backfills/20261112-legacy-closeout.rollback.sql
--
-- THE PRESS IS NOT A MIGRATION AND NOT A SCRIPT: it is a button the owner presses on the tracking screen after the deploy, and it
-- writes nothing at deploy time. This file exists only so that a press he regrets can be undone.
--
-- WHAT IT TOUCHES: only an order that STILL carries the press's mark (order_activities.action = 'LEGACY_CLOSED_NO_MONEY') and is STILL
-- 'SETTLED' (one that moved on since — refunded, say — is left alone), and only to the state the mark recorded in "previousStatus".
-- It writes one line on each order's settlement log saying so, and then renames the mark (it does not delete it: the history stays,
-- and the commission rule, which reads the old name, stops leaving the order out — so a later real collection pays its commission).
--
-- WHAT IT DOES NOT TOUCH: no wallet movement, no commission entry, no stock, no amount. The press wrote none, so there is none to undo.
-- Safe to run twice: a second run finds no order that still carries the mark under the old name.
--
-- HOW MANY ORDERS IT WILL PUT BACK (read-only; run it first):
--   SELECT count(*) AS will_be_put_back
--   FROM "orders" o
--   JOIN "order_activities" a ON a."orderId" = o."id"
--   WHERE a."action" = 'LEGACY_CLOSED_NO_MONEY' AND a."previousStatus" IS NOT NULL AND o."settlementStatus" = 'SETTLED';
--   and, to see the ones it will leave (they moved on after the press):
--   SELECT o."settlementStatus", count(*) AS left_alone
--   FROM "orders" o
--   JOIN "order_activities" a ON a."orderId" = o."id"
--   WHERE a."action" = 'LEGACY_CLOSED_NO_MONEY' AND o."settlementStatus" <> 'SETTLED'
--   GROUP BY o."settlementStatus";

-- 1. Back to the state each order had.
UPDATE "orders" o
SET "settlementStatus" = a."previousStatus"
FROM "order_activities" a
WHERE a."orderId" = o."id"
  AND a."action" = 'LEGACY_CLOSED_NO_MONEY'
  AND a."previousStatus" IS NOT NULL
  AND o."settlementStatus" = 'SETTLED';

-- 2. One line on each order's settlement log (SETTLED -> what it was).
INSERT INTO "order_status_logs" ("id", "companyId", "orderId", "statusType", "previousValue", "newValue", "changedById", "changedByRole", "note", "createdAt")
SELECT gen_random_uuid()::text, a."companyId", a."orderId", 'SETTLEMENT', 'SETTLED', a."previousStatus", a."userId", 'SCRIPT',
       'تراجع عن إقفال قديم بلا باركود', now()
FROM "order_activities" a
JOIN "orders" o ON o."id" = a."orderId"
WHERE a."action" = 'LEGACY_CLOSED_NO_MONEY'
  AND a."previousStatus" IS NOT NULL
  AND a."userId" IS NOT NULL
  AND o."settlementStatus" = a."previousStatus";

-- 3. The mark stops counting: renamed, not deleted.
UPDATE "order_activities" a
SET "action" = 'LEGACY_CLOSED_NO_MONEY_UNDONE'
FROM "orders" o
WHERE o."id" = a."orderId"
  AND a."action" = 'LEGACY_CLOSED_NO_MONEY'
  AND a."previousStatus" IS NOT NULL
  AND o."settlementStatus" = a."previousStatus";
