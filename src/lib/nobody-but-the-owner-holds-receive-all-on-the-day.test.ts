import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUser } from '@/types/auth';
import { ROLE_PERMISSIONS, type UserRole } from '@/types/auth';
import { attachGrants, can } from './authorization';
import { computeEffectiveGrants } from './permissions-core';
import { catalogItem } from './permission-catalog';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «بدي زر استلام الكل مع صلاحية للمالك» (11/11) — WHO HOLDS `ops.returns_receive_all` ON THE DAY, MEASURED WITH THE REAL ENGINE.
 *
 * The owner (SUPER_ADMIN, whose full access is every key) and nobody else: not a legacy role through the in-code
 * fallback, not a role template as the migrations left it, not the seed. He ticks it for whoever he wants on the roles
 * screen, which draws the catalog — so it is there by itself, behind the returns key.
 * ═══════════════════════════════════════════════════════════════════════
 */

const KEY = 'ops.returns_receive_all';

async function person(roleKeys: string[], deny: string[] = [], role = 'CUSTOM'): Promise<SessionUser> {
  const base = { id: 'u1', email: 'u@x', name: 'سارة', role, roleId: 'r1', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => roleKeys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => deny.map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
    })
  );
}

describe('who holds «استلام الكل» on the day', () => {
  it('the catalog offers it on the roles screen, in Arabic, behind the returns key', () => {
    const item = catalogItem(KEY);
    expect(item?.requires).toBe('ops.returns');
    expect(item?.ar).toBe('استلام كل المرتجعات دفعة واحدة');
  });

  it('SUPER_ADMIN holds it — its full access is every key', async () => {
    expect(can(await person([], [], 'SUPER_ADMIN'), KEY)).toBe(true);
  });

  it('NEGATIVE: no legacy role holds it through the in-code fallback — not even the ones that receive returns', async () => {
    const holders: string[] = [];
    for (const role of Object.keys(ROLE_PERMISSIONS) as UserRole[]) {
      if (role === 'SUPER_ADMIN') continue;
      const base = { id: 'u-' + role, role, roleId: null, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
      const u = attachGrants(base, await computeEffectiveGrants(base as never, { roleRows: async () => [], overrideRows: async () => [] }));
      if (can(u, KEY)) holders.push(role);
    }
    expect(holders).toEqual([]);
  });

  it('NEGATIVE: a role holding the returns desk and its fee box does not hold it', async () => {
    const desk = await person(['ops.returns', 'ops.return_fee', 'ops.track']);
    expect(can(desk, 'ops.returns')).toBe(true);
    expect(can(desk, KEY)).toBe(false);
  });

  it('a role the owner ticked holds it — and a «منع» on it beats the role', async () => {
    expect(can(await person(['ops.returns', KEY]), KEY)).toBe(true);
    expect(can(await person(['ops.returns', KEY], [KEY]), KEY)).toBe(false);
  });

  it('NEGATIVE: nothing in the migrations, the seed or the engine names the key', () => {
    const root = process.cwd();
    const dir = join(root, 'prisma', 'migrations');
    const named: string[] = [];
    for (const m of readdirSync(dir)) {
      for (const f of ['migration.sql', 'rollback.sql']) {
        const p = join(dir, m, f);
        if (existsSync(p) && readFileSync(p, 'utf8').includes(KEY)) named.push(`${m}/${f}`);
      }
    }
    for (const f of ['prisma/seed.ts', 'src/lib/permissions-core.ts', 'src/types/auth.ts', 'src/lib/permission-aliases.ts', 'src/lib/ops-action-keys.ts']) {
      if (existsSync(join(root, f)) && readFileSync(join(root, f), 'utf8').includes(KEY)) named.push(f);
    }
    expect(named).toEqual([]);
  });
});
