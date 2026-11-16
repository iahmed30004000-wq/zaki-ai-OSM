import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ASSIGNABLE_ROLES, ROLE_LABELS, ROLE_PERMISSIONS } from '@/types/auth';
import { isReservedRoleName } from './role-names';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE TEAM LEADER IS THE SUPERVISOR MINUS TWO KEYS (step H1)
 *
 *  1. TEAM_LEADER is a role of the code (type, assignable, labelled in Arabic, empty fallback like the supervisor's — grants live in the DB template) and a RESERVED name.
 *  2. The migration copies the grants from the LIVE supervisor template (never a typed list), takes away exactly `orders.change_price` and `campaigns.manage`, adds `team.monitor`,
 *     writes the «إرجاع للافتراضي» baseline too, and is additive: no UPDATE, no DELETE, no DROP, no ALTER.
 *  3. Nobody loses a door and nobody gains one on the day: the migration creates a role nobody holds and changes no existing role, user or setting.
 *  4. The rollback removes only the rows the migration wrote (their id prefix) and the role only when nobody holds it.
 *  5. The role is conferred by the owner only: nothing in this change widens who may hand it out.
 *
 * The rows themselves are checked on a real PostgreSQL by `scripts/verify-on-postgres/team-leader-role.mjs --assert` (in CI).
 * ═════════════════════════════════════════════════════════════════
 */

const DIR = 'prisma/migrations/20261116120000_team_leader_role';
const code = (file: string) =>
  readFileSync(`${DIR}/${file}`, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
const up = code('migration.sql');
const down = code('rollback.sql');

describe('the role in the code', () => {
  it('is a role, assignable, labelled in Arabic, with an empty fallback like the supervisor\'s', () => {
    expect(ASSIGNABLE_ROLES).toContain('TEAM_LEADER');
    expect(ROLE_LABELS.TEAM_LEADER.ar).toBe('قائد الفريق');
    expect(ROLE_PERMISSIONS.TEAM_LEADER).toEqual([]);
    expect(ROLE_PERMISSIONS.CONFIRMATION_SUPERVISOR).toEqual([]);
  });

  it('is a reserved name: a company cannot make a role of its own that shadows the system template', () => {
    expect(isReservedRoleName('TEAM_LEADER')).toBe(true);
    expect(isReservedRoleName('team_leader')).toBe(true);
  });

  it('is offered right after the supervisor, so the owner finds the two together', () => {
    const i = ASSIGNABLE_ROLES.indexOf('CONFIRMATION_SUPERVISOR');
    expect(ASSIGNABLE_ROLES[i + 1]).toBe('TEAM_LEADER');
  });
});

describe('the migration', () => {
  it('copies the grants from the live supervisor template instead of typing a list', () => {
    expect(up).toMatch(/FROM "role_permissions" sp/);
    expect(up).toMatch(/s\.name = 'CONFIRMATION_SUPERVISOR'/);
    expect(up).not.toMatch(/VALUES\s*\(/i);
  });

  it('takes away exactly orders.change_price and campaigns.manage, and adds team.monitor', () => {
    expect(up).toMatch(/NOT IN \('orders\.change_price', 'campaigns\.manage'\)/);
    expect(up).toContain("'team.monitor'");
    for (const other of ['orders.edit', 'confirmation.winback', 'confirmation.reassign', 'reports.view', 'campaigns.view']) expect(up, other).not.toContain(`'${other}'`);
  });

  it('writes both places a grant lives, so «إرجاع للافتراضي» does not undo it', () => {
    expect(up).toContain('INSERT INTO "role_permissions"');
    expect(up).toContain('INSERT INTO "role_permission_defaults"');
  });

  it('is idempotent: every insert is guarded', () => {
    const inserts = up.split(/;\s*\n/).filter((s) => s.includes('INSERT INTO'));
    expect(inserts.length).toBe(4);
    for (const s of inserts) expect(s, s.slice(0, 60)).toMatch(/ON CONFLICT \("roleId", "permission"\) DO NOTHING|WHERE NOT EXISTS/);
  });

  it('is additive: no UPDATE, no DELETE, no DROP, no ALTER, no TRUNCATE', () => {
    expect(up).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  });

  it('creates a system template (companyId NULL) and touches no existing role, user or setting', () => {
    expect(up).toMatch(/INSERT INTO "roles"[\s\S]*NULL, 'TEAM_LEADER', true/);
    expect(up).not.toMatch(/"users"|"user_permissions"|"companies"/);
  });

  it('marks every grant row it writes with the th12- prefix, which is how the rollback finds them', () => {
    expect((up.match(/'th12-' \|\| gen_random_uuid\(\)/g) ?? []).length).toBe(3);
  });
});

describe('the rollback', () => {
  it('removes only the rows the migration wrote and the role only when nobody holds it', () => {
    expect(down).toContain(`"id" LIKE 'th12-%'`);
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "users" u WHERE u\."roleId" = r\.id OR u\."role" = 'TEAM_LEADER'\)/);
    expect(down).toContain('DELETE FROM "_prisma_migrations"');
    expect(down).not.toMatch(/DROP|TRUNCATE/i);
  });
});

describe('who may confer it', () => {
  it('nothing in this change touches conferral: it stays the owner\'s (canConferRole asks the granter to hold the role)', () => {
    const src = readFileSync('src/lib/user-permissions.ts', 'utf8');
    expect(src).not.toContain('TEAM_LEADER');
  });
});
