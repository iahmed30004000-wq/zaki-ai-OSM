-- THE CASH BOX AND THE STATEMENT APPROVAL GET KEYS OF THEIR OWN (perm-plan PR-9). Four new keys:
--   finance.cashbox_view · finance.wallets_manage · finance.closing_approve · settlement.approve
-- The owner's rule, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي».
--
-- THE RULE: NOBODY LOSES A DOOR AND NOBODY GAINS ONE ON THE DAY. A door that asked for a wider key now asks for a box of
-- its own:
--
--     seeing the wallets, the movements, the transfers, the closings   finance.cashbox    →  finance.cashbox_view
--     creating, renaming, stopping, deleting a wallet                  finance.cashbox    →  finance.wallets_manage
--     approving a daily closing                                        finance.cashbox    →  finance.closing_approve
--     approving a courier's statement                                  settlement.review  →  settlement.approve
--
-- finance.cashbox and settlement.review STAY: the first now means only the cash actions (a movement, a transfer, a
-- closing's count, the opening count, «استلمت منه»), the second the matching of lines and the explanation of a gap.
-- Their holders keep every one of those doors; they simply also receive the new boxes.
--
-- This file gives each box to exactly the roles and the people who passed that door yesterday, in the three places a
-- grant lives: the role, the role's «إرجاع للافتراضي» baseline and the person's own exception. Every «منع» is carried
-- across, so a person denied the old key is denied the new boxes. From the next day the owner unticks one box without
-- touching the others.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE:
--   · It does NOT read the old plan's step 4 («M7»). That step ran AFTER the role rows were written and counted the row it
--     had just written as «a source this person is not denied». Here EVERY question is asked of a snapshot taken BEFORE
--     the first row is written (the sp9_* temp tables below), and the «منع» goes in first.
--   · It does NOT re-grant what the owner unticked. The sources are read as they stand TODAY: a role that lost
--     finance.cashbox on 29/10 receives none of the cash boxes.
--   · It does NOT write `settlement.view` for holders of settlement.upload / settlement.review (the old plan's M7 did, so
--     the pages could open on the view key). That would give them the statements list and the agents' custody they do not
--     see today — a door gained. The pages keep their own keys.
--   · It writes nothing for SUPER_ADMIN (passes everything) and nothing for a person with no stored role — the in-code
--     fallback in permissions-core (FINANCE_SPLIT_KEYS_FROM) keeps those people their doors.
--
-- None of the four keys has a scope (the old doors never evaluated one), so every row is written at ALL_COMPANY.
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING into the three grant tables; no row is changed or removed. The sp9_*
-- tables are TEMPORARY (they die with the session) and are dropped at the end. Every row written has an id starting with
-- 'fs9-', which is how rollback.sql finds them and nothing else.
--
-- NO BEGIN / COMMIT HERE ON PURPOSE: whoever rehearses this file inside their own transaction and rolls it back must
-- really roll it back.
--
-- ORDER MATTERS: snapshot → «منع» → «سماح» → roles → baselines.

DROP TABLE IF EXISTS pg_temp.sp9_user_role, pg_temp.sp9_gate, pg_temp.sp9_holds, pg_temp.sp9_pass, pg_temp.sp9_role_gets, pg_temp.sp9_default_gets;

-- The doors: the box on the left is given to whoever held the key on the right.
CREATE TEMP TABLE sp9_gate AS
SELECT * FROM (VALUES
  ('finance.cashbox_view',    'finance.cashbox'),
  ('finance.wallets_manage',  'finance.cashbox'),
  ('finance.closing_approve', 'finance.cashbox'),
  ('settlement.approve',      'settlement.review')
) AS g (new_key, src);

-- Which role each person's grants come from — the way permissions-core reads it: their roleId, or, with none,
-- the system template named like their role. SUPER_ADMIN passes everything anyway.
CREATE TEMP TABLE sp9_user_role AS
SELECT u."id" AS uid, r."id" AS rid
FROM "users" u
JOIN "roles" r
  ON (u."roleId" IS NOT NULL AND r."id" = u."roleId")
  OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")
WHERE u."role" <> 'SUPER_ADMIN';

-- The source keys each person HOLDS today: their own «سماح» (which REPLACES the role's row for the same key, exactly as
-- the engine does) or else the role's row — and not under a «منع».
CREATE TEMP TABLE sp9_holds AS
SELECT h.uid, h.k
FROM (
  SELECT up."userId" AS uid, up."permission" AS k
  FROM "user_permissions" up
  JOIN "users" u ON u."id" = up."userId"
  WHERE up."effect" = 'ALLOW' AND u."role" <> 'SUPER_ADMIN'
  UNION ALL
  SELECT ur.uid, rp."permission"
  FROM sp9_user_role ur
  JOIN "role_permissions" rp ON rp."roleId" = ur.rid
  WHERE NOT EXISTS (
    SELECT 1 FROM "user_permissions" a
    WHERE a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW')
) h
WHERE h.k IN (SELECT src FROM sp9_gate)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" d
    WHERE d."userId" = h.uid AND d."permission" = h.k AND d."effect" = 'DENY');

-- WHO PASSED EACH DOOR YESTERDAY: holds the key the door asked.
CREATE TEMP TABLE sp9_pass AS
SELECT h.uid, g.new_key
FROM sp9_holds h
JOIN sp9_gate g ON g.src = h.k;

-- WHICH ROLES WILL RECEIVE EACH BOX: those that hold the key the door asked today.
CREATE TEMP TABLE sp9_role_gets AS
SELECT rp."roleId" AS rid, g.new_key
FROM "role_permissions" rp
JOIN sp9_gate g ON g.src = rp."permission";

-- The same question of the baseline «إرجاع للافتراضي» restores.
CREATE TEMP TABLE sp9_default_gets AS
SELECT d."roleId" AS rid, g.new_key
FROM "role_permission_defaults" d
JOIN sp9_gate g ON g.src = d."permission";

-- 1. A «منع» is carried FIRST. A person whose role is about to receive a box but who did NOT pass that door yesterday
--    (every way in was refused to them) is refused the box: no door gained.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'fs9-' || gen_random_uuid()::text, ur.uid, rg.new_key, 'DENY', NULL, NULL, now()
FROM sp9_user_role ur
JOIN sp9_role_gets rg ON rg.rid = ur.rid
WHERE NOT EXISTS (SELECT 1 FROM sp9_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 2. A person who passed through their own «سماح», and whose role does not receive the box, gets a «سماح» of their own:
--    no door lost.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'fs9-' || gen_random_uuid()::text, p.uid, p.new_key, 'ALLOW', 'ALL_COMPANY', NULL, now()
FROM sp9_pass p
WHERE NOT EXISTS (
  SELECT 1 FROM sp9_user_role ur
  JOIN sp9_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key
  WHERE ur.uid = p.uid)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 3. Every role that held a source — company roles AND the system templates (companyId NULL) — receives the box.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'fs9-' || gen_random_uuid()::text, rg.rid, rg.new_key, 'ALL_COMPANY', NULL
FROM sp9_role_gets rg
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 4. And the baseline «إرجاع للافتراضي» restores, or the first reset after this deploy would take the box away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'fs9-' || gen_random_uuid()::text, dg.rid, dg.new_key, 'ALL_COMPANY', NULL
FROM sp9_default_gets dg
ON CONFLICT ("roleId", "permission") DO NOTHING;

DROP TABLE IF EXISTS pg_temp.sp9_user_role, pg_temp.sp9_gate, pg_temp.sp9_holds, pg_temp.sp9_pass, pg_temp.sp9_role_gets, pg_temp.sp9_default_gets;
