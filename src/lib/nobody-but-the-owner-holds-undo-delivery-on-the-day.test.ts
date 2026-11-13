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
 * «هاد الطلب بالغلط حطيتو تم والشركة بتقول تم ارجاعها لازم يكون في زر تراجع مش محدود بمدة زمنية ويكون عليه صلاحية للمالك متاح» (13/11) —
 * WHO HOLDS `ops.undo_delivery` ON THE DAY, MEASURED WITH THE REAL ENGINE.
 *
 * The owner (SUPER_ADMIN, whose full access is every key) and nobody else: not a legacy role through the in-code fallback, not a role
 * template as the migrations left it, not the seed — not even the people who record a delivery, collect the courier's money, close lost
 * parcels or press «أقفل القديمة». He ticks it for whoever he wants on the roles screen, which draws the catalog, behind the tracking key.
 * ═══════════════════════════════════════════════════════════════════════
 */

const KEY = 'ops.undo_delivery';

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

describe('who holds «تراجع عن التسليم» on the day', () => {
  it('the catalog offers it on the roles screen, in Arabic, behind the tracking key — and says there is no time limit', () => {
    const item = catalogItem(KEY);
    expect(item?.requires).toBe('ops.track');
    expect(item?.ar).toBe('التراجع عن تسجيل تسليم بالغلط (بلا مدة زمنية)');
    expect(item?.en).toBe('Take back a delivery that was recorded by mistake');
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

  it('NEGATIVE: a role that follows parcels, records the delivery, collects the courier’s money, closes lost ones and presses the owner’s other button does not hold it', async () => {
    const desk = await person([
      'ops.track', 'ops.deliver', 'ops.transfer', 'ops.write_off', 'ops.close_legacy', 'ops.returns', 'ops.returns_receive_all',
      'finance.cashbox', 'finance.cashbox_view', 'settlement.view', 'settlement.approve', 'orders.unlock', 'orders.change_status',
    ]);
    expect(can(desk, 'ops.deliver')).toBe(true);
    expect(can(desk, 'ops.close_legacy')).toBe(true);
    expect(can(desk, 'orders.unlock')).toBe(true);
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
