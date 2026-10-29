-- THE SETTINGS DOORS GET A BOX EACH (perm-plan PR-4). Ten new keys:
--   settings.jobs · settings.messages · penalties.rules · team.settings · offers.rules
--   commission.view · commission.manage · settings.delivery_fees · settings.tracking
--   orders.migrate
--
-- THE RULE: NOBODY LOSES A DOOR AND NOBODY GAINS ONE ON THE DAY. A door that
-- asked for settings.manage / settings.edit / settings.view (or, for the
-- migration of past orders, orders.import AND settings.manage) now asks for a
-- box of its own. This file gives each box to exactly the roles and the
-- people who passed that door yesterday, in the three places a grant lives —
-- the role, the role's «إرجاع للافتراضي» baseline, and the person's own
-- exception — and carries every «منع» across, so a person denied the old key
-- is denied the new one. From the next day the owner unticks one box without
-- touching the others.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE:
--   · It does NOT read the old plan's step 4 («M2»). That step ran AFTER the
--     role rows were written and counted the row it had just written as «a
--     source this person is not denied», so a person denied the old key
--     gained the door. Here EVERY question is asked of a snapshot taken
--     BEFORE the first row is written (the sp4_* temp tables below).
--   · It does NOT re-grant what the owner unticked. The sources are read as
--     they stand TODAY: a role that lost settings.manage on 28/10 does not get
--     settings.jobs back through settings.edit. The commission and fee boxes
--     are sourced from settings.edit / settings.view because that is what
--     their doors asked.
--   · It writes nothing for SUPER_ADMIN (passes everything) and nothing for a
--     person with no stored role — the in-code fallback in permissions-core
--     (SPLIT_FROM_SETTINGS) keeps those people their doors.
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING into the three grant tables;
-- no row is changed or removed. The sp4_* tables are TEMPORARY (they die with
-- the session) and are dropped at the end. Every row written has an id
-- starting with 'sp4-', which is how rollback.sql finds them and nothing else.
--
-- NO BEGIN / COMMIT HERE ON PURPOSE: whoever rehearses this file inside their
-- own transaction and rolls it back must really roll it back.
--
-- ORDER MATTERS: snapshot → «منع» → «سماح» → roles → baselines.

DROP TABLE IF EXISTS pg_temp.sp4_user_role, pg_temp.sp4_gate, pg_temp.sp4_holds, pg_temp.sp4_pass, pg_temp.sp4_role_gets, pg_temp.sp4_default_gets;

-- The single-key doors: the box on the left is given to whoever held the key on the right.
CREATE TEMP TABLE sp4_gate AS
SELECT * FROM (VALUES
  ('settings.jobs',          'settings.manage'),
  ('settings.messages',      'settings.manage'),
  ('penalties.rules',        'settings.manage'),
  ('team.settings',          'settings.manage'),
  ('offers.rules',           'settings.manage'),
  ('commission.view',        'settings.view'),
  ('commission.manage',      'settings.edit'),
  ('settings.delivery_fees', 'settings.edit'),
  ('settings.tracking',      'settings.edit')
) AS g (new_key, src);

-- Which role each person's grants come from — the way permissions-core reads it: their roleId, or, with none,
-- the system template named like their role. SUPER_ADMIN passes everything anyway.
CREATE TEMP TABLE sp4_user_role AS
SELECT u."id" AS uid, r."id" AS rid
FROM "users" u
JOIN "roles" r
  ON (u."roleId" IS NOT NULL AND r."id" = u."roleId")
  OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")
WHERE u."role" <> 'SUPER_ADMIN';

-- The source keys each person HOLDS today: through the role or their own «سماح», and not under a «منع».
CREATE TEMP TABLE sp4_holds AS
SELECT h.uid, h.k
FROM (
  SELECT ur.uid AS uid, rp."permission" AS k
  FROM sp4_user_role ur
  JOIN "role_permissions" rp ON rp."roleId" = ur.rid
  UNION
  SELECT up."userId", up."permission"
  FROM "user_permissions" up
  JOIN "users" u ON u."id" = up."userId"
  WHERE up."effect" = 'ALLOW' AND u."role" <> 'SUPER_ADMIN'
) h
WHERE h.k IN ('settings.view', 'settings.edit', 'settings.manage', 'orders.import')
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" d
    WHERE d."userId" = h.uid AND d."permission" = h.k AND d."effect" = 'DENY');

-- WHO PASSED EACH DOOR YESTERDAY. The migration door asked for BOTH keys.
CREATE TEMP TABLE sp4_pass AS
SELECT h.uid, g.new_key
FROM sp4_holds h
JOIN sp4_gate g ON g.src = h.k
UNION
SELECT i.uid, 'orders.migrate'::text
FROM sp4_holds i
JOIN sp4_holds m ON m.uid = i.uid AND m.k = 'settings.manage'
WHERE i.k = 'orders.import';

-- WHICH ROLES WILL RECEIVE EACH BOX: those that hold the source today (the migration box: both).
CREATE TEMP TABLE sp4_role_gets AS
SELECT rp."roleId" AS rid, g.new_key
FROM "role_permissions" rp
JOIN sp4_gate g ON g.src = rp."permission"
UNION
SELECT a."roleId", 'orders.migrate'::text
FROM "role_permissions" a
JOIN "role_permissions" b ON b."roleId" = a."roleId" AND b."permission" = 'settings.manage'
WHERE a."permission" = 'orders.import';

-- The same question of the baseline «إرجاع للافتراضي» restores.
CREATE TEMP TABLE sp4_default_gets AS
SELECT d."roleId" AS rid, g.new_key
FROM "role_permission_defaults" d
JOIN sp4_gate g ON g.src = d."permission"
UNION
SELECT a."roleId", 'orders.migrate'::text
FROM "role_permission_defaults" a
JOIN "role_permission_defaults" b ON b."roleId" = a."roleId" AND b."permission" = 'settings.manage'
WHERE a."permission" = 'orders.import';

-- 1. A «منع» is carried FIRST. A person whose role is about to receive a box but who did NOT pass that door
--    yesterday (every way in was refused to them) is refused the box: no door gained.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'sp4-' || gen_random_uuid()::text, ur.uid, rg.new_key, 'DENY', NULL, NULL, now()
FROM sp4_user_role ur
JOIN sp4_role_gets rg ON rg.rid = ur.rid
WHERE NOT EXISTS (SELECT 1 FROM sp4_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 2. A person who passed through their own «سماح» (or through the other half of the migration door), and whose
--    role does not receive the box, gets a «سماح» of their own: no door lost.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'sp4-' || gen_random_uuid()::text, p.uid, p.new_key, 'ALLOW', 'ALL_COMPANY', NULL, now()
FROM sp4_pass p
WHERE NOT EXISTS (
  SELECT 1 FROM sp4_user_role ur
  JOIN sp4_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key
  WHERE ur.uid = p.uid)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 3. Every role that held the source — company roles AND the system templates (companyId NULL) — receives the box.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'sp4-' || gen_random_uuid()::text, rg.rid, rg.new_key, 'ALL_COMPANY', NULL
FROM sp4_role_gets rg
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 4. And the baseline «إرجاع للافتراضي» restores, or the first reset after this deploy would take the box away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'sp4-' || gen_random_uuid()::text, dg.rid, dg.new_key, 'ALL_COMPANY', NULL
FROM sp4_default_gets dg
ON CONFLICT ("roleId", "permission") DO NOTHING;

DROP TABLE IF EXISTS pg_temp.sp4_user_role, pg_temp.sp4_gate, pg_temp.sp4_holds, pg_temp.sp4_pass, pg_temp.sp4_role_gets, pg_temp.sp4_default_gets;
