import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * «الإعدادات الحسّاسة» IS ITS OWN BOX — THE OWNER'S RULING, 27/10 (RV149).
 *
 * `LEGACY_ALIAS` sent every settings.manage check to settings.edit as well:
 * whoever could edit the general settings also read and changed the courier
 * credentials, the ad-account tokens and the AI provider's key — and a «منع»
 * on «الإعدادات الحسّاسة» did nothing. The alias is gone; the migration
 * 20261027000000_sensitive_settings_own_key gave settings.manage to every
 * role and person who held settings.edit, so nobody lost a door on the day.
 *
 * ⚠️ There is no database in CI, so the migration is read here as text. It
 * was also RUN, against the local database inside a transaction that was
 * rolled back, over twelve fixture people (role only, «منع», «سماح», no
 * roleId, a template, SUPER_ADMIN) — before and after compared; that
 * measurement is in the pull request and is the stronger evidence.
 */

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { userCan } from './can';
import { attachGrants, can, getPermissionScope } from './authorization';
import { ALL_CATALOG_KEYS } from './permission-catalog';
import { LEGACY_ALIAS } from './permission-aliases';
import { computeEffectiveGrants, legacyEffectiveKeys, type GrantSource } from './permissions-core';
import type { SessionUser } from '@/types/auth';

const person = (keys: string[]): SessionUser =>
  ({ id: 'u1', name: 'x', email: 'x@x', role: 'MANAGER', status: 'ACTIVE', companyId: 'c1', permissions: keys }) as unknown as SessionUser;

const onServer = (keys: string[]) =>
  attachGrants(person(keys), {
    fullAccess: false,
    grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])),
  } as never);

describe('the server and the screen', () => {
  it('NEGATIVE: «تعديل إعدادات النظام» alone no longer opens the sensitive doors', () => {
    expect(can(onServer(['settings.view', 'settings.edit']), 'settings.manage')).toBe(false);
    expect(getPermissionScope(onServer(['settings.view', 'settings.edit']), 'settings.manage')).toBeNull();
    expect(userCan(person(['settings.view', 'settings.edit']), 'settings.manage')).toBe(false);
  });

  it('and still opens its own doors', () => {
    expect(can(onServer(['settings.edit']), 'settings.edit')).toBe(true);
    expect(userCan(person(['settings.edit']), 'settings.edit')).toBe(true);
  });

  it('the sensitive box opens the sensitive doors, and nothing of the general ones', () => {
    expect(can(onServer(['settings.manage']), 'settings.manage')).toBe(true);
    expect(userCan(person(['settings.manage']), 'settings.manage')).toBe(true);
    expect(can(onServer(['settings.manage']), 'settings.edit')).toBe(false);
  });

  it('NEGATIVE: a «منع» on the sensitive box counts — through the real engine, role holding both', async () => {
    // The role as the migration leaves it, and the owner's «منع» on the sensitive box.
    const source: GrantSource = {
      roleRows: async () => [
        { permission: 'settings.edit', scope: 'ALL_COMPANY', scopeIds: null },
        { permission: 'settings.manage', scope: 'ALL_COMPANY', scopeIds: null },
      ],
      overrideRows: async () => [{ permission: 'settings.manage', effect: 'DENY', scope: null, scopeIds: null }],
    };
    const g = await computeEffectiveGrants({ id: 'u1', role: 'MANAGER', roleId: 'r1' } as never, source);
    const user = attachGrants(person(Object.keys(g.grants)), g);
    expect(can(user, 'settings.manage')).toBe(false);
    expect(userCan(person(Object.keys(g.grants)), 'settings.manage')).toBe(false);
    // and «تعديل» is still theirs
    expect(can(user, 'settings.edit')).toBe(true);
  });

  it('the second alias went too (29/10): «reports.view» no longer opens a check of «analytics.view»', () => {
    expect(LEGACY_ALIAS['analytics.view']).toBeUndefined();
    expect(can(onServer(['reports.view']), 'analytics.view')).toBe(false);
  });

  it('no real box stands on the left of the alias table at all — a box that lies', () => {
    const realBoxesAliased = Object.keys(LEGACY_ALIAS).filter((k) => ALL_CATALOG_KEYS.has(k));
    expect(realBoxesAliased).toEqual([]);
  });
});

describe('the legacy role table', () => {
  it('reads the old settings.manage as both boxes — what a role named in the old way could do', () => {
    const admin = legacyEffectiveKeys('COMPANY_ADMIN');
    expect(admin).toContain('settings.edit');
    expect(admin).toContain('settings.manage');
  });
});

const DIR = path.join(process.cwd(), 'prisma', 'migrations', '20261027000000_sensitive_settings_own_key');
const sql = readFileSync(path.join(DIR, 'migration.sql'), 'utf8');
/** The statements, comments dropped. */
const statements = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean);

describe('the migration: nobody loses a door, nobody gains one', () => {
  it('only adds rows — nothing is changed, removed or altered', () => {
    for (const s of statements) {
      expect(s.startsWith('INSERT INTO'), s.slice(0, 60)).toBe(true);
      expect(s).not.toMatch(/\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b/i);
      expect(s, 'every row it adds steps aside for one already there').toMatch(/ON CONFLICT \("(roleId|userId)", "permission"\) DO NOTHING$/);
      expect(s, 'the rows are tagged, so the rollback finds them and nothing else').toContain(`'rv149-' || gen_random_uuid()::text`);
    }
  });

  it('writes the key in all three places a grant lives — the role, its baseline, and the person', () => {
    const into = statements.map((s) => s.match(/^INSERT INTO "(\w+)"/)?.[1]);
    expect(into).toContain('role_permissions');
    expect(into).toContain('role_permission_defaults');
    expect(into.filter((t) => t === 'user_permissions')).toHaveLength(2);
    for (const s of statements) {
      expect(s).toContain(`'settings.manage'`);
      expect(s, 'granted FROM settings.edit — the box whose holders passed yesterday').toContain(`"permission" = 'settings.edit'`);
    }
  });

  it('carries a «منع» on settings.edit BEFORE the roles receive the key', () => {
    const deny = statements.findIndex((s) => s.includes(`'DENY'`) && s.startsWith('INSERT INTO "user_permissions"'));
    const roles = statements.findIndex((s) => s.startsWith('INSERT INTO "role_permissions"'));
    expect(deny).toBeGreaterThanOrEqual(0);
    // After, the «did the role already hold it» test would see the row just added, and a person
    // denied «تعديل» today would GAIN the sensitive doors (the harness showed exactly that).
    expect(deny).toBeLessThan(roles);
    const s = statements[deny];
    // The two sub-questions, each on its own: «does the role hold settings.edit» and «did it already hold settings.manage».
    const [, holdsEdit, alreadyManage] = s.split(/AND (?:NOT )?EXISTS \(/);
    expect(s.indexOf('AND EXISTS ('), 'the EXISTS comes first').toBeLessThan(s.indexOf('AND NOT EXISTS ('));
    expect(holdsEdit, 'only where the role is about to receive it').toContain(`rp."permission" = 'settings.edit'`);
    expect(alreadyManage, 'and did not already hold it — that person passed yesterday').toContain(`rp."permission" = 'settings.manage'`);
    // Both read the role the way the engine reads it: the roleId, else the system template named like the role.
    for (const sub of [holdsEdit, alreadyManage]) {
      expect(sub).toContain(`(u."roleId" IS NOT NULL AND r."id" = u."roleId")`);
      expect(sub).toContain(`(u."roleId" IS NULL AND r."companyId" IS NULL AND r."name" = u."role")`);
    }
  });

  it('writes nothing for SUPER_ADMIN, who passes everything anyway', () => {
    for (const s of statements.filter((x) => x.startsWith('INSERT INTO "user_permissions"'))) {
      expect(s).toContain(`u."role" <> 'SUPER_ADMIN'`);
    }
  });

  it('the person’s «سماح» carries its scope; the role row carries the role’s', () => {
    const allow = statements.find((s) => s.includes(`'ALLOW'`))!;
    expect(allow).toContain('a."scope", a."scopeIds"');
    const role = statements.find((s) => s.startsWith('INSERT INTO "role_permissions"'))!;
    expect(role).toContain('rp."scope", rp."scopeIds"');
  });

  it('its rollback removes only what it wrote', () => {
    const rollback = readFileSync(path.join(DIR, 'rollback.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    const deletes = rollback.match(/DELETE FROM "\w+"\s+WHERE[^;]+;/g) ?? [];
    expect(deletes).toHaveLength(4);
    for (const d of deletes.slice(0, 3)) expect(d).toContain(`"id" LIKE 'rv149-%'`);
    expect(deletes[3]).toContain(`'20261027000000_sensitive_settings_own_key'`);
  });
});
