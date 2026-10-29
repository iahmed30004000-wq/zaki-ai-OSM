import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHO IS RESPONSIBLE FOR AN ORDER CHANGES — WHAT THE ORDER IS DOES NOT (perm-plan PR-6, decision D10, RV150).
 *
 * This change touches order CREATION on purpose, and a blocker category with it. The owner's rule for this change, in his
 * words: «اي قرار بعد الان اتخذو دون الرجوع الي». The decision (D10) was: the responsible moderator is whoever created the
 * order, if they do not hold `orders.assign`; naming somebody else needs `orders.assign` (RV150, because with the moderator
 * goes the commission).
 *
 * So this file does two things, through the REAL permission engine, at the REAL door (\`POST /api/orders\`):
 *
 *   1. the same order — a bundle with a gift, a delivery fee, a delivery-inclusive store — is typed by every kind of
 *      person, and EVERY MONEY COLUMN IS IDENTICAL: the total, the COD, the price, the fee, the discount, the cost of
 *      goods, the units and the gift on each line. What differs is one column, \`moderatorId\`;
 *   2. that column, and the one refusal, are compared with what the door did BEFORE (the role-name rule, replayed here as
 *      \`before\`), person by person — so the cells that changed are named, not discovered.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, logAudit, activeBlock, createNotification, current } = vi.hoisted(() => ({
  db: {
    customer: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    offer: { findFirst: vi.fn(), findMany: vi.fn(async (): Promise<unknown[]> => []) },
    store: { findFirst: vi.fn() },
    region: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    order: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    orderItem: { createMany: vi.fn(), create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    productionBatch: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  activeBlock: vi.fn(),
  createNotification: vi.fn(),
  current: { user: null as unknown as SessionUser },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/rbac', () => ({ applyQueueFilter: (_u: unknown, w: unknown) => w }));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    // The REAL `can` and `getPermissionScope`; only the throwing guard is rerouted to the persona under test.
    requirePermission: async (k: string) => {
      requirePermission(k);
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});
vi.mock('@/lib/order-ref', () => ({
  orderRefFields: async () => ({ orderNumber: 'SY-2026-0200', merchantRef: 'SY-2026-0200' }),
}));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { POST } from './route';

const CREAM = { id: 'prod-cream-0001', name: 'كريم حرير', image: null, basePrice: 20, batches: [{ costPerUnit: 5 }] };
const BUNDLE = { id: 'offer-bundle-0001', quantity: 3, discount: 0, deliveryIncluded: true, freeQuantity: 1 };
const syria = { id: 'co-sy', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, timezone: 'Asia/Damascus', orderPrefix: 'SY', allowNegativeStock: false };

/** A colleague who exists in this company, to be named. */
const COLLEAGUE = 'colleague-0000001';

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

/** The people the owner cares about. `role` is the legacy role STRING — the thing the old rule read. */
async function cast() {
  return {
    // The shipped «موديريتور»: types orders, does not hand them out.
    ordinary: await person('ordinary', 'MODERATOR', ['orders.view', 'orders.create', 'orders.edit']),
    // A supervisor and an admin: they hand orders out.
    supervisor: await person('supervisor', 'CONFIRMATION_SUPERVISOR', ['orders.view', 'orders.create', 'orders.assign']),
    admin: await person('admin', 'COMPANY_ADMIN', ['orders.view', 'orders.create', 'orders.edit', 'orders.assign']),
    // A typist the owner built himself under another name: orders.create, no orders.assign.
    typist: await person('typist', 'CUSTOM_TYPIST', ['orders.create']),
    // The stock role name WITH the key: a moderator who also hands orders out.
    modWithAssign: await person('modWithAssign', 'MODERATOR', ['orders.view', 'orders.create', 'orders.assign']),
    // The owner of the installation: passes everything.
    root: await person('root', 'SUPER_ADMIN', []),
  } as const;
}

/** What the door did BEFORE this change: the role-name rule, and no refusal at all. */
const before = (u: { id: string; role: string }, requested: string | null) => requested || (u.role === 'MODERATOR' ? u.id : null);

const body = (over: Record<string, unknown> = {}) => ({
  customerName: 'محمد الحسن',
  customerPhone: '0944555666',
  customerAddress: 'دوما',
  source: 'Manual',
  shippingCost: 3,
  // the bundle with its gift, the way the order dialog sends it: an offer on the LINE
  items: [{ productId: CREAM.id, offerId: BUNDLE.id, quantity: 3, unitPrice: 54 }],
  ...over,
});

const post = (b: unknown) =>
  POST(new Request('http://localhost/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }));

/** The order row and the lines the door wrote. */
const written = () => ({ order: db.order.create.mock.calls[0]?.[0]?.data, lines: db.orderItem.createMany.mock.calls[0]?.[0]?.data ?? [] });

/** Everything about the order that is MONEY or STOCK — every column except who is responsible. */
const moneyAndStock = () => {
  const { order, lines } = written();
  return {
    order: {
      quantity: order.quantity, sellingPrice: order.sellingPrice, shippingCost: order.shippingCost, totalAmount: order.totalAmount,
      estimatedCostOfGoods: order.estimatedCostOfGoods, priceIncludesDelivery: order.priceIncludesDelivery, offerId: order.offerId,
      currency: order.currency, productId: order.productId,
    },
    lines: lines.map((l: Record<string, unknown>) => ({
      productId: l.productId, quantity: l.quantity, freeQuantity: l.freeQuantity, unitPrice: l.unitPrice, discountShare: l.discountShare, lineTotal: l.lineTotal,
    })),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  requirePermission.mockReset();
  createNotification.mockResolvedValue(1);
  activeBlock.mockResolvedValue(null);
  db.customer.findUnique.mockResolvedValue({ id: 'cu1', fullName: 'محمد الحسن', totalOrders: 0 });
  db.customer.findFirst.mockResolvedValue({ id: 'cu1', fullName: 'محمد الحسن', totalOrders: 0 });
  db.product.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => [CREAM].filter((p) => where.id.in.includes(p.id)));
  db.offer.findFirst.mockResolvedValue(BUNDLE);
  db.offer.findMany.mockResolvedValue([BUNDLE]);
  db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
  // the colleague exists in this company; so does anybody else named by id
  db.user.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200' });
  db.productionBatch.findMany.mockResolvedValue([{ productId: CREAM.id, quantityRemaining: 100, costPerUnit: 5 }]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

async function asUser(u: SessionUser) {
  current.user = u;
  requireContext.mockResolvedValue({ user: u, companyId: 'c1', storeId: 's1', countryId: 'co-sy', country: syria });
}

describe('THE MONEY IS THE SAME WHOEVER TYPES THE ORDER — a bundle, its gift, a fee, a delivery-inclusive price', () => {
  it('every kind of person gets the same total, COD, price, fee, cost of goods, units and gift on every line', async () => {
    const people = await cast();
    const seen: Array<ReturnType<typeof moneyAndStock>> = [];
    for (const [name, u] of Object.entries(people)) {
      vi.clearAllMocks();
      createNotification.mockResolvedValue(1);
      db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200' });
      await asUser(u);
      const res = await post(body());
      expect(res.status, `${name}: ${await res.clone().text()}`).toBeLessThan(300);
      seen.push(moneyAndStock());
    }
    expect(seen).toHaveLength(6);
    for (const s of seen.slice(1)) expect(s).toEqual(seen[0]);
    // …and the figures are really there (an equality of six empty objects would pass for the wrong reason)
    expect(seen[0].order.quantity).toBe(3);
    expect(seen[0].order.sellingPrice).toBe(54);
    expect(seen[0].order.shippingCost).toBe(3);
    expect(seen[0].order.totalAmount).toBe(54); // delivery is inside the bundle's price: COD is the goods
    expect(seen[0].order.estimatedCostOfGoods).toBe(20); // 3 sold + 1 gift, at 5 each
    expect(seen[0].lines[0].freeQuantity).toBe(1); // ONE gift for the bundle, not × the pieces
    expect(seen[0].lines[0].quantity).toBe(3);
  });

  it('and the same with the fee ADDED on top (a store whose prices do not include delivery)', async () => {
    db.offer.findFirst.mockResolvedValue({ ...BUNDLE, deliveryIncluded: false });
    db.offer.findMany.mockResolvedValue([{ ...BUNDLE, deliveryIncluded: false }]);
    const people = await cast();
    const totals: number[] = [];
    for (const u of [people.ordinary, people.typist, people.admin, people.root]) {
      vi.clearAllMocks();
      createNotification.mockResolvedValue(1);
      db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200' });
      await asUser(u);
      await post(body());
      totals.push(written().order.totalAmount);
    }
    expect(new Set(totals).size).toBe(1);
    expect(totals[0]).toBe(57); // 54 + 3
  });
});

describe('WHO IS RESPONSIBLE — the new rule against the role-name rule it replaces, person by person', () => {
  type Cell = { requested: string | null; moderatorId: string | null; status: number };
  const run = async (u: SessionUser, requested: string | null): Promise<Cell> => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(1);
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200' });
    await asUser(u);
    const res = await post(body(requested ? { moderatorId: requested } : {}));
    return { requested, moderatorId: written().order?.moderatorId ?? null, status: res.status };
  };

  it('nobody named: whoever does not hand orders out owns what they type; whoever does leaves it unowned', async () => {
    const p = await cast();
    expect((await run(p.ordinary, null)).moderatorId).toBe('ordinary'); //  stock moderator — unchanged from before
    expect((await run(p.supervisor, null)).moderatorId).toBeNull(); //      hands orders out — unchanged
    expect((await run(p.admin, null)).moderatorId).toBeNull(); //           unchanged
    expect((await run(p.root, null)).moderatorId).toBeNull(); //            unchanged
    expect((await run(p.typist, null)).moderatorId).toBe('typist'); //      CHANGED (D10): was nobody
    expect((await run(p.modWithAssign, null)).moderatorId).toBeNull(); //   CHANGED (D10): was himself
  });

  it('yourself named: always yours, with or without the key — nothing changes', async () => {
    const p = await cast();
    for (const u of [p.ordinary, p.supervisor, p.admin, p.typist, p.modWithAssign]) {
      const r = await run(u, u.id);
      expect(r.status, u.id).toBeLessThan(300);
      expect(r.moderatorId, u.id).toBe(u.id);
    }
  });

  it('somebody else named: only with orders.assign — everyone else is refused with a 403 and NOTHING is written (RV150)', async () => {
    const p = await cast();
    for (const u of [p.supervisor, p.admin, p.modWithAssign, p.root]) {
      const r = await run(u, COLLEAGUE);
      expect(r.status, u.id).toBeLessThan(300);
      expect(r.moderatorId, u.id).toBe(COLLEAGUE);
    }
    for (const u of [p.ordinary, p.typist]) {
      const r = await run(u, COLLEAGUE);
      expect(r.status, `${u.id} نصّب غيره بلا إسناد`).toBe(403);
      expect(db.order.create, `${u.id}: كُتب طلب`).not.toHaveBeenCalled();
      expect(db.customer.findFirst, `${u.id}: لُمس زبون`).not.toHaveBeenCalled();
    }
  });

  it('the refusal says why, in Arabic, with a code a screen can read', async () => {
    const p = await cast();
    await asUser(p.ordinary);
    const res = await post(body({ moderatorId: COLLEAGUE }));
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.code).toBe('MODERATOR_FORBIDDEN');
    expect(json.error).toMatch(/إسناد الطلبات/);
  });

  it('THE TABLE: what the door did before and what it does now, for six kinds of person × three requests', async () => {
    const p = await cast();
    const rows: string[] = [];
    for (const [name, u] of Object.entries(p)) {
      for (const requested of [null, u.id, COLLEAGUE]) {
        const was = before(u, requested);
        const now = await run(u, requested);
        const is = now.status >= 400 ? 'REFUSED' : now.moderatorId;
        if (was !== is) rows.push(`${name} ${requested === null ? '—' : requested === u.id ? 'self' : 'other'}: ${was} → ${is}`);
      }
    }
    // Exactly these cells moved, and each is the decision, not an accident:
    expect(rows.sort()).toEqual([
      'modWithAssign —: modWithAssign → null',
      'ordinary other: colleague-0000001 → REFUSED',
      'typist —: null → typist',
      'typist other: colleague-0000001 → REFUSED',
    ].sort());
  });

  it('NEGATIVE: the role name no longer decides — a SUPER_ADMIN who is not a «MODERATOR» is not made one, and a custom role is', async () => {
    const p = await cast();
    // same legacy role string, different key → different answer: the KEY decides
    expect(p.ordinary.role).toBe(p.modWithAssign.role);
    expect((await run(p.ordinary, null)).moderatorId).not.toBe((await run(p.modWithAssign, null)).moderatorId);
    // different legacy role string, same key → same answer
    expect((await run(p.typist, null)).moderatorId).toBe('typist');
  });
});
