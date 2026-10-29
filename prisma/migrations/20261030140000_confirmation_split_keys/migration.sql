-- THE CONFIRMATION AND CHANGE-REQUEST DOORS GET A BOX EACH (perm-plan PR-7). Six new keys, and one orphan mended:
--   confirmation.winback · confirmation.reassign · confirmation.issues_correct · confirmation.raise_issue
--   control.change_requests_view · ops.decide_changes
--   and the tier key customers.view_basic for whoever holds customers.view without it.
-- The owner's rule, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي».
--
-- THE RULE: NOBODY LOSES A DOOR AND NOBODY GAINS ONE ON THE DAY — with ONE deliberate exception, written below. A door that
-- asked for a wider key (or for a role NAME) now asks for a box of its own:
--
--     the win-back offer                       confirmation.supervise   →  confirmation.winback
--     handing a colleague's postponed order    confirmation.supervise   →  confirmation.reassign
--     closing an entry issue by correcting it  confirmation.issues      →  confirmation.issues_correct
--     raising an entry issue                   confirmation.issues      →  confirmation.raise_issue
--     seeing the whole change-request desk     control.change_requests OR the NAMES SUPER_ADMIN / COMPANY_ADMIN /
--                                              MANAGER / CONFIRMATION_SUPERVISOR  →  control.change_requests_view
--     deciding at the packing table            ops.ship OR the NAME WAREHOUSE     →  ops.decide_changes
--     the full customer tier without its page  customers.view                    →  customers.view_basic (the SAME scope)
--
-- THE MONEY RULE, which is why orders.change_price appears here too. Approving a change request that moves a price, a
-- discount, a quantity or a product now needs orders.change_price BESIDES the right to decide. Everybody who could approve
-- one yesterday keeps doing so: the desk (control.change_requests), the packing table (ops.ship, the NAME WAREHOUSE) and the
-- agent holding the order (confirmation.pull / confirmation.work / orders.claim) receive the key — EXCEPT whoever holds
-- orders.edit, who got it from 20261030130000_order_action_keys already (and who, if the owner took it away since, keeps
-- the owner's choice: this file does not give it back). The key is conferred WITHOUT orders.edit, which every direct
-- price edit still asks first, so no edit door opens with it. These are the "actions without their view" the pre-deploy
-- report lists; the role screens tolerate an old pair and refuse only a pair a save adds.
--
-- THE ONE DELIBERATE GAIN (D14, decided under the owner's rule above): the role CONFIRMATION_AGENT receives
-- confirmation.raise_issue. The button «إدخال إشكال» sits on her own desk and always answered 403, because the door asked
-- for the issues LIST she was never given. Nothing else here gives anybody a door they did not have.
--
-- This file gives each box to exactly the roles and the people who passed that door yesterday — «any of the keys» where the
-- door took either, and "the name" where the door read a name — in the three places a grant lives: the role, the role's
-- «إرجاع للافتراضي» baseline and the person's own exception. Every «منع» is carried across, so a person denied the old key
-- is denied the new one, and a person who ALREADY holds the key (customers.view_basic, orders.change_price) is not touched.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE:
--   · It does NOT read the old plan's step 4 («M5»). That step ran AFTER the role rows were written and counted the row it
--     had just written as «a source this person is not denied». Here EVERY question is asked of a snapshot taken BEFORE the
--     first row is written (the sp7_* temp tables below), and the «منع» goes in first.
--   · It does NOT re-grant what the owner unticked. The sources are read as they stand TODAY.
--   · It writes nothing for SUPER_ADMIN (passes everything). A person with no stored role keeps their doors through the
--     in-code fallback in permissions-core (CONFIRMATION_SPLIT_KEYS_FROM), which reads the same list — except the price key,
--     which the fallback does not derive (a person answered by the fallback does not exist once the permission-engine
--     migration has run): there the deciding keys count only as personal «سماح» rows, which this file does read.
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING into the three grant tables; no row is changed or removed. The sp7_*
-- tables are TEMPORARY (they die with the session) and are dropped at the end. Every row written has an id starting with
-- 'cs7-', which is how rollback.sql finds them and nothing else.
--
-- NO BEGIN / COMMIT HERE ON PURPOSE: whoever rehearses this file inside their own transaction and rolls it back must
-- really roll it back.
--
-- ORDER MATTERS: snapshot → «منع» → «سماح» → roles → baselines.

DROP TABLE IF EXISTS pg_temp.sp7_user_role, pg_temp.sp7_gate, pg_temp.sp7_holds, pg_temp.sp7_has, pg_temp.sp7_pass, pg_temp.sp7_role_gets, pg_temp.sp7_default_gets;

-- The doors: the box on the left is given to whoever held the key in `src` — or, on a row with a role_name, to whoever's
-- role IS that name. unless_key: whoever holds that key is left alone (an earlier migration judged them). copy_scope = the
-- box keeps the scope of the key it comes from.
CREATE TEMP TABLE sp7_gate AS
SELECT * FROM (VALUES
  ('confirmation.winback',         'confirmation.supervise', NULL::text,                  false, NULL::text),
  ('confirmation.reassign',        'confirmation.supervise', NULL::text,                  false, NULL::text),
  ('confirmation.issues_correct',  'confirmation.issues',    NULL::text,                  false, NULL::text),
  ('confirmation.raise_issue',     'confirmation.issues',    NULL::text,                  false, NULL::text),
  ('confirmation.raise_issue',     NULL::text,               'CONFIRMATION_AGENT',        false, NULL::text),
  ('control.change_requests_view', 'control.change_requests', NULL::text,                 false, NULL::text),
  ('control.change_requests_view', NULL::text,               'SUPER_ADMIN',               false, NULL::text),
  ('control.change_requests_view', NULL::text,               'COMPANY_ADMIN',             false, NULL::text),
  ('control.change_requests_view', NULL::text,               'MANAGER',                   false, NULL::text),
  ('control.change_requests_view', NULL::text,               'CONFIRMATION_SUPERVISOR',   false, NULL::text),
  ('ops.decide_changes',           'ops.ship',               NULL::text,                  false, NULL::text),
  ('ops.decide_changes',           NULL::text,               'WAREHOUSE',                 false, NULL::text),
  ('orders.change_price',          'control.change_requests', NULL::text,                 false, 'orders.edit'),
  ('orders.change_price',          'ops.ship',               NULL::text,                  false, 'orders.edit'),
  ('orders.change_price',          'confirmation.pull',      NULL::text,                  false, 'orders.edit'),
  ('orders.change_price',          'confirmation.work',      NULL::text,                  false, 'orders.edit'),
  ('orders.change_price',          'orders.claim',           NULL::text,                  false, 'orders.edit'),
  ('orders.change_price',          NULL::text,               'WAREHOUSE',                 false, 'orders.edit'),
  ('customers.view_basic',         'customers.view',         NULL::text,                  true,  NULL::text)
) AS g (new_key, src, role_name, copy_scope, unless_key);

-- Which role each person's grants come from — the way permissions-core reads it: their roleId, or, with none,
-- the system template named like their role. SUPER_ADMIN passes everything anyway.
CREATE TEMP TABLE sp7_user_role AS
SELECT u."id" AS uid, r."id" AS rid
FROM "users" u
JOIN "roles" r
  ON (u."roleId" IS NOT NULL AND r."id" = u."roleId")
  OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")
WHERE u."role" <> 'SUPER_ADMIN';

-- The keys each person HOLDS today (a source of a door, or a key the door lets them off), with the scope they hold it at:
-- their own «سماح» (which REPLACES the role's row for the same key, exactly as the engine does) or else the role's row —
-- and not under a «منع».
CREATE TEMP TABLE sp7_holds AS
SELECT h.uid, h.k, h.scope, h.scope_ids, h.own_allow
FROM (
  SELECT up."userId" AS uid, up."permission" AS k, COALESCE(up."scope", 'ALL_COMPANY') AS scope, up."scopeIds" AS scope_ids, true AS own_allow
  FROM "user_permissions" up
  JOIN "users" u ON u."id" = up."userId"
  WHERE up."effect" = 'ALLOW' AND u."role" <> 'SUPER_ADMIN'
  UNION ALL
  SELECT ur.uid, rp."permission", rp."scope", rp."scopeIds", false
  FROM sp7_user_role ur
  JOIN "role_permissions" rp ON rp."roleId" = ur.rid
  WHERE NOT EXISTS (
    SELECT 1 FROM "user_permissions" a
    WHERE a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW')
) h
WHERE h.k IN (SELECT src FROM sp7_gate WHERE src IS NOT NULL UNION SELECT unless_key FROM sp7_gate WHERE unless_key IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" d
    WHERE d."userId" = h.uid AND d."permission" = h.k AND d."effect" = 'DENY');

-- WHO ALREADY HOLDS A BOX THIS FILE WOULD GIVE (only customers.view_basic and orders.change_price exist before today): they
-- passed that door through the box itself, so they are not touched — a «منع» written on top of a working grant would take
-- a door away. A personal row of either kind settles the question for that key; else the role's row stands.
CREATE TEMP TABLE sp7_has AS
SELECT up."userId" AS uid, up."permission" AS k
FROM "user_permissions" up
WHERE up."effect" = 'ALLOW' AND up."permission" IN (SELECT new_key FROM sp7_gate)
UNION
SELECT ur.uid, rp."permission"
FROM sp7_user_role ur
JOIN "role_permissions" rp ON rp."roleId" = ur.rid
WHERE rp."permission" IN (SELECT new_key FROM sp7_gate)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" o
    WHERE o."userId" = ur.uid AND o."permission" = rp."permission");

-- WHO PASSED EACH DOOR YESTERDAY: holds ANY key the door asked (at the scope the box should carry), or whose role NAME
-- the door read — except whoever holds the key the gate row says to leave alone.
CREATE TEMP TABLE sp7_pass AS
SELECT h.uid, g.new_key, g.copy_scope, h.own_allow,
  CASE WHEN g.copy_scope THEN h.scope ELSE 'ALL_COMPANY' END AS scope,
  CASE WHEN g.copy_scope THEN h.scope_ids END AS scope_ids
FROM sp7_holds h
JOIN sp7_gate g ON g.src = h.k
WHERE g.unless_key IS NULL
   OR NOT EXISTS (SELECT 1 FROM sp7_holds uh WHERE uh.uid = h.uid AND uh.k = g.unless_key)
UNION ALL
SELECT u."id", g.new_key, g.copy_scope, false, 'ALL_COMPANY', NULL
FROM "users" u
JOIN sp7_gate g ON g.role_name = u."role"
WHERE u."role" <> 'SUPER_ADMIN'
  AND (g.unless_key IS NULL
       OR NOT EXISTS (SELECT 1 FROM sp7_holds uh WHERE uh.uid = u."id" AND uh.k = g.unless_key));

-- WHICH ROLES WILL RECEIVE EACH BOX: those that hold any key the door asked today (with that key's scope when it is
-- copied), and those NAMED like a role the door read — except a role that holds the key the gate row says to leave alone.
CREATE TEMP TABLE sp7_role_gets AS
SELECT rp."roleId" AS rid, g.new_key,
  CASE WHEN g.copy_scope THEN rp."scope" ELSE 'ALL_COMPANY' END AS scope,
  CASE WHEN g.copy_scope THEN rp."scopeIds" END AS scope_ids,
  g.unless_key
FROM "role_permissions" rp
JOIN sp7_gate g ON g.src = rp."permission"
WHERE g.unless_key IS NULL
   OR NOT EXISTS (SELECT 1 FROM "role_permissions" e WHERE e."roleId" = rp."roleId" AND e."permission" = g.unless_key)
UNION ALL
SELECT r."id", g.new_key, 'ALL_COMPANY', NULL, g.unless_key
FROM "roles" r
JOIN sp7_gate g ON g.role_name = r."name"
WHERE g.unless_key IS NULL
   OR NOT EXISTS (SELECT 1 FROM "role_permissions" e WHERE e."roleId" = r."id" AND e."permission" = g.unless_key);

-- The same question of the baseline «إرجاع للافتراضي» restores.
CREATE TEMP TABLE sp7_default_gets AS
SELECT d."roleId" AS rid, g.new_key,
  CASE WHEN g.copy_scope THEN d."scope" ELSE 'ALL_COMPANY' END AS scope,
  CASE WHEN g.copy_scope THEN d."scopeIds" END AS scope_ids
FROM "role_permission_defaults" d
JOIN sp7_gate g ON g.src = d."permission"
WHERE g.unless_key IS NULL
   OR NOT EXISTS (SELECT 1 FROM "role_permission_defaults" e WHERE e."roleId" = d."roleId" AND e."permission" = g.unless_key)
UNION ALL
SELECT r."id", g.new_key, 'ALL_COMPANY', NULL
FROM "roles" r
JOIN sp7_gate g ON g.role_name = r."name"
WHERE g.unless_key IS NULL
   OR NOT EXISTS (SELECT 1 FROM "role_permission_defaults" e WHERE e."roleId" = r."id" AND e."permission" = g.unless_key);

-- 1. A «منع» is carried FIRST. A person whose role is about to receive a box but who did NOT pass that door yesterday
--    (every way in was refused to them) is refused the box: no door gained. That includes a person the gate row lets off
--    (an orders.edit holder without the price key: the owner took it from them, and the role's new row must not hand it
--    back). Left alone: whoever already holds the box.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'cs7-' || gen_random_uuid()::text, ur.uid, rg.new_key, 'DENY', NULL, NULL, now()
FROM sp7_user_role ur
JOIN sp7_role_gets rg ON rg.rid = ur.rid
WHERE NOT EXISTS (SELECT 1 FROM sp7_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)
  AND NOT EXISTS (SELECT 1 FROM sp7_has x WHERE x.uid = ur.uid AND x.k = rg.new_key)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 2. A person who passed through their own «سماح» or their role NAME, and whose role does not receive the box, gets a
--    «سماح» of their own: no door lost. A SCOPED box also gets one wherever the person's own «سماح» on the old key set
--    the scope, because that row replaces the role's and the box must be exactly as wide. A SCOPED box writes nothing for a
--    person with no stored role: the in-code fallback in permissions-core answers for them, and it can see the legacy
--    customers.view_basic this file cannot — a «سماح» here would narrow its scope to the full tier's.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'cs7-' || gen_random_uuid()::text, p.uid, p.new_key, 'ALLOW', p.scope, p.scope_ids, now()
FROM sp7_pass p
WHERE ((p.copy_scope AND p.own_allow)
   OR NOT EXISTS (
     SELECT 1 FROM sp7_user_role ur
     JOIN sp7_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key
     WHERE ur.uid = p.uid))
  AND NOT EXISTS (SELECT 1 FROM sp7_has x WHERE x.uid = p.uid AND x.k = p.new_key)
  AND (NOT p.copy_scope OR EXISTS (SELECT 1 FROM sp7_user_role ur WHERE ur.uid = p.uid))
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 3. Every role that held a source — company roles AND the system templates (companyId NULL) — receives the box.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'cs7-' || gen_random_uuid()::text, rg.rid, rg.new_key, rg.scope, rg.scope_ids
FROM sp7_role_gets rg
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 4. And the baseline «إرجاع للافتراضي» restores, or the first reset after this deploy would take the box away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'cs7-' || gen_random_uuid()::text, dg.rid, dg.new_key, dg.scope, dg.scope_ids
FROM sp7_default_gets dg
ON CONFLICT ("roleId", "permission") DO NOTHING;

DROP TABLE IF EXISTS pg_temp.sp7_user_role, pg_temp.sp7_gate, pg_temp.sp7_holds, pg_temp.sp7_has, pg_temp.sp7_pass, pg_temp.sp7_role_gets, pg_temp.sp7_default_gets;
