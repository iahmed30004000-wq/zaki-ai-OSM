-- THE OPERATIONS DOORS GET A BOX EACH (perm-plan PR-8). Five new keys:
--   ops.batches · ops.deliver · ops.transfer · ops.write_off · ops.return_fee
-- The owner's rule, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي».
--
-- THE RULE: NOBODY LOSES A DOOR AND NOBODY GAINS ONE ON THE DAY. A door that asked for a wider key (or for two keys in a
-- chain) now asks for a box of its own:
--
--     seeing the shipping batches (the page and its two read doors)   ops.ship OR ops.track             →  ops.batches
--     recording what happened at the customer's door                  ops.track                         →  ops.deliver
--     moving a parcel to another courier or company                   ops.track                         →  ops.transfer
--     closing a lost parcel as a loss (was a catch-chain)             finance.update OR orders.unlock   →  ops.write_off
--     charging the courier a return fee while receiving a return      ops.returns                       →  ops.return_fee
--
-- ops.track, ops.ship, ops.returns, finance.update and orders.unlock STAY: their holders keep every other door they open;
-- they simply also receive the new boxes. `ops.deliver` is deliberately NOT sourced from orders.change_status (the plan's
-- union): the order's shipping card and the delivery-attempts door, which are what that source was for, do not move in this
-- change — so nobody who changes a shipping status receives the tracking desk's door.
--
-- THE STAND-DOWN DOOR IS NOT MOVED HERE, ON PURPOSE. The plan puts it on orders.cancel, but that key already exists: moving the
-- door would give orders.cancel to every holder of ops.ship (and with it three other cancel doors), give the stand-down to
-- whoever can already cancel, and take it from a holder of ops.ship who carries a personal «منع» on orders.cancel. Under the
-- owner's rule («اي قرار بعد الان اتخذو دون الرجوع الي») it keeps asking ops.ship until it has a key of its own.
--
-- This file gives each box to exactly the roles and the people who passed that door yesterday — «any of the keys» where the
-- door took either — in the three places a grant lives: the role, the role's «إرجاع للافتراضي» baseline and the person's own
-- exception. Every «منع» is carried across, so a person denied the old key is denied the new box, and a person who ALREADY
-- holds a box is not touched (none of the five exists before today; this is a guard, not a case).
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE:
--   · It does NOT read the old plan's step 4 («M6»). That step ran AFTER the role rows were written and counted the row it
--     had just written as «a source this person is not denied». Here EVERY question is asked of a snapshot taken BEFORE the
--     first row is written (the sp8_* temp tables below), and the «منع» goes in first.
--   · It does NOT re-grant what the owner unticked. The sources are read as they stand TODAY.
--   · It does NOT touch the stand-down door at all (see above).
--   · It writes nothing for SUPER_ADMIN (passes everything) and nothing for a person with no stored role — the in-code
--     fallback in permissions-core (OPS_ACTION_KEYS_FROM) keeps those people their doors.
--
-- None of the keys has a scope (the old doors never evaluated one), so every row is written at ALL_COMPANY.
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING into the three grant tables; no row is changed or removed. The sp8_*
-- tables are TEMPORARY (they die with the session) and are dropped at the end. Every row written has an id starting with
-- 'op8-', which is how rollback.sql finds them and nothing else.
--
-- NO BEGIN / COMMIT HERE ON PURPOSE: whoever rehearses this file inside their own transaction and rolls it back must
-- really roll it back.
--
-- ORDER MATTERS: snapshot → «منع» → «سماح» → roles → baselines.

DROP TABLE IF EXISTS pg_temp.sp8_user_role, pg_temp.sp8_gate, pg_temp.sp8_holds, pg_temp.sp8_has, pg_temp.sp8_pass, pg_temp.sp8_role_gets, pg_temp.sp8_default_gets;

-- The doors: the box on the left is given to whoever held the key on the right.
CREATE TEMP TABLE sp8_gate AS
SELECT * FROM (VALUES
  ('ops.batches',    'ops.ship'),
  ('ops.batches',    'ops.track'),
  ('ops.deliver',    'ops.track'),
  ('ops.transfer',   'ops.track'),
  ('ops.write_off',  'finance.update'),
  ('ops.write_off',  'orders.unlock'),
  ('ops.return_fee', 'ops.returns')
) AS g (new_key, src);

-- Which role each person's grants come from — the way permissions-core reads it: their roleId, or, with none,
-- the system template named like their role. SUPER_ADMIN passes everything anyway.
CREATE TEMP TABLE sp8_user_role AS
SELECT u."id" AS uid, r."id" AS rid
FROM "users" u
JOIN "roles" r
  ON (u."roleId" IS NOT NULL AND r."id" = u."roleId")
  OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")
WHERE u."role" <> 'SUPER_ADMIN';

-- The source keys each person HOLDS today: their own «سماح» (which REPLACES the role's row for the same key, exactly as
-- the engine does) or else the role's row — and not under a «منع».
CREATE TEMP TABLE sp8_holds AS
SELECT h.uid, h.k
FROM (
  SELECT up."userId" AS uid, up."permission" AS k
  FROM "user_permissions" up
  JOIN "users" u ON u."id" = up."userId"
  WHERE up."effect" = 'ALLOW' AND u."role" <> 'SUPER_ADMIN'
  UNION ALL
  SELECT ur.uid, rp."permission"
  FROM sp8_user_role ur
  JOIN "role_permissions" rp ON rp."roleId" = ur.rid
  WHERE NOT EXISTS (
    SELECT 1 FROM "user_permissions" a
    WHERE a."userId" = ur.uid AND a."permission" = rp."permission" AND a."effect" = 'ALLOW')
) h
WHERE h.k IN (SELECT src FROM sp8_gate)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" d
    WHERE d."userId" = h.uid AND d."permission" = h.k AND d."effect" = 'DENY');

-- WHO ALREADY HOLDS A BOX THIS FILE WOULD GIVE (none of the five exists before today: a guard): they passed that door through the
-- box itself, so they are not touched — a «منع» written on top of a working grant would take a door away. A personal row
-- of either kind settles the question for that key; else the role's row stands.
CREATE TEMP TABLE sp8_has AS
SELECT up."userId" AS uid, up."permission" AS k
FROM "user_permissions" up
WHERE up."effect" = 'ALLOW' AND up."permission" IN (SELECT new_key FROM sp8_gate)
UNION
SELECT ur.uid, rp."permission"
FROM sp8_user_role ur
JOIN "role_permissions" rp ON rp."roleId" = ur.rid
WHERE rp."permission" IN (SELECT new_key FROM sp8_gate)
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" o
    WHERE o."userId" = ur.uid AND o."permission" = rp."permission");

-- WHO PASSED EACH DOOR YESTERDAY: holds ANY key the door asked.
CREATE TEMP TABLE sp8_pass AS
SELECT DISTINCT h.uid, g.new_key
FROM sp8_holds h
JOIN sp8_gate g ON g.src = h.k;

-- WHICH ROLES WILL RECEIVE EACH BOX: those that hold any key the door asked today.
CREATE TEMP TABLE sp8_role_gets AS
SELECT DISTINCT rp."roleId" AS rid, g.new_key
FROM "role_permissions" rp
JOIN sp8_gate g ON g.src = rp."permission";

-- The same question of the baseline «إرجاع للافتراضي» restores.
CREATE TEMP TABLE sp8_default_gets AS
SELECT DISTINCT d."roleId" AS rid, g.new_key
FROM "role_permission_defaults" d
JOIN sp8_gate g ON g.src = d."permission";

-- 1. A «منع» is carried FIRST. A person whose role is about to receive a box but who did NOT pass that door yesterday
--    (every way in was refused to them) is refused the box: no door gained. Left alone: whoever already holds the box.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'op8-' || gen_random_uuid()::text, ur.uid, rg.new_key, 'DENY', NULL, NULL, now()
FROM sp8_user_role ur
JOIN sp8_role_gets rg ON rg.rid = ur.rid
WHERE NOT EXISTS (SELECT 1 FROM sp8_pass p WHERE p.uid = ur.uid AND p.new_key = rg.new_key)
  AND NOT EXISTS (SELECT 1 FROM sp8_has x WHERE x.uid = ur.uid AND x.k = rg.new_key)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 2. A person who passed through their own «سماح», and whose role does not receive the box, gets a «سماح» of their own:
--    no door lost.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'op8-' || gen_random_uuid()::text, p.uid, p.new_key, 'ALLOW', 'ALL_COMPANY', NULL, now()
FROM sp8_pass p
WHERE NOT EXISTS (
  SELECT 1 FROM sp8_user_role ur
  JOIN sp8_role_gets rg ON rg.rid = ur.rid AND rg.new_key = p.new_key
  WHERE ur.uid = p.uid)
  AND NOT EXISTS (SELECT 1 FROM sp8_has x WHERE x.uid = p.uid AND x.k = p.new_key)
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 3. Every role that held a source — company roles AND the system templates (companyId NULL) — receives the box.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'op8-' || gen_random_uuid()::text, rg.rid, rg.new_key, 'ALL_COMPANY', NULL
FROM sp8_role_gets rg
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 4. And the baseline «إرجاع للافتراضي» restores, or the first reset after this deploy would take the box away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'op8-' || gen_random_uuid()::text, dg.rid, dg.new_key, 'ALL_COMPANY', NULL
FROM sp8_default_gets dg
ON CONFLICT ("roleId", "permission") DO NOTHING;

DROP TABLE IF EXISTS pg_temp.sp8_user_role, pg_temp.sp8_gate, pg_temp.sp8_holds, pg_temp.sp8_has, pg_temp.sp8_pass, pg_temp.sp8_role_gets, pg_temp.sp8_default_gets;
