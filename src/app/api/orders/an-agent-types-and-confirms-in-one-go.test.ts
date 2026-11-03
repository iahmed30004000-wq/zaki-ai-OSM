import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الزبون على الخط — أكّده الآن» FOR THE CONFIRMATION AGENTS AND THE SUPERVISOR (the owner, 2/11: «بنات التأكيد و المشرفة
 * يظهرلهم انشاء طلب وتحت في خيار انو طلب مؤكد») — T-06.
 *
 * Through the REAL permission engine (each person built as a session is: `computeEffectiveGrants` + `attachGrants`) at the REAL
 * creation door and then the REAL confirmation door. Only the database and the side effects are stubbed.
 *
 * Measured before the change (phase 1, the same engine): the live agent — the 22 keys read on the live site on 1/11, with
 * `confirmation.supervise` — had her entry sent to the pool and was refused `NOT_HELD`, even with a call logged; an agent without
 * supervise held it and was refused `CONTACT_FIRST`. The change: with the box ticked, a bound agent keeps what she typed (under the
 * 300 cap) and the call she is on is recorded in the same transaction. Neither refusal of the confirmation door is loosened.
 *
 * ⚠️ ORDER CREATION CHANGED — at the owner's explicit request. What must NOT change is checked here too: the money and stock
 * columns are identical with and without the box, and the creation door announces nothing (`order.created` stays the storefront's).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, tx, requireContext, assertOrderAccess, emitAppEvent, queueConversions, logAudit, notify, guardConfirmAgainstTwins, current } = vi.hoisted(() => {
  const order = {
    create: vi.fn(), count: vi.fn(async () => 0), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []),
    updateMany: vi.fn(), findUnique: vi.fn(),
  };
  const shared = {
    customer: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    offer: { findFirst: vi.fn(), findMany: vi.fn(async (): Promise<unknown[]> => []) },
    store: { findFirst: vi.fn() },
    region: { findFirst: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn() },
    order,
    orderItem: { createMany: vi.fn(), create: vi.fn(), findMany: vi.fn(async () => []) },
    orderActivity: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
    productionBatch: { findMany: vi.fn() },
    productFixedCost: { findMany: async () => [] },
    $executeRaw: vi.fn(async () => 1),
  };
  return {
    // The database outside any transaction: a call written HERE would not be part of the order's transaction.
    db: { ...shared, orderContactAttempt: { count: vi.fn(async () => 0), create: vi.fn() }, $transaction: vi.fn() },
    // The transaction's own client: the call must be written through THIS one.
    tx: { ...shared, orderContactAttempt: { count: vi.fn(async () => 0), create: vi.fn() } },
    requireContext: vi.fn(),
    assertOrderAccess: vi.fn(),
    emitAppEvent: vi.fn(),
    queueConversions: vi.fn(),
    logAudit: vi.fn(),
    notify: vi.fn(),
    guardConfirmAgainstTwins: vi.fn(async (): Promise<unknown[]> => []),
    current: { user: null as unknown as SessionUser },
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/blacklist', () => ({ activeBlock: vi.fn(async () => null), AlreadyBlocked: class extends Error {}, blockPhone: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/reservation', () => ({ releaseOrderLines: vi.fn(), reserveOrderLines: vi.fn(async () => undefined) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: (...a: unknown[]) => emitAppEvent(...a) }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: (...a: unknown[]) => queueConversions(...a) }));
vi.mock('@/lib/confirmed-twin', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  guardConfirmAgainstTwins: (...a: unknown[]) => guardConfirmAgainstTwins(...(a as [])),
}));
vi.mock('@/lib/rbac', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  applyQueueFilter: (_u: unknown, w: unknown) => w,
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    // The REAL `can`; only the throwing guard is rerouted to the person under test.
    requirePermission: async (k: string) => {
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});
vi.mock('@/lib/order-ref', () => ({ orderRefFields: async () => ({ orderNumber: 'JO-2026-0045', merchantRef: 'JO-2026-0045' }) }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { CONFIRM_NOW_NOTE, ENTRY_CAP_FULL_MESSAGE, MANUAL_ENTRY_REASON, NOT_HELD_MESSAGE, REGION_REQUIRED_MESSAGE } from '@/lib/confirmation-queue';
import { POST as CREATE } from './route';
import { POST as CONFIRM } from './[id]/confirmation/route';

/** CONFIRMATION_AGENT, live, 1/11: all 22 keys, whole company (the list in `the-live-agent-is-refused-by-the-real-engine.test.ts`). */
const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
/** What the owner ticks for them (the PR's owner section): «إنشاء طلبات» and «عرض المنتجات». */
const AGENT_TICKED = [...LIVE_AGENT, 'orders.create', 'products.view'];
/** CONFIRMATION_SUPERVISOR as the stage-2 migration shipped it (+ the PR-7 boxes). */
const SUP_TEMPLATE = [
  'confirmation.work', 'confirmation.supervise', 'confirmation.issues', 'confirmation.winback', 'confirmation.reassign', 'control.change_requests',
  'control.discount_alerts', 'orders.view', 'customers.view_basic', 'reports.view', 'dashboard.view',
];
/** …and the four boxes the PR names for her. */
const SUP_TICKED = [...SUP_TEMPLATE, 'orders.create', 'orders.confirm', 'orders.contact_log', 'products.view'];
/** A manager the hold rule does not bind (`orders.unlock` / `orders.assign`). */
const WORKING_MANAGER = ['orders.view', 'orders.create', 'orders.confirm', 'orders.contact_log', 'orders.assign', 'orders.unlock', 'confirmation.supervise', 'confirmation.work', 'products.view'];
const MODERATOR = ['orders.view', 'orders.create', 'orders.confirm', 'orders.contact_log', 'orders.claim'];

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

const PROD = { id: 'prod-cream-0001', name: 'كريم', image: null, basePrice: 45, batches: [{ costPerUnit: 5 }] };
const jordan = { id: 'co-jo', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman', orderPrefix: 'JO', allowNegativeStock: false };
const REGION = '11111111-1111-4111-8111-111111111111';

let inTx = false;
/** Where each call was written: `tx` (inside the order's transaction) or `db` (outside it). */
let attemptWrites: Array<{ where: 'tx' | 'db'; inTx: boolean; data: Record<string, unknown> }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  inTx = false;
  attemptWrites = [];
  for (const c of [db, tx]) {
    c.customer.findUnique.mockResolvedValue({ id: 'cu1', fullName: 'زبون', totalOrders: 0 });
    c.customer.findFirst.mockResolvedValue({ id: 'cu1', fullName: 'زبون', totalOrders: 0 });
  }
  db.product.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => [PROD].filter((p) => where.id.in.includes(p.id)));
  db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
  db.region.findFirst.mockResolvedValue({ id: REGION });
  db.user.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  db.productionBatch.findMany.mockResolvedValue([{ productId: PROD.id, quantityRemaining: 100, costPerUnit: 5 }]);
  db.order.count.mockResolvedValue(0);
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'o-new', createdAt: new Date(), ...data }));
  tx.orderContactAttempt.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    attemptWrites.push({ where: 'tx', inTx, data });
    return { id: 'a1', ...data };
  });
  db.orderContactAttempt.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    attemptWrites.push({ where: 'db', inTx, data });
    return { id: 'a1', ...data };
  });
  db.$transaction.mockImplementation(async (fn: (client: unknown) => unknown) => {
    inTx = true;
    try {
      return await fn(tx);
    } finally {
      inTx = false;
    }
  });
  guardConfirmAgainstTwins.mockResolvedValue([]);
});

const body = (over: Record<string, unknown> = {}) => ({
  customerName: 'زبون على الخط',
  customerPhone: '0791234567',
  regionId: REGION,
  items: [{ productId: PROD.id, quantity: 1, unitPrice: 45 }],
  priceIncludesDelivery: true,
  ...over,
});

async function create(u: SessionUser, b: Record<string, unknown>) {
  current.user = u;
  db.order.create.mockClear();
  requireContext.mockResolvedValue({ user: u, companyId: 'c1', storeId: 's1', countryId: 'co-jo', country: jordan });
  const res = await CREATE(new Request('http://localhost/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }));
  const json = (await res.json()) as Record<string, unknown>;
  const row = db.order.create.mock.calls[0]?.[0]?.data as Record<string, unknown> | undefined;
  return { status: res.status, json, row };
}

/** The confirmation door, for `who`, on the order the creation door just wrote — with the calls it wrote. */
async function confirm(who: SessionUser, row: Record<string, unknown>) {
  const order = {
    ...row, id: 'o-new', version: 1, confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', lockedById: null, lockExpiresAt: null,
    confirmedAt: null, nextFollowUpAt: null, followUpStatus: null, replacesOrderId: null, orderNumber: 'JO-2026-0045',
  };
  current.user = who;
  requireContext.mockResolvedValue({ user: who, companyId: 'c1', storeId: 's1', countryId: 'co-jo', country: jordan });
  assertOrderAccess.mockResolvedValue({ allowed: true, order });
  db.order.findUnique.mockResolvedValue(order);
  db.orderContactAttempt.count.mockResolvedValue(attemptWrites.length);
  const res = await CONFIRM(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm', expectedVersion: 1 }) }),
    { params: Promise.resolve({ id: 'o-new' }) }
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const claimRows = () => tx.orderClaimHistory.create.mock.calls.map((c) => c[0].data);

describe('the live agent (22 keys + «إنشاء طلبات» + «عرض المنتجات»), box ticked', () => {
  it('the order is HERS the moment she types it: claimed, one MANUAL_ENTRY claim row, and ready to confirm', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const r = await create(abeer, body({ confirmNow: true }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.row?.claimedById).toBe('abeer');
    expect(r.row?.currentOwnerId).toBe('abeer');
    expect(claimRows()).toEqual([expect.objectContaining({ userId: 'abeer', reason: MANUAL_ENTRY_REASON })]);
    expect(r.json.confirmNow).toEqual({ ready: true });
  });

  it('…and the call she is on is recorded ONCE — PHONE, ANSWERED, the note — through the transaction, inside it', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    await create(abeer, body({ confirmNow: true }));
    expect(attemptWrites).toEqual([
      {
        where: 'tx',
        inTx: true,
        data: {
          companyId: 'c1', orderId: 'o-new', employeeId: 'abeer', employeeRole: 'CONFIRMATION_AGENT',
          attemptNumber: 1, contactMethod: 'PHONE', result: 'ANSWERED', note: CONFIRM_NOW_NOTE,
        },
      },
    ]);
  });

  it('then the ordinary confirmation door says yes: no NOT_HELD, no CONTACT_FIRST — and announces order.confirmed once', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const made = await create(abeer, body({ confirmNow: true }));
    const yes = await confirm(abeer, made.row!);
    expect(yes.status, JSON.stringify(yes.json)).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ confirmationStatus: 'CONFIRMED', confirmedById: 'abeer' });
    expect(emitAppEvent.mock.calls.map((c) => c[1])).toEqual(['order.confirmed']);
  });

  it('she is its responsible moderator as well as its confirmer — one person, which is why the ledger pays her once', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const made = await create(abeer, body({ confirmNow: true }));
    expect(made.row?.moderatorId).toBe('abeer');
    await confirm(abeer, made.row!);
    expect(db.order.updateMany.mock.calls[0][0].data.confirmedById).toBe('abeer');
  });

  it('NEGATIVE: a colleague cannot confirm the order she typed — it is hers (NOT_HELD), nothing written', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const sara = await person('sara', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const made = await create(abeer, body({ confirmNow: true }));
    const no = await confirm(sara, made.row!);
    expect(no.status).toBe(403);
    expect(no.json.code).toBe('NOT_HELD');
    expect(no.json.errorAr).toBe(NOT_HELD_MESSAGE);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a confirmed twin still stops the yes — 409 TWIN_CONFIRMED, nothing written, nothing announced', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const made = await create(abeer, body({ confirmNow: true }));
    guardConfirmAgainstTwins.mockResolvedValue([{ id: 'o-twin', orderNumber: 'JO-2026-0001', confirmedAt: new Date(), confirmedByName: 'سارة' }]);
    const twin = await confirm(abeer, made.row!);
    expect(twin.status).toBe(409);
    expect(twin.json.code).toBe('TWIN_CONFIRMED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(emitAppEvent).not.toHaveBeenCalled();
  });
});

describe('the box unticked — the creation door is what it was', () => {
  it('NEGATIVE: the live agent’s entry goes to the pool (she holds supervise), no call recorded, and no «confirmNow» in the answer', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const r = await create(abeer, body());
    expect(r.status).toBe(200);
    expect(r.row?.claimedById).toBeNull();
    expect(claimRows()).toEqual([]);
    expect(attemptWrites).toEqual([]);
    expect('confirmNow' in r.json).toBe(false);
    // …and, exactly as measured before the change, the confirmation door refuses her
    const no = await confirm(abeer, r.row!);
    expect(no.json.code).toBe('NOT_HELD');
  });
});

describe('who the box is honoured for', () => {
  it('NEGATIVE: without «تغيير حالة التأكيد» — no claim is forced, no call written, «ما اتأكد» with the reason', async () => {
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', [...SUP_TEMPLATE, 'orders.create', 'orders.contact_log', 'products.view']);
    const r = await create(sup, body({ confirmNow: true }));
    expect(r.status).toBe(200);
    expect(r.row?.claimedById).toBeNull();
    expect(attemptWrites).toEqual([]);
    expect(r.json.confirmNow).toMatchObject({ ready: false, code: 'MAY_NOT_CONFIRM' });
  });

  it('NEGATIVE: without «تسجيل نتيجة الاتصال» — the same: the call is the one row that key guards', async () => {
    const agent = await person('noLog', 'CONFIRMATION_AGENT', AGENT_TICKED.filter((k) => k !== 'orders.contact_log'));
    const r = await create(agent, body({ confirmNow: true }));
    expect(r.row?.claimedById).toBeNull();
    expect(attemptWrites).toEqual([]);
    expect(r.json.confirmNow).toMatchObject({ ready: false, code: 'MAY_NOT_CONFIRM' });
  });

  it('RV686: somebody the hold rule does NOT bind needs only «تغيير حالة التأكيد» — no call written, no claim, and the yes as today', async () => {
    const mgr = await person('mgrNoLog', 'MANAGER', WORKING_MANAGER.filter((k) => k !== 'orders.contact_log'));
    const made = await create(mgr, body({ confirmNow: true }));
    expect(made.status).toBe(200);
    expect(made.row?.claimedById).toBeNull();
    expect(attemptWrites).toEqual([]);
    expect(made.json.confirmNow).toEqual({ ready: true });
    const yes = await confirm(mgr, made.row!);
    expect(yes.status, JSON.stringify(yes.json)).toBe(200);
  });

  it('NEGATIVE: a file never confirms — an import row carrying the box is an ordinary row', async () => {
    const agent = await person('importer', 'CONFIRMATION_AGENT', [...AGENT_TICKED, 'orders.import']);
    const r = await create(agent, body({ confirmNow: true, viaImport: true }));
    expect(r.status).toBe(200);
    expect(r.row?.claimedById).toBeNull();
    expect(attemptWrites).toEqual([]);
    expect('confirmNow' in r.json).toBe(false);
  });

  it('the supervisor with her four boxes: hers at once, the call recorded, and the confirmation door says yes', async () => {
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', SUP_TICKED);
    const made = await create(sup, body({ confirmNow: true }));
    expect(made.row?.claimedById).toBe('sup');
    expect(attemptWrites).toHaveLength(1);
    const yes = await confirm(sup, made.row!);
    expect(yes.status, JSON.stringify(yes.json)).toBe(200);
  });

  it('somebody the hold rule does not bind (a manager with unlock/assign, a moderator, the owner): no claim, no call — and the yes as before', async () => {
    for (const u of [
      await person('mgr', 'MANAGER', WORKING_MANAGER),
      await person('mod', 'MODERATOR', MODERATOR),
      await person('root', 'SUPER_ADMIN', []),
    ]) {
      attemptWrites = [];
      tx.orderClaimHistory.create.mockClear();
      db.order.updateMany.mockClear();
      const made = await create(u, body({ confirmNow: true }));
      expect(made.status, `${u.id}: ${JSON.stringify(made.json)}`).toBe(200);
      expect(made.row?.claimedById, u.id).toBeNull();
      expect(attemptWrites, u.id).toEqual([]);
      expect(made.json.confirmNow, u.id).toEqual({ ready: true });
      const yes = await confirm(u, made.row!);
      expect(yes.status, `${u.id}: ${JSON.stringify(yes.json)}`).toBe(200);
    }
  });
});

describe('the 300 cap still binds', () => {
  /** Her desk: `inHands` claimed by her, `held` held for her and not yet pulled (RV706: both count) — answered by what is asked. */
  const desk = (inHands: number, held = 0) =>
    (db.order.count as unknown as { mockImplementation(f: (q: { where?: Record<string, unknown> }) => Promise<number>): void }).mockImplementation(
      async ({ where }) => (where?.assignedToId ? held : inHands)
    );

  it('NEGATIVE: holding 300 — the order goes to the pool, NO call is written (whoever pulls it still rings), «ما اتأكد — وصلت للحد»', async () => {
    desk(300);
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const r = await create(abeer, body({ confirmNow: true }));
    expect(r.status).toBe(200);
    expect(r.row?.claimedById).toBeNull();
    expect(attemptWrites).toEqual([]);
    expect(r.json.notice).toBe(ENTRY_CAP_FULL_MESSAGE);
    expect(r.json.confirmNow).toEqual({ ready: false, code: 'CAP_FULL', reason: ENTRY_CAP_FULL_MESSAGE });
  });

  it('holding 299 — still hers', async () => {
    desk(299);
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const r = await create(abeer, body({ confirmNow: true }));
    expect(r.row?.claimedById).toBe('abeer');
    expect(attemptWrites).toHaveLength(1);
  });

  it('RV706: 299 in her hands + 1 held for her = 300 — «أكّده الآن» sends it to the pool, as at 300 in her hands', async () => {
    desk(299, 1);
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const r = await create(abeer, body({ confirmNow: true }));
    expect(r.row?.claimedById).toBeNull();
    expect(attemptWrites).toEqual([]);
    expect(r.json.confirmNow).toEqual({ ready: false, code: 'CAP_FULL', reason: ENTRY_CAP_FULL_MESSAGE });
  });

  it('RV706 NEGATIVE: 298 in her hands + 1 held = 299 — still hers', async () => {
    desk(298, 1);
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const r = await create(abeer, body({ confirmNow: true }));
    expect(r.row?.claimedById).toBe('abeer');
    expect(attemptWrites).toHaveLength(1);
  });
});

describe('no governorate', () => {
  it('hers and the call recorded (she is on it), but «ما اتأكد — حدّد المحافظة» before any doomed call', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const r = await create(abeer, body({ confirmNow: true, regionId: null }));
    expect(r.row?.claimedById).toBe('abeer');
    expect(attemptWrites).toHaveLength(1);
    expect(r.json.confirmNow).toEqual({ ready: false, code: 'REGION_REQUIRED', reason: REGION_REQUIRED_MESSAGE });
  });
});

describe('what must NOT change', () => {
  /*
   * RV692 (independent review, money lens): THREE ORDERS, FIVE PEOPLE, BOX OFF AGAINST BOX ON — every column of the order row and
   * of its lines, byte for byte, except the three that say whose it is (`claimedById`, `claimedAt`, `currentOwnerId`). The orders
   * carry what a box could quietly drop: a courier fee, an offer with a gift and delivery included, a discount spread over two lines.
   */
  const OFFER_INC = { id: 'offer-inc-000001', quantity: 3, discount: 0, deliveryIncluded: true, freeQuantity: 1 };
  const OFFER_DISC = { id: 'offer-disc-00001', quantity: 2, discount: 5, deliveryIncluded: false, freeQuantity: 0 };
  const PROD2 = { id: 'prod-soap-00002', name: 'صابون', image: null, basePrice: 15, batches: [{ costPerUnit: 2 }] };
  const ORDERS: Record<string, Record<string, unknown>> = {
    // the PR's worked example: 45 JOD, delivery included, courier fee 3
    '45 JOD, fee 3': { items: [{ productId: PROD.id, quantity: 1, unitPrice: 45 }], priceIncludesDelivery: true, shippingCost: 3 },
    // an offer 3 + 1 with delivery included — the offer decides the flag (no box sent) — fee 3
    'offer 3+1, delivery included, fee 3': {
      items: [{ productId: PROD.id, offerId: OFFER_INC.id, quantity: 3, unitPrice: 60 }],
      priceIncludesDelivery: undefined,
      shippingCost: 3,
    },
    // two lines and a 5 JOD discount (the top-level offer), the fee added on top
    'two lines, 5 JOD discount': {
      offerId: OFFER_DISC.id,
      items: [{ productId: PROD.id, quantity: 2, unitPrice: 80 }, { productId: PROD2.id, quantity: 1, unitPrice: 15 }],
      priceIncludesDelivery: false,
      shippingCost: 3,
    },
  };
  const OWNERSHIP = new Set(['claimedById', 'claimedAt', 'currentOwnerId']);
  const snapshot = () => {
    const order = { ...(db.order.create.mock.calls[0][0].data as Record<string, unknown>) };
    for (const k of OWNERSHIP) delete order[k];
    return { order, lines: (tx.orderItem.createMany.mock.calls.at(-1)?.[0]?.data ?? []) as Record<string, unknown>[] };
  };
  const catalogue = () => {
    db.product.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => [PROD, PROD2].filter((p) => where.id.in.includes(p.id)));
    db.productionBatch.findMany.mockResolvedValue([
      { productId: PROD.id, quantityRemaining: 100, costPerUnit: 5 },
      { productId: PROD2.id, quantityRemaining: 100, costPerUnit: 2 },
    ]);
    db.offer.findMany.mockImplementation((async ({ where }: { where: { id: { in: string[] } } }) => [OFFER_INC, OFFER_DISC].filter((o) => where.id.in.includes(o.id))) as never);
    db.offer.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => [OFFER_INC, OFFER_DISC].find((o) => o.id === where?.id) ?? null);
  };

  for (const [name, fixture] of Object.entries(ORDERS)) {
    it(`${name}: every column but whose-it-is is identical with and without the box, for five kinds of person`, async () => {
      catalogue();
      const people = [
        await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED),
        await person('sup', 'CONFIRMATION_SUPERVISOR', SUP_TICKED),
        await person('mgr', 'MANAGER', WORKING_MANAGER),
        await person('mod', 'MODERATOR', MODERATOR),
        await person('root', 'SUPER_ADMIN', []),
      ];
      const money: unknown[] = [];
      for (const u of people) {
        const shots: ReturnType<typeof snapshot>[] = [];
        for (const ticked of [false, true]) {
          tx.orderItem.createMany.mockClear();
          const r = await create(u, body({ ...fixture, ...(ticked ? { confirmNow: true } : {}) }));
          expect(r.status, `${name}/${u.id}/${ticked}: ${JSON.stringify(r.json)}`).toBe(200);
          shots.push(snapshot());
        }
        expect(shots[1], `${name}/${u.id}`).toEqual(shots[0]);
        const o = shots[0].order;
        money.push({
          order: [o.quantity, o.sellingPrice, o.shippingCost, o.totalAmount, o.estimatedCostOfGoods, o.priceIncludesDelivery, o.offerId],
          // who added each line is the one column that differs by person (`addedById`), never by the box
          lines: shots[0].lines.map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'addedById'))),
        });
      }
      // …the same figures whoever typed it
      for (const m of money.slice(1)) expect(m).toEqual(money[0]);
    });
  }

  it('…and what those three orders come to with the box (so a box that changed every person alike is still caught)', async () => {
    catalogue();
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const seen: Array<ReturnType<typeof snapshot>> = [];
    for (const fixture of Object.values(ORDERS)) {
      tx.orderItem.createMany.mockClear();
      await create(abeer, body({ ...fixture, confirmNow: true }));
      seen.push(snapshot());
    }
    const [f45, offer, disc] = seen;
    expect(f45.order).toMatchObject({ totalAmount: 45, sellingPrice: 45, shippingCost: 3, priceIncludesDelivery: true });
    expect(offer.order).toMatchObject({ offerId: OFFER_INC.id, priceIncludesDelivery: true, shippingCost: 3 });
    expect(offer.lines[0]).toMatchObject({ quantity: 3, freeQuantity: 1 });
    expect(disc.order).toMatchObject({ offerId: OFFER_DISC.id, priceIncludesDelivery: false, shippingCost: 3 });
    expect(disc.lines.reduce((t, l) => t + Number(l.discountShare), 0)).toBeCloseTo(5, 3);
  });

  it('RV689: the ORDER_CREATED activity carries «confirmNow: true» only when the box was ticked — unticked, no such key at all', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const meta = () => {
      const row = tx.orderActivity.create.mock.calls.map((c) => c[0].data).find((d) => d.action === 'ORDER_CREATED');
      return JSON.parse(String(row?.metadata)) as Record<string, unknown>;
    };
    await create(abeer, body());
    const plain = meta();
    expect('confirmNow' in plain).toBe(false);
    expect(Object.keys(plain).sort()).toEqual(['createdBy', 'source']);
    tx.orderActivity.create.mockClear();
    await create(abeer, body({ confirmNow: true }));
    expect(meta()).toMatchObject({ confirmNow: true });
  });

  it('the creation door announces nothing — no order.created, no conversion — with the box ticked', async () => {
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    await create(abeer, body({ confirmNow: true }));
    expect(emitAppEvent).not.toHaveBeenCalled();
    expect(queueConversions).not.toHaveBeenCalled();
  });

  it('a failed call write fails the whole order: nothing after the transaction runs (no audit, no notification)', async () => {
    tx.orderContactAttempt.create.mockRejectedValueOnce(new Error('disk full'));
    const abeer = await person('abeer', 'CONFIRMATION_AGENT', AGENT_TICKED);
    const r = await create(abeer, body({ confirmNow: true }));
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(logAudit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
