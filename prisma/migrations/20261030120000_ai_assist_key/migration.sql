-- THE HELPERS INSIDE THE SCREENS GET A BOX OF THEIR OWN: «المساعدون الأذكياء داخل الشاشات» (ai.assist) — perm-plan PR-5.
-- The owner's rule, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي».
--
-- Until now five helpers answered to the key of the work they sit in, and nothing else:
--
--     the confirmation assistant            confirmation.work
--     the picking assistant                 ops.prepare
--     the landing-page writer               landing_pages.edit
--     the AI step of order entry            orders.create
--     «لخّصلي اليوم» in the command box     orders.view
--
-- After this change each of them asks the key it asked BEFORE and ai.assist as well. A new key opens nothing by itself,
-- so the only thing it can do on the day is TAKE A DOOR AWAY from a person who does not hold it. This file makes sure
-- nobody is that person: ai.assist goes to every role and every person that passed ANY of the five doors yesterday,
-- in the three places a grant lives — the role, the role's «إرجاع للافتراضي» baseline and the person's own exception —
-- and every «منع» is carried across, so nobody GAINS the box either. From the next day the owner unticks one box and
-- the helpers go off while the work stays.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE:
--   · It does NOT read the old plan's step 4 («M3»). That step ran AFTER the role rows were written and counted the row
--     it had just written as «a source this person is not denied». Here EVERY question is asked of a snapshot taken
--     BEFORE the first row is written (the sp5_* temp tables below), and the «منع» goes in first.
--   · It does NOT re-grant what the owner unticked. The sources are read as they stand TODAY: a role that lost
--     orders.view on 28/10 gets ai.assist only if it still holds one of the other four.
--   · It writes nothing for SUPER_ADMIN (passes everything) and nothing for a person with no stored role — the in-code
--     fallback in permissions-core keeps those people their helpers.
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING into the three grant tables; no row is changed or removed. The sp5_*
-- tables are TEMPORARY (they die with the session) and are dropped at the end. Every row written has an id starting
-- with 'aia-', which is how rollback.sql finds them and nothing else.
--
-- NO BEGIN / COMMIT HERE ON PURPOSE: whoever rehearses this file inside their own transaction and rolls it back must
-- really roll it back.
--
-- ORDER MATTERS: snapshot → «منع» → «سماح» → roles → baselines.

DROP TABLE IF EXISTS pg_temp.sp5_src, pg_temp.sp5_user_role, pg_temp.sp5_holds, pg_temp.sp5_pass, pg_temp.sp5_role_gets, pg_temp.sp5_default_gets;

-- The five keys whose holders reached a helper yesterday (AI_ASSIST_FROM in src/lib/ai-assistants.ts — a test compares).
CREATE TEMP TABLE sp5_src AS
SELECT * FROM (VALUES
  ('confirmation.work'),
  ('ops.prepare'),
  ('landing_pages.edit'),
  ('orders.create'),
  ('orders.view')
) AS s (k);

-- Which role each person's grants come from — the way permissions-core reads it: their roleId, or, with none,
-- the system template named like their role. SUPER_ADMIN passes everything anyway.
CREATE TEMP TABLE sp5_user_role AS
SELECT u."id" AS uid, r."id" AS rid
FROM "users" u
JOIN "roles" r
  ON (u."roleId" IS NOT NULL AND r."id" = u."roleId")
  OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")
WHERE u."role" <> 'SUPER_ADMIN';

-- The source keys each person HOLDS today: through the role or their own «سماح», and not under a «منع».
CREATE TEMP TABLE sp5_holds AS
SELECT h.uid, h.k
FROM (
  SELECT ur.uid AS uid, rp."permission" AS k
  FROM sp5_user_role ur
  JOIN "role_permissions" rp ON rp."roleId" = ur.rid
  UNION
  SELECT up."userId", up."permission"
  FROM "user_permissions" up
  JOIN "users" u ON u."id" = up."userId"
  WHERE up."effect" = 'ALLOW' AND u."role" <> 'SUPER_ADMIN'
) h
WHERE h.k IN (SELECT k FROM sp5_src)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" d
    WHERE d."userId" = h.uid AND d."permission" = h.k AND d."effect" = 'DENY');

-- WHO PASSED A DOOR YESTERDAY: holds at least one of the five keys.
CREATE TEMP TABLE sp5_pass AS
SELECT DISTINCT h.uid FROM sp5_holds h;

-- WHICH ROLES WILL RECEIVE THE BOX: those that hold at least one of the five today.
CREATE TEMP TABLE sp5_role_gets AS
SELECT DISTINCT rp."roleId" AS rid
FROM "role_permissions" rp
JOIN sp5_src s ON s.k = rp."permission";

-- The same question of the baseline «إرجاع للافتراضي» restores.
CREATE TEMP TABLE sp5_default_gets AS
SELECT DISTINCT d."roleId" AS rid
FROM "role_permission_defaults" d
JOIN sp5_src s ON s.k = d."permission";

-- 1. A «منع» is carried FIRST. A person whose role is about to receive the box but who did NOT pass a door yesterday
--    (every way in was refused to them) is refused the box: no door gained.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'aia-' || gen_random_uuid()::text, ur.uid, 'ai.assist', 'DENY', NULL, NULL, now()
FROM sp5_user_role ur
JOIN sp5_role_gets rg ON rg.rid = ur.rid
WHERE NOT EXISTS (SELECT 1 FROM sp5_pass p WHERE p.uid = ur.uid)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 2. A person who passed through their own «سماح», and whose role does not receive the box, gets a «سماح» of their
--    own: no door lost.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'aia-' || gen_random_uuid()::text, p.uid, 'ai.assist', 'ALLOW', 'ALL_COMPANY', NULL, now()
FROM sp5_pass p
WHERE NOT EXISTS (
  SELECT 1 FROM sp5_user_role ur
  JOIN sp5_role_gets rg ON rg.rid = ur.rid
  WHERE ur.uid = p.uid)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 3. Every role that held a source — company roles AND the system templates (companyId NULL) — receives the box.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'aia-' || gen_random_uuid()::text, rg.rid, 'ai.assist', 'ALL_COMPANY', NULL
FROM sp5_role_gets rg
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 4. And the baseline «إرجاع للافتراضي» restores, or the first reset after this deploy would take the box away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'aia-' || gen_random_uuid()::text, dg.rid, 'ai.assist', 'ALL_COMPANY', NULL
FROM sp5_default_gets dg
ON CONFLICT ("roleId", "permission") DO NOTHING;

DROP TABLE IF EXISTS pg_temp.sp5_src, pg_temp.sp5_user_role, pg_temp.sp5_holds, pg_temp.sp5_pass, pg_temp.sp5_role_gets, pg_temp.sp5_default_gets;
