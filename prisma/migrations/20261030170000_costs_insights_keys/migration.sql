-- WHAT A THING COST US, THE SMART CARDS AND THE TEAM'S TABLES GET A KEY EACH (perm-plan PR-10). Two new keys and one that
-- already existed:
--   costs.view · insights.view · team.monitor (the third already exists; two more doors now ask it)
-- The owner's rule, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي».
--
-- THE RULE: NOBODY LOSES A DOOR AND NOBODY GAINS ONE ON THE DAY — except the one widening written below. A door that asked
-- for a wider set of keys (or for a role NAME) now asks for a box of its own:
--
--     the cost and the margin of a product, a batch, the stock       inventory.view OR inventory.adjust OR production.view
--       and an order (with finance.view)                               OR production.manage OR finance.view     →  costs.view
--     the smart cards (a grade, a ranking, a loss reason, a channel's   the key of the screen the card is drawn on:
--       score, a return risk, a campaign's best and worst, a page's      products.view · inventory.view · reports.view ·
--       verdict, the search box's live counts)                          dashboard.view · confirmation.work · orders.confirm ·
--                                                                       customers.view · orders.view · landing_pages.view
--                                                                                                            →  insights.view
--     the two team tables on the confirmation desk                     users.view OR the NAMES COMPANY_ADMIN / MANAGER
--                                                                                                            →  team.monitor
--
-- The screens keep their own keys: every door still asks the screen's key first, and the new key decides only whether the
-- cost or the card travels. A key that is a SOURCE here is never removed.
--
-- THE ONE WIDENING (decided under the owner's rule above): team.monitor is also the key of the team scoreboard
-- (/api/performance/team, the grades on a person's page, somebody else's card). Whoever read the confirmation team table
-- through users.view or a name now holds it, so those people can read the scoreboard too. It is the same people's numbers
-- from the same calculator they already read through the table; a company that wants the table without the scoreboard can no
-- longer be told apart, and unticks team.monitor from the roles screen after the deploy. The widening runs the other way too: a
-- person who ALREADY held team.monitor (and not users.view, and not one of the two names) now opens the two confirmation team
-- tables as well — the same numbers they already read on the scoreboard. And a role NAMED COMPANY_ADMIN / MANAGER from which
-- the owner had unticked team.monitor receives it back (the names opened the tables); the pre-deploy report lists both. A
-- person with a personal «منع» on team.monitor keeps it, so loses the tables. Nothing else here gives anybody a door they did
-- not have.
--
-- This file gives each box to exactly the roles and the people who passed that door yesterday — «any of the keys» where the
-- door took either, and "the name" where the door read a name — in the three places a grant lives: the role, the role's
-- «إرجاع للافتراضي» baseline and the person's own exception. Every «منع» is carried across, so a person denied the old key
-- is denied the new one, and a person who ALREADY holds the key (team.monitor) is not touched.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE:
--   · It does NOT read the old plan's step 4 («M8»). That step ran AFTER the role rows were written and counted the row it
--     had just written as «a source this person is not denied». Here EVERY question is asked of a snapshot taken BEFORE the
--     first row is written (the sp10_* temp tables below), and the «منع» goes in first.
--   · It does NOT re-grant what the owner unticked. The sources are read as they stand TODAY.
--   · It does NOT give payroll.view to anybody: the payslip preview now asks payroll.pay AND payroll.view, and granting
--     payroll.view to every payroll.pay holder would open the profile's pay and a colleague's owed commission to people who do
--     not see them today. The pre-deploy report lists whoever holds the first without the second.
--   · It does NOT write the key for analytics.view: that key was retired on 29/10 and every holder received reports.view.
--   · It writes nothing for SUPER_ADMIN (passes everything) and nothing for a person with no stored role — the in-code
--     fallback in permissions-core (VISIBILITY_KEYS_FROM) keeps those people their doors.
--
-- None of the keys has a scope (the old doors never evaluated one), so every row is written at ALL_COMPANY.
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING into the three grant tables; no row is changed or removed. The sp10_*
-- tables are TEMPORARY (they die with the session) and are dropped at the end. Every row written has an id starting with
-- 'ci10-', which is how rollback.sql finds them and nothing else.
--
-- NO BEGIN / COMMIT HERE ON PURPOSE: whoever rehearses this file inside their own transaction and rolls it back must
-- really roll it back.
--
-- ORDER MATTERS: snapshot → «منع» → «سماح» → roles → baselines.

DROP TABLE IF EXISTS pg_temp.sp10_user_role, pg_temp.sp10_gate, pg_temp.sp10_holds, pg_temp.sp10_has, pg_temp.sp10_pass, pg_temp.sp10_role_gets, pg_temp.sp10_default_gets;

-- The doors: the box on the left is given to whoever held the key in `src` — or, on a row with a role_name, to whoever's
-- role IS that name.
CREATE TEMP TABLE sp10_gate AS
SELECT * FROM (VALUES
  ('costs.view',    'inventory.view',      NULL::text),
  ('costs.view',    'inventory.adjust',    NULL::text),
  ('costs.view',    'production.view',     NULL::text),
  ('costs.view',    'production.manage',   NULL::text),
  ('costs.view',    'finance.view',        NULL::text),
  ('insights.view', 'products.view',       NULL::text),
  ('insights.view', 'inventory.view',      NULL::text),
  ('insights.view', 'reports.view',        NULL::text),
  ('insights.view', 'dashboard.view',      NULL::text),
  ('insights.view', 'confirmation.work',   NULL::text),
  ('insights.view', 'orders.confirm',      NULL::text),
  ('insights.view', 'customers.view',      NULL::text),
  ('insights.view', 'orders.view',         NULL::text),
  ('insights.view', 'landing_pages.view',  NULL::text),
  ('team.monitor',  'users.view',          NULL::text),
  ('team.monitor',  NULL::text,            'COMPANY_ADMIN'),
  ('team.monitor',  NULL::text,            'MANAGER')
) AS g (new_key, src, role_name);

-- Which role each person's grants come from — the way permissions-core reads it: their roleId, or, with none,
-- the system template named like their role. SUPER_ADMIN passes everything anyway.
CREATE TEMP TABLE sp10_user_role AS
SELECT u."id" AS uid, r."id" AS rid
FROM "users" u
JOIN "roles" r
  ON (u."roleId" IS NOT NULL AND r."id" = u."roleId")
  OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")
WHERE u."role" <> 'SUPER_ADMIN';

-- The source keys each person HOLDS today: their own «سماح» (which REPLACES the role's row for the same key, exactly as the
-- engine does) or else the role's row — and not under a «منع».
CREATE TEMP TABLE sp10_holds AS
SELECT h.uid, h.k
FROM (
  SELECT up."userId" AS uid, up."permission" AS k
  FROM "user_permissions" up
  JOIN "users" u ON u."id" = up."userId"
  WHERE up."effect" = 'ALLOW' AND u."role" <> 'SUPER_ADMIN'
  UNION ALL
  SELECT ur.uid, rp."permission"
  FROM sp10_user_role ur
  JOIN "role_permissions" rp ON rp."roleId" = ur.rid
  WHERE NOT EXISTS (
    SELECT 1 FROM "user_permissions" a
    WHERE a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW')
) h
WHERE h.k IN (SELECT src FROM sp10_gate WHERE src IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" d
    WHERE d."userId" = h.uid AND d."permission" = h.k AND d."effect" = 'DENY');

-- WHO ALREADY HOLDS A BOX THIS FILE WOULD GIVE (only team.monitor exists before today): they passed that door through the
-- box itself, so they are not touched — a «منع» written on top of a working grant would take a door away. A personal row of
-- either kind settles the question for that key; else the role's row stands.
CREATE TEMP TABLE sp10_has AS
SELECT up."userId" AS uid, up."permission" AS k
FROM "user_permissions" up
WHERE up."effect" = 'ALLOW' AND up."permission" IN (SELECT new_key FROM sp10_gate)
UNION
SELECT ur.uid, rp."permission"
FROM sp10_user_role ur
JOIN "role_permissions" rp ON rp."roleId" = ur.rid
WHERE rp."permission" IN (SELECT new_key FROM sp10_gate)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" o
    WHERE o."userId" = ur.uid AND o."permission" = rp."permission");

-- WHO PASSED EACH DOOR YESTERDAY: holds ANY key the door asked, or whose role NAME the door read.
CREATE TEMP TABLE sp10_pass AS
SELECT h.uid, g.new_key
FROM sp10_holds h
JOIN sp10_gate g ON g.src = h.k
UNION
SELECT u."id", g.new_key
FROM "users" u
JOIN sp10_gate g ON g.role_name = u."role"
WHERE u."role" <> 'SUPER_ADMIN';

-- WHICH ROLES WILL RECEIVE EACH BOX: those that hold any key the door asked today, and those NAMED like a role the door read.
CREATE TEMP TABLE sp10_role_gets AS
SELECT rp."roleId" AS rid, g.new_key
FROM "role_permissions" rp
JOIN sp10_gate g ON g.src = rp."permission"
UNION
SELECT r."id", g.new_key
FROM "roles" r
JOIN sp10_gate g ON g.role_name = r."name";

-- The same question of the baseline «إرجاع للافتراضي» restores.
CREATE TEMP TABLE sp10_default_gets AS
SELECT d."roleId" AS rid, g.new_key
FROM "role_permission_defaults" d
JOIN sp10_gate g ON g.src = d."permission"
UNION
SELECT r."id", g.new_key
FROM "roles" r
JOIN sp10_gate g ON g.role_name = r."name";

-- 1. A «منع» is carried FIRST. A person whose role is about to receive a box but who did NOT pass that door yesterday
--    (every way in was refused to them) is refused the box: no door gained. Left alone: whoever already holds the box.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'ci10-' || gen_random_uuid()::text, ur.uid, rg.new_key, 'DENY', NULL, NULL, now()
FROM sp10_user_role ur
JOIN sp10_role_gets rg ON rg.rid = ur.rid
WHERE NOT EXISTS (SELECT 1 FROM sp10_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)
  AND NOT EXISTS (SELECT 1 FROM sp10_has x WHERE x.uid = ur.uid AND x.k = rg.new_key)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 2. A person who passed through their own «سماح» or their role NAME, and whose role does not receive the box, gets a
--    «سماح» of their own: no door lost.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'ci10-' || gen_random_uuid()::text, p.uid, p.new_key, 'ALLOW', 'ALL_COMPANY', NULL, now()
FROM sp10_pass p
WHERE NOT EXISTS (
    SELECT 1 FROM sp10_user_role ur
    JOIN sp10_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key
    WHERE ur.uid = p.uid)
  AND NOT EXISTS (SELECT 1 FROM sp10_has x WHERE x.uid = p.uid AND x.k = p.new_key)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 3. Every role that held a source — company roles AND the system templates (companyId NULL) — receives the box.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'ci10-' || gen_random_uuid()::text, rg.rid, rg.new_key, 'ALL_COMPANY', NULL
FROM sp10_role_gets rg
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 4. And the baseline «إرجاع للافتراضي» restores, or the first reset after this deploy would take the box away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'ci10-' || gen_random_uuid()::text, dg.rid, dg.new_key, 'ALL_COMPANY', NULL
FROM sp10_default_gets dg
ON CONFLICT ("roleId", "permission") DO NOTHING;

DROP TABLE IF EXISTS pg_temp.sp10_user_role, pg_temp.sp10_gate, pg_temp.sp10_holds, pg_temp.sp10_has, pg_temp.sp10_pass, pg_temp.sp10_role_gets, pg_temp.sp10_default_gets;
