-- THE CATEGORIES AND THE CAMPAIGNS GET KEYS OF THEIR OWN (perm-plan PR-11). Three new keys:
--   categories.manage · campaigns.view · campaigns.manage
-- The owner's rule, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي».
--
-- THE RULE: NOBODY LOSES A DOOR AND NOBODY GAINS ONE ON THE DAY — with ONE deliberate exception (D1m), written below. A door
-- that asked for a wider key now asks for a box of its own:
--
--     seeing the campaigns screen and its list                                reports.view  →  campaigns.view
--     typing a campaign in, editing, deleting, ordering, merging duplicates,
--       the bulk delete, and the two pulls from the ad platforms
--       («اسحب الإنفاق» = campaigns/sync, «اسحب الحملات» = campaigns/import)    reports.view  →  campaigns.manage
--     naming, renaming and deleting a category; the sorter making a new shelf  products.edit →  categories.manage
--
-- reports.view and products.edit STAY: the first still opens the reports board and the numbers, the second still edits
-- products. Their holders keep every one of those doors; they simply also receive the new boxes.
--
-- THE ONE DELIBERATE NARROWING (D1m): the categories' writes asked products.edit and NEVER READ ITS SCOPE, so someone who
-- may edit only CERTAIN categories or CERTAIN products could rename and delete the COMPANY's shelves. categories.manage goes
-- to whoever holds products.edit «كل الشركة» and to nobody who holds it narrower — role or personal «سماح» alike. A person
-- whose own scoped «سماح» narrows a company-wide role is refused the box with a «منع», for the same reason. Nothing else
-- in this file takes a door from anybody. (The deploy report, scripts/permission-predeploy-report.sql, lists who this reaches.)
--
-- This file gives each box to exactly the roles and the people who passed that door yesterday, in the three places a grant
-- lives: the role, the role's «إرجاع للافتراضي» baseline and the person's own exception. Every «منع» is carried across,
-- so a person denied the old key is denied the new boxes.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE:
--   · It does NOT read the old plan's step 4 («M9»). That step ran AFTER the role rows were written and counted the row it
--     had just written as «a source this person is not denied». Here EVERY question is asked of a snapshot taken BEFORE the
--     first row is written (the sp11_* temp tables below), and the «منع» goes in first.
--   · It does NOT re-grant what the owner unticked. The sources are read as they stand TODAY.
--   · It writes nothing for SUPER_ADMIN (passes everything) and nothing for a person with no stored role — the in-code
--     fallback in permissions-core (CATEGORIES_CAMPAIGNS_KEYS_FROM) keeps those people their doors.
--   · It does NOT read analytics.view: that key was retired by 20261029130000, which gave every holder reports.view.
--
-- None of the three keys has a scope, so every row is written at ALL_COMPANY.
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING into the three grant tables; no row is changed or removed. The sp11_*
-- tables are TEMPORARY (they die with the session) and are dropped at the end. Every row written has an id starting with
-- 'cc11-', which is how rollback.sql finds them and nothing else.
--
-- NO BEGIN / COMMIT HERE ON PURPOSE: whoever rehearses this file inside their own transaction and rolls it back must
-- really roll it back.
--
-- ORDER MATTERS: snapshot → «منع» → «سماح» → roles → baselines.

DROP TABLE IF EXISTS pg_temp.sp11_user_role, pg_temp.sp11_gate, pg_temp.sp11_holds, pg_temp.sp11_pass, pg_temp.sp11_role_gets, pg_temp.sp11_default_gets;

-- The doors: the box on the left is given to whoever held the key in `src`. all_company_only: the source counts only when
-- it is held «كل الشركة» (D1m).
CREATE TEMP TABLE sp11_gate AS
SELECT * FROM (VALUES
  ('categories.manage', 'products.edit', true),
  ('campaigns.view',    'reports.view',  false),
  ('campaigns.manage',  'reports.view',  false)
) AS g (new_key, src, all_company_only);

-- Which role each person's grants come from — the way permissions-core reads it: their roleId, or, with none,
-- the system template named like their role. SUPER_ADMIN passes everything anyway.
CREATE TEMP TABLE sp11_user_role AS
SELECT u."id" AS uid, r."id" AS rid
FROM "users" u
JOIN "roles" r
  ON (u."roleId" IS NOT NULL AND r."id" = u."roleId")
  OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")
WHERE u."role" <> 'SUPER_ADMIN';

-- The source keys each person HOLDS today, with the scope they hold them at: their own «سماح» (which REPLACES the role's
-- row for the same key, exactly as the engine does) or else the role's row — and not under a «منع».
CREATE TEMP TABLE sp11_holds AS
SELECT h.uid, h.k, h.scope
FROM (
  SELECT up."userId" AS uid, up."permission" AS k, COALESCE(up."scope", 'ALL_COMPANY') AS scope
  FROM "user_permissions" up
  JOIN "users" u ON u."id" = up."userId"
  WHERE up."effect" = 'ALLOW' AND u."role" <> 'SUPER_ADMIN'
  UNION ALL
  SELECT ur.uid, rp."permission", COALESCE(rp."scope", 'ALL_COMPANY')
  FROM sp11_user_role ur
  JOIN "role_permissions" rp ON rp."roleId" = ur.rid
  WHERE NOT EXISTS (
    SELECT 1 FROM "user_permissions" a
    WHERE a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW')
) h
WHERE h.k IN (SELECT src FROM sp11_gate)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" d
    WHERE d."userId" = h.uid AND d."permission" = h.k AND d."effect" = 'DENY');

-- WHO PASSED EACH DOOR YESTERDAY: holds the key the door asked — and, where the gate says so (D1m), holds it «كل الشركة».
CREATE TEMP TABLE sp11_pass AS
SELECT h.uid, g.new_key
FROM sp11_holds h
JOIN sp11_gate g ON g.src = h.k
WHERE NOT g.all_company_only OR h.scope = 'ALL_COMPANY';

-- WHICH ROLES WILL RECEIVE EACH BOX: those that hold the key the door asked today (and, for D1m, hold it «كل الشركة»).
CREATE TEMP TABLE sp11_role_gets AS
SELECT rp."roleId" AS rid, g.new_key
FROM "role_permissions" rp
JOIN sp11_gate g ON g.src = rp."permission"
WHERE NOT g.all_company_only OR COALESCE(rp."scope", 'ALL_COMPANY') = 'ALL_COMPANY';

-- The same question of the baseline «إرجاع للافتراضي» restores.
CREATE TEMP TABLE sp11_default_gets AS
SELECT d."roleId" AS rid, g.new_key
FROM "role_permission_defaults" d
JOIN sp11_gate g ON g.src = d."permission"
WHERE NOT g.all_company_only OR COALESCE(d."scope", 'ALL_COMPANY') = 'ALL_COMPANY';

-- 1. A «منع» is carried FIRST. A person whose role is about to receive a box but who did NOT pass that door yesterday
--    (every way in was refused to them, or — D1m — their own scoped «سماح» narrows the role's company-wide row) is
--    refused the box: no door gained.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'cc11-' || gen_random_uuid()::text, ur.uid, rg.new_key, 'DENY', NULL, NULL, now()
FROM sp11_user_role ur
JOIN sp11_role_gets rg ON rg.rid = ur.rid
WHERE NOT EXISTS (SELECT 1 FROM sp11_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 2. A person who passed through their own «سماح», and whose role does not receive the box, gets a «سماح» of their own:
--    no door lost.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'cc11-' || gen_random_uuid()::text, p.uid, p.new_key, 'ALLOW', 'ALL_COMPANY', NULL, now()
FROM sp11_pass p
WHERE NOT EXISTS (
  SELECT 1 FROM sp11_user_role ur
  JOIN sp11_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key
  WHERE ur.uid = p.uid)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 3. Every role that held a source — company roles AND the system templates (companyId NULL) — receives the box.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'cc11-' || gen_random_uuid()::text, rg.rid, rg.new_key, 'ALL_COMPANY', NULL
FROM sp11_role_gets rg
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 4. And the baseline «إرجاع للافتراضي» restores, or the first reset after this deploy would take the box away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'cc11-' || gen_random_uuid()::text, dg.rid, dg.new_key, 'ALL_COMPANY', NULL
FROM sp11_default_gets dg
ON CONFLICT ("roleId", "permission") DO NOTHING;

DROP TABLE IF EXISTS pg_temp.sp11_user_role, pg_temp.sp11_gate, pg_temp.sp11_holds, pg_temp.sp11_pass, pg_temp.sp11_role_gets, pg_temp.sp11_default_gets;
