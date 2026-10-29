-- THE ORDER ACTIONS GET A BOX EACH (perm-plan PR-6). Seven new keys:
--   orders.change_price · orders.change_fee · orders.cancel · orders.note · orders.request_change
--   orders.rating_link · control.blacklist_manage
-- The owner's rule, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي».
--
-- THE RULE: NOBODY LOSES A DOOR AND NOBODY GAINS ONE ON THE DAY. A door that asked for a wider key now asks for a box of
-- its own:
--
--     the price, the discount, a line's price          orders.edit            →  orders.change_price   (with the SAME scope)
--     the delivery fee                                 orders.change_status   →  orders.change_fee
--     cancelling, voiding                              orders.unlock          →  orders.cancel
--     writing a note on an order                       orders.view | confirmation.work  →  orders.note
--     raising a change request                         orders.view | confirmation.work  →  orders.request_change
--     the review link                                  orders.view            →  orders.rating_link
--     blocking / releasing a number                    control.blacklist      →  control.blacklist_manage
--
-- This file gives each box to exactly the roles and the people who passed that door yesterday — «any of the keys» where the
-- door took either — in the three places a grant lives: the role, the role's «إرجاع للافتراضي» baseline and the person's own
-- exception. Every «منع» is carried across, so a person denied the old key is denied the new one. From the next day the
-- owner unticks one box without touching the others.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE:
--   · It does NOT read the old plan's step 4 («M4»). That step ran AFTER the role rows were written and counted the row it
--     had just written as «a source this person is not denied». Here EVERY question is asked of a snapshot taken BEFORE the
--     first row is written (the sp6_* temp tables below), and the «منع» goes in first.
--   · It does NOT re-grant what the owner unticked. The sources are read as they stand TODAY: a role that lost orders.view
--     on 28/10 gets orders.rating_link only if it still holds the key the door asks.
--   · It does NOT give orders.cancel to holders of ops.ship (the old plan did). The stand-down door asks ops.ship and is not
--     moved onto orders.cancel in this change; PR-8 moves it and adds the source then. Giving the box now would open the
--     three cancel doors to people they were closed to.
--   · It writes nothing for SUPER_ADMIN (passes everything) and nothing for a person with no stored role — the in-code
--     fallback in permissions-core (ORDER_ACTION_KEYS_FROM) keeps those people their doors.
--
-- THE ONE KEY WITH A SCOPE: orders.change_price takes the SCOPE of the orders.edit it comes from (all the company's orders,
-- only mine, only the assigned ones) — the role's own, or the person's own «سماح» — because the old door evaluated it; an
-- agent who edits only her own orders must not price every order of the company on the day this ships.
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING into the three grant tables; no row is changed or removed. The sp6_*
-- tables are TEMPORARY (they die with the session) and are dropped at the end. Every row written has an id starting with
-- 'oa6-', which is how rollback.sql finds them and nothing else.
--
-- NO BEGIN / COMMIT HERE ON PURPOSE: whoever rehearses this file inside their own transaction and rolls it back must
-- really roll it back.
--
-- ORDER MATTERS: snapshot → «منع» → «سماح» → roles → baselines.

DROP TABLE IF EXISTS pg_temp.sp6_user_role, pg_temp.sp6_gate, pg_temp.sp6_holds, pg_temp.sp6_pass, pg_temp.sp6_role_gets, pg_temp.sp6_default_gets;

-- The doors: the box on the left is given to whoever held ANY key on the right (two rows = either one). copy_scope = the
-- box keeps the scope of the key it comes from.
CREATE TEMP TABLE sp6_gate AS
SELECT * FROM (VALUES
  ('orders.change_price',      'orders.edit',          true),
  ('orders.change_fee',        'orders.change_status', false),
  ('orders.cancel',            'orders.unlock',        false),
  ('orders.note',              'orders.view',          false),
  ('orders.note',              'confirmation.work',    false),
  ('orders.request_change',    'orders.view',          false),
  ('orders.request_change',    'confirmation.work',    false),
  ('orders.rating_link',       'orders.view',          false),
  ('control.blacklist_manage', 'control.blacklist',    false)
) AS g (new_key, src, copy_scope);

-- Which role each person's grants come from — the way permissions-core reads it: their roleId, or, with none,
-- the system template named like their role. SUPER_ADMIN passes everything anyway.
CREATE TEMP TABLE sp6_user_role AS
SELECT u."id" AS uid, r."id" AS rid
FROM "users" u
JOIN "roles" r
  ON (u."roleId" IS NOT NULL AND r."id" = u."roleId")
  OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")
WHERE u."role" <> 'SUPER_ADMIN';

-- The source keys each person HOLDS today, with the scope they hold it at: their own «سماح» (which REPLACES the role's row
-- for the same key, exactly as the engine does) or else the role's row — and not under a «منع».
CREATE TEMP TABLE sp6_holds AS
SELECT h.uid, h.k, h.scope, h.scope_ids, h.own_allow
FROM (
  SELECT up."userId" AS uid, up."permission" AS k, COALESCE(up."scope", 'ALL_COMPANY') AS scope, up."scopeIds" AS scope_ids, true AS own_allow
  FROM "user_permissions" up
  JOIN "users" u ON u."id" = up."userId"
  WHERE up."effect" = 'ALLOW' AND u."role" <> 'SUPER_ADMIN'
  UNION ALL
  SELECT ur.uid, rp."permission", rp."scope", rp."scopeIds", false
  FROM sp6_user_role ur
  JOIN "role_permissions" rp ON rp."roleId" = ur.rid
  WHERE NOT EXISTS (
    SELECT 1 FROM "user_permissions" a
    WHERE a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW')
) h
WHERE h.k IN (SELECT src FROM sp6_gate)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" d
    WHERE d."userId" = h.uid AND d."permission" = h.k AND d."effect" = 'DENY');

-- WHO PASSED EACH DOOR YESTERDAY: holds ANY key the door asked, at the scope the box should carry.
CREATE TEMP TABLE sp6_pass AS
SELECT h.uid, g.new_key, g.copy_scope, h.own_allow,
  CASE WHEN g.copy_scope THEN h.scope ELSE 'ALL_COMPANY' END AS scope,
  CASE WHEN g.copy_scope THEN h.scope_ids END AS scope_ids
FROM sp6_holds h
JOIN sp6_gate g ON g.src = h.k;

-- WHICH ROLES WILL RECEIVE EACH BOX: those that hold any key the door asked today (with that key's scope when it is copied).
CREATE TEMP TABLE sp6_role_gets AS
SELECT rp."roleId" AS rid, g.new_key,
  CASE WHEN g.copy_scope THEN rp."scope" ELSE 'ALL_COMPANY' END AS scope,
  CASE WHEN g.copy_scope THEN rp."scopeIds" END AS scope_ids
FROM "role_permissions" rp
JOIN sp6_gate g ON g.src = rp."permission";

-- The same question of the baseline «إرجاع للافتراضي» restores.
CREATE TEMP TABLE sp6_default_gets AS
SELECT d."roleId" AS rid, g.new_key,
  CASE WHEN g.copy_scope THEN d."scope" ELSE 'ALL_COMPANY' END AS scope,
  CASE WHEN g.copy_scope THEN d."scopeIds" END AS scope_ids
FROM "role_permission_defaults" d
JOIN sp6_gate g ON g.src = d."permission";

-- 1. A «منع» is carried FIRST. A person whose role is about to receive a box but who did NOT pass that door yesterday
--    (every way in was refused to them) is refused the box: no door gained.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'oa6-' || gen_random_uuid()::text, ur.uid, rg.new_key, 'DENY', NULL, NULL, now()
FROM sp6_user_role ur
JOIN sp6_role_gets rg ON rg.rid = ur.rid
WHERE NOT EXISTS (SELECT 1 FROM sp6_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 2. A person who passed through their own «سماح», and whose role does not receive the box, gets a «سماح» of their own:
--    no door lost. A SCOPED box (the price) also gets one wherever the person's own «سماح» on the old key set the scope,
--    because that row replaces the role's and the box must be exactly as wide.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'oa6-' || gen_random_uuid()::text, p.uid, p.new_key, 'ALLOW', p.scope, p.scope_ids, now()
FROM sp6_pass p
WHERE (p.copy_scope AND p.own_allow)
   OR NOT EXISTS (
     SELECT 1 FROM sp6_user_role ur
     JOIN sp6_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key
     WHERE ur.uid = p.uid)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 3. Every role that held a source — company roles AND the system templates (companyId NULL) — receives the box.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'oa6-' || gen_random_uuid()::text, rg.rid, rg.new_key, rg.scope, rg.scope_ids
FROM sp6_role_gets rg
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 4. And the baseline «إرجاع للافتراضي» restores, or the first reset after this deploy would take the box away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'oa6-' || gen_random_uuid()::text, dg.rid, dg.new_key, dg.scope, dg.scope_ids
FROM sp6_default_gets dg
ON CONFLICT ("roleId", "permission") DO NOTHING;

DROP TABLE IF EXISTS pg_temp.sp6_user_role, pg_temp.sp6_gate, pg_temp.sp6_holds, pg_temp.sp6_pass, pg_temp.sp6_role_gets, pg_temp.sp6_default_gets;
