import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * NOTHING IS ASKED OF AN ORDER ON AN OPEN TROLLEY — the owner's ruling 4/11.
 *
 * «مجرد ما الطلبات تترحل ع الباتش ما حد يقدر يلغي أي شي، ولا يترحل طلب الغاء او طلب تأجيل او تعديل، عشان اقدر اغلق الشحنة».
 *
 * THE RAISING DOOR, through the real permission engine (the same harness as the holder's window). Every intent is refused
 * with ON_OPEN_TROLLEY, by everybody — the holder, the desk, the packing table, the owner — before anything is written: no
 * request row, no self-approval, no note, no audit, nobody told. A trolley the order names but nobody can read is an open one.
 * After the handover the old answers stand.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess, createNotification, logAudit } = vi.hoisted(() => ({
  db: {
    orderChangeRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(async (..._a: unknown[]) => ({})) },
    shippingBatch: { findFirst: vi.fn() },
    order: { findFirst: vi.fn() },
    orderNote: { create: vi.fn() },
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  createNotification: vi.fn(async (..._a: unknown[]) => 1),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: vi.fn(),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/notify', () => ({ afterResponse: (fn: () => Promise<void>) => void fn() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { ON_TROLLEY_AR } from '@/lib/order-seal';
import { POST } from './route';

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

const AGENT = ['orders.view', 'orders.request_change', 'confirmation.work', 'orders.change_price', 'orders.edit_confirmed'];
const SUPERVISOR = ['orders.view', 'orders.request_change', 'control.change_requests', 'control.change_requests_view', 'orders.change_price'];
const WAREHOUSE_HAND = ['orders.view', 'orders.request_change', 'ops.decide_changes', 'ops.ship', 'orders.change_price'];

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Asia/Amman' };

/** A confirmed, packed order on trolley b1. */
const onTrolley = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', storeId: 's1', orderNumber: 'ORD-2026-1584', confirmationStatus: 'CONFIRMED',
  shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, labelPrintedAt: new Date(), claimedById: 'salma', shippingBatchId: 'b1',
  ...over,
});

const ASKS = [
  ['an edit', { intent: 'EDIT', reason: 'الزبون غيّر العنوان بالتلفون', changes: { customerAddress: { to: 'شارع جديد' } } }],
  ['a cancellation', { intent: 'CANCEL', reason: 'الزبون تراجع بالاتصال', cancelReason: 'CUSTOMER_CHANGED_MIND' }],
  ['a postponement', { intent: 'POSTPONE', reason: 'الزبون مسافر', postponeUntil: new Date(Date.now() + 5 * 86_400_000).toISOString() }],
] as const;

async function raise(user: SessionUser, order: Record<string, unknown>, body: Record<string, unknown>, batch: Record<string, unknown> | null) {
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1', country: COUNTRY });
  assertOrderAccess.mockResolvedValue({ allowed: true, order });
  db.shippingBatch.findFirst.mockResolvedValue(batch);
  const res = await POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  await new Promise((r) => setTimeout(r, 0));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const nothingWritten = () => {
  expect(db.orderChangeRequest.create, 'انكتب طلب على طرد على دفعة مفتوحة').not.toHaveBeenCalled();
  expect(db.orderChangeRequest.update).not.toHaveBeenCalled();
  expect(db.orderNote.create).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
  expect(createNotification).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'cr1', ...data }));
  db.order.findFirst.mockResolvedValue({ quantity: 1, productId: 'p1', sellingPrice: 10, discountAmount: 0, customerNotes: null, regionId: null, deliveryAddress: null, customer: {} });
});

describe('on a READY trolley every ask is refused at the door, by everybody', () => {
  const PEOPLE = [
    ['the holder', 'salma', 'CONFIRMATION_AGENT', AGENT],
    ['the desk', 'sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR],
    ['the packing table', 'hand', 'WAREHOUSE', WAREHOUSE_HAND],
    ['the owner', 'owner', 'SUPER_ADMIN', []],
  ] as const;

  for (const [who, id, role, keys] of PEOPLE) {
    it.each(ASKS)(`${who}: %s ⇒ 409 ON_OPEN_TROLLEY, in the one sentence, and nothing written`, async (_name, body) => {
      const user = await person(id, role, [...keys]);

      const res = await raise(user, onTrolley(), body as Record<string, unknown>, { status: 'READY', batchNumber: 'B-1' });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body).toMatchObject({ code: 'ON_OPEN_TROLLEY', error: ON_TROLLEY_AR, errorAr: ON_TROLLEY_AR });
      nothingWritten();
    });
  }
});

describe('fail closed', () => {
  it.each(ASKS)('%s on an order that NAMES a trolley nobody can read ⇒ refused the same way', async (_name, body) => {
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR);

    const res = await raise(sup, onTrolley(), body as Record<string, unknown>, null);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    nothingWritten();
  });
});

describe('the negatives — what the ruling does not touch', () => {
  it('after the handover an edit and a cancellation are raised as before (a message to the courier)', async () => {
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR);

    const edit = await raise(sup, onTrolley(), ASKS[0][1] as unknown as Record<string, unknown>, { status: 'SHIPPED', batchNumber: 'B-1' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(201);

    vi.clearAllMocks();
    db.orderChangeRequest.findFirst.mockResolvedValue(null);
    db.orderChangeRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'cr2', ...data }));
    db.order.findFirst.mockResolvedValue({ quantity: 1, productId: 'p1', sellingPrice: 10, discountAmount: 0, customerNotes: null, regionId: null, deliveryAddress: null, customer: {} });
    const cancel = await raise(sup, onTrolley(), ASKS[1][1] as unknown as Record<string, unknown>, { status: 'CLOSED', batchNumber: 'B-1' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(201);
  });

  it('after the handover a postponement keeps its own refusal — not the trolley’s', async () => {
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR);

    const res = await raise(sup, onTrolley(), ASKS[2][1] as unknown as Record<string, unknown>, { status: 'SHIPPED', batchNumber: 'B-1' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INTENT_IMPOSSIBLE');
  });

  it('an order on no trolley is asked about as before', async () => {
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR);

    const res = await raise(sup, onTrolley({ shippingBatchId: null, labelPrintedAt: null, shippingStatus: 'NOT_READY' }), ASKS[1][1] as unknown as Record<string, unknown>, null);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(db.orderChangeRequest.create).toHaveBeenCalledTimes(1);
  });
});
