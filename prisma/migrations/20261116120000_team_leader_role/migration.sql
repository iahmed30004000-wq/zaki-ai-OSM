-- THE TEAM LEADER ROLE (Confirmation Center v2, step H1): a system role `TEAM_LEADER`.
--
-- THE SPEC: «TEAM_LEADER = CONFIRMATION_SUPERVISOR minus orders.change_price and campaigns.manage. Can: queue, follow-up, issues, reassign, winback, team.monitor, reports.»
--
-- HOW: the grants are COPIED from the LIVE supervisor system template (companyId IS NULL, name 'CONFIRMATION_SUPERVISOR') at the moment this file runs, minus the two keys it
-- must not have — never a hard-coded list: the owner can edit a template on the roles screen, and a list written here would silently disagree with what he did. The role gets
-- `team.monitor` explicitly: the supervisor does not hold it (it comes from users.view or the names COMPANY_ADMIN / MANAGER), and it is what opens the team table, the
-- performance board and the no-answer tab for her.
--
-- THE RULE: NOBODY LOSES A DOOR AND NOBODY GAINS ONE ON THE DAY. This file creates a role nobody holds yet; it changes no existing role, user, grant or setting. A person is
-- given the role only by the owner (PATCH /api/users/[id] action=assignRole) — a COMPANY_ADMIN cannot confer it (`canConferRole`: she would have to hold it).
--
-- Additive only: one INSERT of the role row (guarded by NOT EXISTS), INSERT … ON CONFLICT DO NOTHING into the two grant tables. Every grant row written has an id starting with
-- 'th12-', which is how rollback.sql finds them and nothing else. The «إرجاع للافتراضي» baseline (role_permission_defaults) gets the same rows, so that button does not undo this.
--
-- NO BEGIN / COMMIT HERE ON PURPOSE: whoever rehearses this file inside their own transaction and rolls it back must really roll it back.

INSERT INTO "roles" ("id", "companyId", "name", "isSystem", "updatedAt")
SELECT gen_random_uuid(), NULL, 'TEAM_LEADER', true, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r."companyId" IS NULL AND r.name = 'TEAM_LEADER');

-- Grants: the live supervisor template, minus the two keys the spec takes away.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope")
SELECT 'th12-' || gen_random_uuid(), t.id, sp."permission", sp."scope"
FROM "role_permissions" sp
JOIN "roles" s ON s.id = sp."roleId" AND s."companyId" IS NULL AND s.name = 'CONFIRMATION_SUPERVISOR'
JOIN "roles" t ON t."companyId" IS NULL AND t.name = 'TEAM_LEADER'
WHERE sp."permission" NOT IN ('orders.change_price', 'campaigns.manage')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- The key the supervisor does not hold and she needs: the team table, the performance board, the no-answer tab, the scorecard.
INSERT INTO "role_permissions" ("id", "roleId", "permission", "scope")
SELECT 'th12-' || gen_random_uuid(), t.id, 'team.monitor', 'ALL_COMPANY'
FROM "roles" t WHERE t."companyId" IS NULL AND t.name = 'TEAM_LEADER'
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- The same rows are her «إرجاع للافتراضي» baseline.
INSERT INTO "role_permission_defaults" ("id", "roleId", "permission", "scope")
SELECT 'th12-' || gen_random_uuid(), rp."roleId", rp."permission", rp."scope"
FROM "role_permissions" rp
JOIN "roles" t ON t.id = rp."roleId" AND t."companyId" IS NULL AND t.name = 'TEAM_LEADER'
ON CONFLICT ("roleId", "permission") DO NOTHING;
