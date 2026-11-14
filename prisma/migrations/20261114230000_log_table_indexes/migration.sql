-- «الفهارس بالأرقام الحقيقية» — PR-9 of the hang-repair plan (HANDOVER-perf-plan-2026-11-13, Appendix D). The owner's read-only diagnostic of the production
-- database, run 14/11 (22:50 Jordan): 306 MB in all, cache hit 99.97 %, 22,646 orders — a small database whose LOG tables are read whole by the team
-- reports and the bell. THREE INDEXES, each with the numbers that asked for it, and nothing else:
--
--   order_contact_attempts ("companyId", "createdAt")
--       14,082 full scans that read 189 M rows (the table holds 14,295): team-performance, attendance, held-flow-read, no-answer-watch. The only index that
--       starts with companyId has the ORDER second ((companyId, orderId, createdAt)), so «everything the team did in a window» could not use it.
--   order_claim_history ("companyId", "createdAt")
--       5,230 full scans that read 45.7 M rows (the table holds 9,451): team-performance, attendance, held-flow-read. Same reason.
--   notifications ("companyId", "userId", "createdAt" DESC)
--       the bell's «newest 50» (GET /api/notifications, polled by every person): the existing (companyId, userId, isRead) reads about 1,050 entries per call
--       (18,160 calls) to sort them; this one hands them over already in order.
--
-- NOT added, because the numbers do not ask for it: order_status_logs (145 accesses in all), order_activities (40 entries per scan, 478 full scans), audit_logs
-- (14 scans), inventory_movements (166 rows), settlement_matches (22 scans). Nothing on `orders`: it has 35 indexes already, 8 of them never scanned — dropping
-- those is a separate decision, not this one.
--
-- ADDITIVE ONLY: no column, no default, no row written or changed, no existing index touched. The code that ran before never reads these indexes and is not
-- affected by their being there. Hand-written; each statement is what `prisma migrate diff` prints for the matching `@@index` line of schema.prisma (Prisma's own
-- default names, so a later `migrate diff` finds nothing to do) with IF NOT EXISTS added. Plain CREATE INDEX, never CONCURRENTLY (a concurrent build that fails
-- leaves an INVALID index that IF NOT EXISTS then keeps): the build holds a share lock on its table, so a write to it waits for the build — moments on tables of
-- 9 to 47 thousand rows, at a Redeploy, at night. Applied locally with:
--   npx prisma db execute --file prisma/migrations/20261114230000_log_table_indexes/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261114230000_log_table_indexes
-- and in production by `prisma migrate deploy` at the owner's Redeploy.
--
-- Idempotent (IF NOT EXISTS). Rollback: rollback.sql beside this file.

CREATE INDEX IF NOT EXISTS "order_contact_attempts_companyId_createdAt_idx" ON "order_contact_attempts"("companyId", "createdAt");

CREATE INDEX IF NOT EXISTS "order_claim_history_companyId_createdAt_idx" ON "order_claim_history"("companyId", "createdAt");

CREATE INDEX IF NOT EXISTS "notifications_companyId_userId_createdAt_idx" ON "notifications"("companyId", "userId", "createdAt" DESC);
