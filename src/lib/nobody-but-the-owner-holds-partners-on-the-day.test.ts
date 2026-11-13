import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUser } from '@/types/auth';
import { ROLE_PERMISSIONS, type UserRole } from '@/types/auth';
import { attachGrants, can } from './authorization';
import { computeEffectiveGrants } from './permissions-core';
import { PERMISSION_MODULES, catalogItem } from './permission-catalog';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الشركاء والسحوبات» (13/11) — WHO HOLDS `finance.partners` ON THE DAY, MEASURED WITH THE REAL ENGINE.
 *
 * The owner (SUPER_ADMIN, whose full access is every key) and nobody else: not a legacy role through the in-code fallback, not a role
 * template as the migrations left it, not the seed — and not a person who holds EVERY other finance key, the cash box, the expenses,
 * the closing and the wallets included. The partners' shares, their statement and their draws are the owner's business; he ticks the
 * key on the roles screen, which draws the catalog, for whoever he wants.
 * ═══════════════════════════════════════════════════════════════════════
 */

const KEY = 'finance.partners';

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

/** Every key of the finance module of the catalog, and the settlement and cost keys beside it — all of them but the one under test. */
const EVERY_OTHER_MONEY_KEY = [
  ...PERMISSION_MODULES.filter((m) => m.module === 'finance' || m.module === 'settlement').flatMap((m) => m.items.map((i) => i.key)),
  'costs.view',
].filter((k) => k !== KEY);

describe('who holds «الشركاء والسحوبات» on the day', () => {
  it('the catalog offers it on the roles screen, in Arabic, behind the finance view', () => {
    const item = catalogItem(KEY);
    expect(item?.requires).toBe('finance.view');
    expect(item?.ar).toBe('الشركاء والسحوبات');
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

  it('NEGATIVE: a role that holds EVERY other finance, settlement and cost key does not hold it', async () => {
    expect(EVERY_OTHER_MONEY_KEY.length, 'the sweep found the finance keys').toBeGreaterThan(8);
    expect(EVERY_OTHER_MONEY_KEY).toContain('finance.cashbox');
    expect(EVERY_OTHER_MONEY_KEY).toContain('finance.create');
    const accountant = await person(EVERY_OTHER_MONEY_KEY);
    expect(can(accountant, 'finance.view')).toBe(true);
    expect(can(accountant, 'finance.cashbox')).toBe(true);
    expect(can(accountant, 'finance.update')).toBe(true);
    expect(can(accountant, KEY)).toBe(false);
  });

  it('a role the owner ticked holds it — and a «منع» on it beats the role', async () => {
    expect(can(await person(['finance.view', KEY]), KEY)).toBe(true);
    expect(can(await person(['finance.view', KEY], [KEY]), KEY)).toBe(false);
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
