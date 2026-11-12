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
 * «سوّيها تم تحصيلها بدون ما تأثر على المالية» (12/11) — WHO HOLDS `ops.close_legacy` ON THE DAY, MEASURED WITH THE REAL ENGINE.
 *
 * The owner (SUPER_ADMIN, whose full access is every key) and nobody else: not a legacy role through the in-code fallback, not a
 * role template as the migrations left it, not the seed — not even the people who collect the courier's money or close lost
 * parcels. He ticks it for whoever he wants on the roles screen, which draws the catalog, behind the tracking key.
 * ═══════════════════════════════════════════════════════════════════════
 */

const KEY = 'ops.close_legacy';

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

describe('who holds «أقفل القديمة بلا باركود» on the day', () => {
  it('the catalog offers it on the roles screen, in Arabic, behind the tracking key', () => {
    const item = catalogItem(KEY);
    expect(item?.requires).toBe('ops.track');
    expect(item?.ar).toBe('إقفال الطلبات القديمة بلا باركود كمحصَّلة بلا حركة مال');
  });

  it('SUPER_ADMIN holds it — its full access is every key', async () => {
    expect(can(await person([], [], 'SUPER_ADMIN'), KEY)).toBe(true);
  });

  it('NEGATIVE: no legacy role holds it through the in-code fallback', async () => {
    const holders: string[] = [];
    for (const role of Object.keys(ROLE_PERMISSIONS) as UserRole[]) {
      if (role === 'SUPER_ADMIN') continue;
      const base = { id: 'u-' + role, role, roleId: null, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
      const u = attachGrants(base, await computeEffectiveGrants(base as never, { roleRows: async () => [], overrideRows: async () => [] }));
      if (can(u, KEY)) holders.push(role);
    }
    expect(holders).toEqual([]);
  });

  it('NEGATIVE: a role that follows parcels, collects the courier’s money and closes lost ones does not hold it', async () => {
    const desk = await person(['ops.track', 'ops.deliver', 'ops.transfer', 'ops.write_off', 'finance.cashbox', 'finance.cashbox_view', 'settlement.view', 'settlement.approve']);
    expect(can(desk, 'finance.cashbox')).toBe(true);
    expect(can(desk, 'ops.write_off')).toBe(true);
    expect(can(desk, KEY)).toBe(false);
  });

  it('a role the owner ticked holds it — and a «منع» on it beats the role', async () => {
    expect(can(await person(['ops.track', KEY]), KEY)).toBe(true);
    expect(can(await person(['ops.track', KEY], [KEY]), KEY)).toBe(false);
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
