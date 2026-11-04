-- Rollback for 20261104180000_user_sessions.
-- Run ONLY after the code and the generated client of this release are reverted: every sign-in of this release writes
-- user_sessions and every request reads it. Order: redeploy the old release, THEN run this file.
--
-- What is lost: the list of signed-in devices. Cookies issued by this release carry a `sid` the old release ignores, and
-- its tokenVersion rule still holds them, so nobody is signed out by the rollback itself — and a device this release
-- ended as REPLACED or LOGOUT is accepted again by that rule until its cookie expires. Nothing else is touched.
DROP TABLE IF EXISTS "user_sessions";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261104180000_user_sessions';
