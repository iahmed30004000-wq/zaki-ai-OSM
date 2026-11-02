-- THE HOLDER'S OWN WINDOW GETS ITS KEY: «تعديل وتأجيل وإلغاء طلب مؤكَّد قبل دخوله دفعة شحن» (orders.edit_confirmed).
-- The owner, 2/11: «بدنا نسرع شغل البنات. بدي التعديل التأجيل أو الالغاء ....الخ أضيفهم كصلاحية انو يقدرو يعدلو ع الطلب لغاية
-- مرحلة الشحنة. مجرد ما الشحنة اتوزعت ع شركة شحن ودخلت باتش ما بقدرو يعدلو، بصير يقدمو طلب تعديل. حلها بدون تعارض او مشاكل.»
--
-- WHAT THE KEY DOES (src/lib/edit-confirmed-window.ts): the agent who HOLDS a confirmed order and holds this key edits,
-- postpones or cancels it herself, at once, for as long as the order is on no shipping trolley and the courier has not taken
-- it. Without it — or on a colleague's order, or once the order is in a batch — she raises a change request somebody else
-- decides, exactly as before.
--
-- WHO RECEIVES IT ON THE DAY: every role that holds BOTH confirmation.work AND orders.request_change (EDIT_CONFIRMED_NEEDS in
-- src/lib/edit-confirmed-key.ts — a test compares). That is the confirmation agents, the supervisors and the follow-up role,
-- and nobody else: this is a power that did not exist, so the rule is «who can already hold an order and raise a request»,
-- not «who passed a door yesterday». SUPER_ADMIN holds every key already and gets no row.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE:
--   · It does NOT give the key to a person whose role lacks one of the two keys, even if a personal «سماح» gives her both.
--     «Nobody else» is the rule; the owner ticks the box for her himself if he means it (scripts/permission-predeploy-report.sql
--     lists exactly those people).
--   · It does NOT give it to a person the owner REFUSED one of the two keys: a personal «منع» on either key is carried to the
--     box (a «منع» on the new key itself), so no one gains it by being in a role that receives it. Every question is asked of a
--     snapshot taken BEFORE the first row is written (the ec_* temp tables below), and the «منع» goes in first.
--   · It does NOT read a key it wrote: the new key is not one of the two it asks for.
--
-- Additive only: INSERT … ON CONFLICT DO NOTHING into the three grant tables; no row is changed or removed. The ec_* tables
-- are TEMPORARY (they die with the session) and are dropped at the end. Every row written has an id starting with 'edc-',
-- which is how rollback.sql finds them and nothing else. Running it twice changes nothing.
--
-- NO BEGIN / COMMIT HERE ON PURPOSE: whoever rehearses this file inside their own transaction and rolls it back must
-- really roll it back.
--
-- ORDER MATTERS: snapshot → «منع» → roles → baselines.

DROP TABLE IF EXISTS pg_temp.ec_need, pg_temp.ec_user_role, pg_temp.ec_role_gets, pg_temp.ec_default_gets;

-- The two keys a role must hold together (EDIT_CONFIRMED_NEEDS in src/lib/edit-confirmed-key.ts — a test compares).
CREATE TEMP TABLE ec_need AS
SELECT * FROM (VALUES
  ('confirmation.work'),
  ('orders.request_change')
) AS n (k);

-- Which role each person's grants come from — the way permissions-core reads it: their roleId, or, with none,
-- the system template named like their role. SUPER_ADMIN passes everything anyway.
CREATE TEMP TABLE ec_user_role AS
SELECT u."id" AS uid, r."id" AS rid
FROM "users" u
JOIN "roles" r
  ON (u."roleId" IS NOT NULL AND r."id" = u."roleId")
  OR (u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")
WHERE u."role" <> 'SUPER_ADMIN';

-- WHICH ROLES WILL RECEIVE THE BOX: those that hold BOTH keys today — company roles AND the system templates (companyId NULL).
CREATE TEMP TABLE ec_role_gets AS
SELECT rp."roleId" AS rid
FROM "role_permissions" rp
JOIN ec_need n ON n.k = rp."permission"
GROUP BY rp."roleId"
HAVING COUNT(DISTINCT rp."permission") = (SELECT COUNT(*) FROM ec_need);

-- The same question of the baseline «إرجاع للافتراضي» restores.
CREATE TEMP TABLE ec_default_gets AS
SELECT d."roleId" AS rid
FROM "role_permission_defaults" d
JOIN ec_need n ON n.k = d."permission"
GROUP BY d."roleId"
HAVING COUNT(DISTINCT d."permission") = (SELECT COUNT(*) FROM ec_need);

-- 1. A «منع» is carried FIRST. A person whose role is about to receive the box but who is refused one of the two keys
--    (a personal «منع» on either) is refused the box: no one gains it.
INSERT INTO "user_permissions" ("id", "userId", "permission", "effect", "scope", "scopeIds", "updatedAt")
SELECT 'edc-' || gen_random_uuid()::text, ur.uid, 'orders.edit_confirmed', 'DENY', NULL, NULL, now()
FROM ec_user_role ur
JOIN ec_role_gets rg ON rg.rid = ur.rid
WHERE EXISTS (
  SELECT 1 FROM "user_permissions" d
  WHERE d."userId" = ur.uid AND d."effect" = 'DENY' AND d."permission" IN (SELECT k FROM ec_need))
ON CONFLICT ("userId", "permission") DO NOTHING;

-- 2. Every role that holds both keys — company roles AND the system templates — receives the box.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'edc-' || gen_random_uuid()::text, rg.rid, 'orders.edit_confirmed', 'ALL_COMPANY', NULL
FROM ec_role_gets rg
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 3. And the baseline «إرجاع للافتراضي» restores, or the first reset after this deploy would take the box away again.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope", "scopeIds")
SELECT 'edc-' || gen_random_uuid()::text, dg.rid, 'orders.edit_confirmed', 'ALL_COMPANY', NULL
FROM ec_default_gets dg
ON CONFLICT ("roleId", "permission") DO NOTHING;

DROP TABLE IF EXISTS pg_temp.ec_need, pg_temp.ec_user_role, pg_temp.ec_role_gets, pg_temp.ec_default_gets;
