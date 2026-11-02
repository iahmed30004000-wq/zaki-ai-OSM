import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «ماسكه» ON «الطلبات» — WHO HOLDS IT NOW, AND IT ONLY EVER NARROWS.
 *
 * The owner, 2/11, wanted to see the girls' work; «ماسكه» (`holderId` → `claimedById`)
 * is the list half of it. It is a filter of the shared builder (`ordersWhere`), so
 * the list, the CSV and the arrows read it alike, and the person's own envelope is
 * ANDed over it by `applyQueueFilter` exactly as over every other filter. The
 * envelope (`orderVisibilityWhere` / `orderListWhere`) is not touched.
 *
 * The REAL builder, the REAL `applyQueueFilter` and the REAL engine (persons built
 * the way a session is); the where they produce is run against a small table, so a
 * filter that widened would bring back a row it must not.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>;

const { db, state } = vi.hoisted(() => ({
  state: { user: null as unknown as SessionUser },
  db: {
    order: { groupBy: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: state.user, companyId: 'c1', storeId: 's1', countryId: 'co1' }),
}));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { applyQueueFilter } from '@/lib/rbac';
import { ORDER_FILTER_PARAMS, ordersWhere } from '@/lib/order-filters';
import { GET as holdersDoor } from './route';

async function person(id: string, keys: string[], scope = 'ALL_COMPANY'): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role: 'CONFIRMATION_AGENT', roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: k === 'orders.view' ? scope : 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

/* ── a where, run against rows: the operators these envelopes use, and a loud failure on any other ── */
function holds(value: unknown, filter: unknown): boolean {
  if (filter === null) return value === null || value === undefined;
  if (typeof filter !== 'object' || filter instanceof Date) return (value ?? null) === filter;
  return Object.entries(filter as Row).every(([op, arg]) => {
    switch (op) {
      case 'not':
        return !holds(value, arg);
      case 'in':
        return (arg as unknown[]).includes(value);
      case 'gt':
        return value != null && +(value as number) > +(arg as number);
      case 'lte':
        return value != null && +(value as number) <= +(arg as number);
      case 'is':
        return value != null && matches(value as Row, arg);
      case 'none':
        return !((value as Row[] | undefined) ?? []).length;
      default:
        throw new Error(`the matcher does not know «${op}»`);
    }
  });
}
function matches(row: Row, where: unknown): boolean {
  return Object.entries((where ?? {}) as Row).every(([key, value]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((w) => matches(row, w));
    if (key === 'OR') return (value as unknown[]).some((w) => matches(row, w));
    return holds(row[key], value);
  });
}

const ROWS: Row[] = [
  // Sara holds two; one of them Abeer typed.
  { id: 'SARA-1', companyId: 'c1', storeId: 's1', claimedById: 'sara', createdById: 'mod-1', confirmationStatus: 'IN_PROGRESS' },
  { id: 'SARA-TYPED-BY-ABEER', companyId: 'c1', storeId: 's1', claimedById: 'sara', createdById: 'abeer', confirmationStatus: 'IN_PROGRESS' },
  { id: 'ABEER-1', companyId: 'c1', storeId: 's1', claimedById: 'abeer', createdById: 'mod-1', confirmationStatus: 'IN_PROGRESS' },
  { id: 'NOBODY-1', companyId: 'c1', storeId: 's1', claimedById: null, createdById: 'mod-1', confirmationStatus: 'NEW' },
  { id: 'SARA-OTHER-STORE', companyId: 'c1', storeId: 's2', claimedById: 'sara', createdById: 'mod-1', confirmationStatus: 'IN_PROGRESS' },
];

/** What `GET /api/orders` builds: the tenant and the builder's where, then the envelope over it. */
function listed(user: SessionUser, query: string, queue: string | null = null): string[] {
  const built = ordersWhere(new URLSearchParams(query));
  if (!built.ok) throw new Error(built.error);
  const where = applyQueueFilter(user, { companyId: 'c1', storeId: 's1', ...built.where }, queue);
  return ROWS.filter((r) => matches(r, where)).map((r) => r.id as string).sort();
}

describe('the builder', () => {
  it('reads `holderId` into the AND list — never a top-level key a queue could overwrite', () => {
    const built = ordersWhere(new URLSearchParams('holderId=sara'));
    expect(built).toEqual({ ok: true, where: { AND: [{ claimedById: 'sara' }] } });
    expect(ordersWhere(new URLSearchParams('holderId=none'))).toEqual({ ok: true, where: { AND: [{ claimedById: null }] } });
  });

  it('«all» and empty are no filter, as for every other filter', () => {
    expect(ordersWhere(new URLSearchParams('holderId=all'))).toEqual({ ok: true, where: {} });
    expect(ordersWhere(new URLSearchParams('holderId='))).toEqual({ ok: true, where: {} });
  });

  it('and the export forwards it, so the CSV is the list on screen', () => {
    expect(ORDER_FILTER_PARAMS).toContain('holderId');
  });
});

describe('a person who sees every order', () => {
  it('«ماسكه: سارة» is exactly Sara’s orders of this store', async () => {
    const owner = await person('owner', ['orders.view']);
    expect(listed(owner, 'holderId=sara')).toEqual(['SARA-1', 'SARA-TYPED-BY-ABEER']);
  });

  it('«ما حدا ماسكه» is the unheld ones', async () => {
    const owner = await person('owner', ['orders.view']);
    expect(listed(owner, 'holderId=none')).toEqual(['NOBODY-1']);
  });

  it('no filter is the whole store, as before', async () => {
    const owner = await person('owner', ['orders.view']);
    expect(listed(owner, '')).toEqual(['ABEER-1', 'NOBODY-1', 'SARA-1', 'SARA-TYPED-BY-ABEER']);
  });

  it('with the «my_orders» queue it narrows with it instead of being overwritten by it', async () => {
    const owner = await person('owner', ['orders.view']);
    expect(listed(owner, 'holderId=sara', 'my_orders')).toEqual([]);
  });
});

describe('NEGATIVE: an agent whose «عرض الطلبات» is «المسندة إليه» cannot use it to see a colleague’s orders', () => {
  it('asking for Sara’s gives only the one of Sara’s that is already in HER own list (she typed it)', async () => {
    const abeer = await person('abeer', ['orders.view'], 'ASSIGNED');
    expect(listed(abeer, 'holderId=sara')).toEqual(['SARA-TYPED-BY-ABEER']);
    // …and that row was in her list before any filter: the filter took rows away, it added none.
    const before = listed(abeer, '');
    for (const id of listed(abeer, 'holderId=sara')) expect(before).toContain(id);
    expect(before).not.toContain('SARA-1');
  });

  it('nor through the queue that is not hers to ask («all_company»)', async () => {
    const abeer = await person('abeer', ['orders.view'], 'ASSIGNED');
    expect(listed(abeer, 'holderId=sara', 'all_company')).toEqual([]);
  });
});

describe('the names behind the filter (`GET /api/orders/holders`)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.order.groupBy.mockResolvedValue([
      { claimedById: 'sara', _count: { _all: 2 } },
      { claimedById: 'abeer', _count: { _all: 1 } },
      { claimedById: 'platform', _count: { _all: 4 } },
    ]);
    // `platform` is not of this company: the door asks the company, and the table answers only its own.
    db.user.findMany.mockImplementation(async (q: { where: { id: { in: string[] }; companyId: string } }) =>
      [
        { id: 'sara', name: 'سارة', companyId: 'c1' },
        { id: 'abeer', name: 'عبير', companyId: 'c1' },
        { id: 'platform', name: 'منصّة', companyId: 'c9' },
      ]
        .filter((u) => q.where.id.in.includes(u.id) && u.companyId === q.where.companyId)
        .map(({ id, name }) => ({ id, name }))
    );
  });

  it('answers whoever sees every order, most-holding first, asked of this store and only of held orders', async () => {
    state.user = await person('owner', ['orders.view']);
    const res = await holdersDoor();
    expect(res.status).toBe(200);
    expect((await res.json()).holders).toEqual([
      { id: 'sara', name: 'سارة', count: 2 },
      { id: 'abeer', name: 'عبير', count: 1 },
    ]);
    expect(db.order.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'c1', storeId: 's1', claimedById: { not: null } } })
    );
  });

  it('NEGATIVE: refuses an agent whose list is her own work, and one with no «عرض الطلبات» — nothing read', async () => {
    for (const u of [await person('abeer', ['orders.view'], 'ASSIGNED'), await person('x', ['confirmation.work'])]) {
      state.user = u;
      expect((await holdersDoor()).status, u.id).toBe(403);
    }
    expect(db.order.groupBy).not.toHaveBeenCalled();
  });
});
