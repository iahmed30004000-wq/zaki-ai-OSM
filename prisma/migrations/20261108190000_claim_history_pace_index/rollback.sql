-- Rollback for 20261108190000_claim_history_pace_index.
-- Safe at any time: the pace's count still runs without the index (it only reads more), and nothing else uses it. To get the pull without a
-- pace back, redeploy the old release; this file only removes the index.
--
-- What is lost: the speed of the pace's count, nothing else. No row, column or constraint is touched.
DROP INDEX IF EXISTS "order_claim_history_userId_action_createdAt_idx";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261108190000_claim_history_pace_index';
