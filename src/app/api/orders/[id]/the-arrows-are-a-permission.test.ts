import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * NO PERMISSION, NO NEIGHBOUR IDS — AND THE IDS WERE THE WHOLE MECHANISM.
 *
 * «الطلب السابق» / «الطلب التالي» had no permission of their own. The
 * owner could not grant them to one role and withhold them from another,
 * because there was nothing on «الصلاحيات» to tick.
 *
 * Hiding the buttons would not have been enough: the arrows are rendered
 * from two ids this route returns, and a hand-written request reads them
 * just as well. So the gate is here, on the ids, and the buttons simply
 * have nothing to draw when they are absent.
 *
 * (Which SET of orders the arrows walk — the list, never the unclaimed
 * pool — is held by `src/lib/the-arrows-walk-the-list.test.ts`.)
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, getPermissionScope, assertOrderReadable, noteCustomersHandedOut } =
  vi.hoisted(() => ({
    db: {
      order: { findUnique: vi.fn(), findFirst: vi.fn() },
      returnReceipt: { count: vi.fn() },
    },
    requireContext: vi.fn(),
    can: vi.fn(),
    authorize: vi.fn(),
    getPermissionScope: vi.fn(),
    assertOrderReadable: vi.fn(),
    noteCustomersHandedOut: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
  // `rbac` re-exports this one at import time; without it the module
  // never loads and the file reports «no tests».
  requirePermission: vi.fn(),
}));
/*
 * `applyQueueFilter` and `orderListWhere` are the REAL ones. Stubbing the
 * filter to identity would have made the envelope assertion below vacuous:
 * it is the whole subject — which SET of orders the arrows may land on.
 */
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: vi.fn(),
  assertOrderReadable: (...a: unknown[]) => assertOrderReadable(...a),
}));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));
// This route's `apiError` returns `{ body, status }`, not a Response.
// Surfaced rather than swallowed, so a missing mock names itself.
vi.mock('@/lib/api-error', () => ({
  apiError: (e: unknown) => ({ body: { error: `UNEXPECTED: ${(e as Error)?.message}` }, status: 500 }),
}));

import { GET } from './route';

const NOW = new Date('2026-10-15T06:00:00.000Z');

/** The order the window is open on, with the joins the route selects. */
const ORDER = {
  id: 'o1',
  companyId: 'c1',
  storeId: 's1',
  orderNumber: 'ORD-5',
  createdAt: NOW,
  status: 'NEW',
  confirmationStatus: 'NEW',
  signatureStatus: 'UNSIGNED',
  claimedById: 'a1',
  totalAmount: 20,
  quantity: 1,
  items: [],
  addOns: [],
  customer: { id: 'cu1', fullName: 'زبون', phone: '079', city: 'عمّان' },
  activities: [],
  statusLogs: [],
  contactAttempts: [],
  changeRequests: [],
  deliveryAttempts: [],
  notes: [],
  callLogs: [],
  commissions: [],
  shipments: [],
  payments: [],
  returnReceipts: [],
  claimHistory: [],
};

const open = () =>
  GET(new Request('http://localhost/api/orders/o1'), { params: Promise.resolve({ id: 'o1' }) });

/** An unclaimed NEW order: nobody's, and in the pool. */
const POOL = {
  claimedById: null,
  createdById: null,
  assignedToId: null,
  currentOwnerId: null,
  moderatorId: null,
  confirmationStatus: 'NEW',
  signatureStatus: 'UNSIGNED',
  lockedById: null,
};

/** Does an order satisfy a Prisma-shaped where? Handles AND / OR nesting. */
function matches(envelope: Record<string, any>, order: Record<string, any>): boolean {
  const SKIP = new Set(['companyId', 'storeId', 'createdAt', 'id']);
  const clause = (c: Record<string, any>): boolean => {
    if (Array.isArray(c.AND) && !c.AND.every(clause)) return false;
    if (Array.isArray(c.OR) && !c.OR.some(clause)) return false;
    return Object.entries(c).every(([field, want]) =>
      field === 'AND' || field === 'OR' || SKIP.has(field) ? true : order[field] === want
    );
  };
  return clause(envelope);
}

/** Everything this role may do, by permission key. */
const holding = (...keys: string[]) => {
  can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
  authorize.mockImplementation((_u: unknown, k: string) => ({ allowed: keys.includes(k) }));
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'a1', name: 'سارة', role: 'CONFIRMATION_AGENT' },
    companyId: 'c1',
    storeId: 's1',
    country: { id: 'co', code: 'JO', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman' },
  });
  getPermissionScope.mockReturnValue({ scope: 'ASSIGNED' });
  assertOrderReadable.mockResolvedValue({ allowed: true, order: ORDER });
  db.order.findUnique.mockResolvedValue(ORDER);
  // A neighbour exists in both directions, so «لم يُرجَع معرّف» can only
  // ever mean the gate refused — never that the queue was empty.
  db.order.findFirst.mockResolvedValue({ id: 'o-neighbour' });
  db.returnReceipt.count.mockResolvedValue(0);
  noteCustomersHandedOut.mockResolvedValue(undefined);
});

describe('the previous/next ids', () => {
  it('are absent without orders.navigate, and the database is never even asked', async () => {
    holding('orders.view');

    const res = await open();
    const body = await res.json();

    expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
    expect(body.previousOrderId, 'رجع معرّف السابق بلا صلاحية').toBeNull();
    expect(body.nextOrderId, 'رجع معرّف اللاحق بلا صلاحية').toBeNull();
    expect(db.order.findFirst, 'سأل القاعدة عن الجيران رغم الرفض').not.toHaveBeenCalled();
  });

  it('and present with it', async () => {
    holding('orders.view', 'orders.navigate');

    const res = await open();
    const body = await res.json();

    expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
    expect(body.previousOrderId).toBe('o-neighbour');
    expect(body.nextOrderId).toBe('o-neighbour');
  });

  it('and the set they may land on is the LIST, never the unclaimed pool', async () => {
    /*
     * THE PART THAT WAS ACTUALLY DANGEROUS.
     *
     * The neighbours used to be looked up through `orderVisibilityWhere` —
     * the READ envelope — which deliberately carries the pool so an agent
     * can open the order she is about to pull. So one order opened was a
     * walk through every unclaimed order in the store, names and phones
     * included: the queue C2 had just taken out of her list, handed back
     * by the button beside it.
     *
     * Asserted on the WHERE the route actually handed the database, not on
     * which helper it imported.
     */
    holding('orders.view', 'orders.navigate');
    await open();

    const where = db.order.findFirst.mock.calls[0]?.[0]?.where;
    expect(where, 'ما سأل عن الجيران أصلاً').toBeTruthy();
    expect(matches(where, POOL), 'الأسهم لسّا بتمشي بالطابور غير المسحوب').toBe(false);
    expect(matches(where, { ...ORDER, claimedById: 'a1' }), 'الأسهم ما عادت توصل لطلباتها').toBe(true);
  });

  it('and a custom role on the same scope is treated exactly like the named ones', async () => {
    /*
     * THE OTHER HALF OF THE OLD DEFECT.
     *
     * The envelope used to be chosen from a list of role NAMES —
     * MODERATOR · CONFIRMATION_AGENT · FOLLOW_UP_AGENT. A role the company
     * made itself, on the same scope under another name, fell past the
     * list and walked every order in the store. A guard that is a list is
     * incomplete the day it is written.
     */
    requireContext.mockResolvedValue({
      user: { id: 'a1', name: 'سارة', role: 'موظّف تأكيد — مسائي', permissions: [] },
      companyId: 'c1',
      storeId: 's1',
      country: { id: 'co', code: 'JO', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman' },
    });
    holding('orders.view', 'orders.navigate');

    await open();

    const where = db.order.findFirst.mock.calls[0]?.[0]?.where;
    expect(where, 'ما سأل عن الجيران').toBeTruthy();
    expect(matches(where, POOL), 'دور مخصّص لسّا بيمشي بالطابور').toBe(false);
  });

  it('and the order itself opens either way — this gates the arrows, not the door', async () => {
    holding('orders.view');

    const res = await open();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.order?.id ?? body.id).toBe('o1');
  });
});
