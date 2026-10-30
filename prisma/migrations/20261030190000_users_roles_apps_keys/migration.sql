-- THE USERS, ROLES AND APP-KEY DOORS GET A BOX EACH (perm-plan PR-13). Five new keys:
--   users.delete · users.shift · users.security · roles.edit_system · apps.tokens
-- The owner's rule, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي».
--
-- THE RULE: NOBODY LOSES A DOOR AND NOBODY GAINS ONE ON THE DAY. A door that asked for a wider key (or for a role NAME) now
-- asks for a box of its own:
--
--     deleting an employee's account                 users.edit                            →  users.delete
--     setting an employee's start, end and rest days users.edit                            →  users.shift
--     setting a password / resetting 2FA             the NAME COMPANY_ADMIN (and SUPER_ADMIN) →  users.security   (D6)
--     rewriting a system role template               the NAME COMPANY_ADMIN (and SUPER_ADMIN) →  roles.edit_system
--     issuing and stopping a system key (/api/v1)    apps.manage                           →  apps.tokens
--
-- SUPER_ADMIN is written NOWHERE below: it holds every key centrally (permissions-core returns full access before any row is
-- read), so it passes all five doors whatever is unticked from everybody else — that is the way back in, and it is not a row
-- anyone can remove. A role NAMED SUPER_ADMIN gets nothing either: the engine never reads it and the screen shows it read-only.
--
-- This file gives each box to exactly the roles and the people who passed that door yesterday — «any of the keys» where the
-- door took a key, and "the name" where the door read a name — in the three places a grant lives: the role, the role's
-- «إرجاع للافتراضي» baseline and the person's own exception. Every «منع» is carried across, so a person denied the old key is
-- denied the new one.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE:
--   · It does NOT read the old plan's step 4 («M11»). That step ran AFTER the role rows were written and counted the row it
--     had just written as «a source this person is not denied». Here EVERY question is asked of a snapshot taken BEFORE the
--     first row is written (the sp13_* temp tables below), and the «منع» goes in first.
--   · It does NOT re-grant what the owner unticked. The sources are read as they stand TODAY.
--   · It does NOT give whatsapp.view to a holder of whatsapp.manage without it, nor telegram.view to a holder of
--     telegram.manage without it (the old plan's M11 did): that would open a customer inbox to someone who never could see
--     it — a door GAINED. The pre-deploy report lists those people; the owner decides.
--   · It does NOT give roles.edit to the people who hold users.edit: the personal exceptions moved to roles.edit on purpose
--     (D9), and handing the role matrix over to every profile editor would be the gain D9 exists to stop. The pre-deploy
--     report lists who loses the exceptions screen, so the owner knows before the deploy.
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING into the three grant tables; no row is changed or removed. The sp13_*
-- tables are TEMPORARY (they die with the session) and are dropped at the end. Every row written has an id starting with
-- 'ur13-', which is how rollback.sql finds them and nothing else.
--
-- NO BEGIN / COMMIT HERE ON PURPOSE: whoever rehearses this file inside their own transaction and rolls it back must
-- really roll it back.
--
-- ORDER MATTERS: snapshot → «منع» → «سماح» → roles → baselines.

DROP TABLE IF EXISTS pg_temp.sp13_user_role, pg_temp.sp13_gate, pg_temp.sp13_holds, pg_temp.sp13_has, pg_temp.sp13_pass, pg_temp.sp13_role_gets, pg_temp.sp13_default_gets;

-- The doors: the box on the left is given to whoever held the key in `src` — or, on a row with a role_name, to whoever's
-- role IS that name.
CREATE TEMP TABLE sp13_gate AS
SELECT * FROM (VALUES
  ('users.delete',      'users.edit',  NULL::text),
  ('users.shift',       'users.edit',  NULL::text),
  ('users.security',    NULL::text,    'COMPANY_ADMIN'),
  ('roles.edit_system', NULL::text,    'COMPANY_ADMIN'),
  ('apps.tokens',       'apps.manage', NULL::text)
) AS g (new_key, src, role_name);

-- Which role each person's grants come from — the way permissions-core reads it: their roleId, or, with none,
-- the system template named like their role. SUPER_ADMIN passes everything anyway.
CREATE TEMP TABLE sp13_user_role AS
SELECT u."id" AS uid, r."id" AS rid
FROM "users" u
JOIN "roles" r
  ON (u."roleId" IS NOT NULL AND r."id" = u."roleId")
  OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")
WHERE u."role" <> 'SUPER_ADMIN';

-- The keys each person HOLDS today (a source of a door): their own «سماح» (which REPLACES the role's row for the same key,
-- exactly as the engine does) or else the role's row — and not under a «منع».
CREATE TEMP TABLE sp13_holds AS
SELECT h.uid, h.k
FROM (
  SELECT up."userId" AS uid, up."permission" AS k
  FROM "user_permissions" up
  JOIN "users" u ON u."id" = up."userId"
  WHERE up."effect" = 'ALLOW' AND u."role" <> 'SUPER_ADMIN'
  UNION ALL
  SELECT ur.uid, rp."permission"
  FROM sp13_user_role ur
  JOIN "role_permissions" rp ON rp."roleId" = ur.rid
  WHERE NOT EXISTS (
    SELECT 1 FROM "user_permissions" a
    WHERE a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW')
) h
WHERE h.k IN (SELECT src FROM sp13_gate WHERE src IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" d
    WHERE d."userId" = h.uid AND d."permission" = h.k AND d."effect" = 'DENY');

-- WHO ALREADY HOLDS A BOX THIS FILE WOULD GIVE (none can, the keys are new — but a second run, or a tick the owner made
-- between two runs, must not be answered with a «منع» written on top of a working grant). A personal row of either kind
-- settles the question for that key; else the role's row stands.
CREATE TEMP TABLE sp13_has AS
SELECT up."userId" AS uid, up."permission" AS k
FROM "user_permissions" up
WHERE up."effect" = 'ALLOW' AND up."permission" IN (SELECT new_key FROM sp13_gate)
UNION
SELECT ur.uid, rp."permission"
FROM sp13_user_role ur
JOIN "role_permissions" rp ON rp."roleId" = ur.rid
WHERE rp."permission" IN (SELECT new_key FROM sp13_gate)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" o
    WHERE o."userId" = ur.uid AND o."permission" = rp."permission");

-- WHO PASSED EACH DOOR YESTERDAY: holds the key the door asked, or whose role NAME the door read.
CREATE TEMP TABLE sp13_pass AS
SELECT h.uid, g.new_key
FROM sp13_holds h
JOIN sp13_gate g ON g.src = h.k
UNION ALL
SELECT u."id", g.new_key
FROM "users" u
JOIN sp13_gate g ON g.role_name = u."role"
WHERE u."role" <> 'SUPER_ADMIN';

-- WHICH ROLES WILL RECEIVE EACH BOX: those that hold the key the door asked today, and those NAMED like a role the door read.
CREATE TEMP TABLE sp13_role_gets AS
SELECT rp."roleId" AS rid, g.new_key
FROM "role_permissions" rp
JOIN sp13_gate g ON g.src = rp."permission"
UNION ALL
SELECT r."id", g.new_key
FROM "roles" r
JOIN sp13_gate g ON g.role_name = r."name";

-- The same question of the baseline «إرجاع للافتراضي» restores - and a role that was never issued a baseline is NOT given one:
-- a baseline of a single box would read as "the shipped matrix" and the first reset would wipe the role down to it
-- (the door says so itself: an empty baseline "would wipe the role"). Only a role that already has baseline rows gets the box there.
CREATE TEMP TABLE sp13_default_gets AS
SELECT d."roleId" AS rid, g.new_key
FROM "role_permission_defaults" d
JOIN sp13_gate g ON g.src = d."permission"
UNION ALL
SELECT r."id", g.new_key
FROM "roles" r
JOIN sp13_gate g ON g.role_name = r."name"
WHERE EXISTS (SELECT 1 FROM "role_permission_defaults" x WHERE x."roleId" = r."id");

-- 1. A «منع» is carried FIRST. A person whose role is about to receive a box but who did NOT pass that door yesterday
--    (every way in was refused to them) is refused the box: no door gained. Left alone: whoever already holds the box.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'ur13-' || gen_random_uuid()::text, ur.uid, rg.new_key, 'DENY', NULL, NULL, now()
FROM sp13_user_role ur
JOIN sp13_role_gets rg ON rg.rid = ur.rid
WHERE NOT EXISTS (SELECT 1 FROM sp13_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)
  AND NOT EXISTS (SELECT 1 FROM sp13_has x WHERE x.uid = ur.uid AND x.k = rg.new_key)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 2. A person who passed through their own «سماح» or their role NAME, and whose role does not receive the box, gets a
--    «سماح» of their own: no door lost.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'ur13-' || gen_random_uuid()::text, p.uid, p.new_key, 'ALLOW', 'ALL_COMPANY', NULL, now()
FROM sp13_pass p
WHERE NOT EXISTS (
    SELECT 1 FROM sp13_user_role ur
    JOIN sp13_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key
    WHERE ur.uid = p.uid)
  AND NOT EXISTS (SELECT 1 FROM sp13_has x WHERE x.uid = p.uid AND x.k = p.new_key)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 3. Every role that held a source — company roles AND the system templates (companyId NULL) — receives the box.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'ur13-' || gen_random_uuid()::text, rg.rid, rg.new_key, 'ALL_COMPANY', NULL
FROM sp13_role_gets rg
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 4. And the baseline «إرجاع للافتراضي» restores, or the first reset after this deploy would take the box away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'ur13-' || gen_random_uuid()::text, dg.rid, dg.new_key, 'ALL_COMPANY', NULL
FROM sp13_default_gets dg
ON CONFLICT ("roleId", "permission") DO NOTHING;

DROP TABLE IF EXISTS pg_temp.sp13_user_role, pg_temp.sp13_gate, pg_temp.sp13_holds, pg_temp.sp13_has, pg_temp.sp13_pass, pg_temp.sp13_role_gets, pg_temp.sp13_default_gets;
