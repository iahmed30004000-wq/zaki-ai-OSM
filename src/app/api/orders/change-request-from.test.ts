import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A change request records what each field is changing FROM — taken by the
 * server from the order, never from the browser.
 *
 * The decision dialog was built to show "3 instead of 2" and had only ever
 * been given the 3. And a "from" accepted from the requester could claim
 * anything: that the price was higher, that the address was different.
 */

const { db, requireContext, assertOrderAccess } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(async () => ({})) },
    // The raiser may decide it themselves when the parcel has not left, so
    // the door reads the seal before it queues anything.
    shippingBatch: { findFirst: vi.fn(async () => null) },
    orderNote: { create: vi.fn() },
    user: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn() }));

import { POST } from '@/app/api/orders/[id]/change-requests/route';

const ctx = {
  // OLD → NEW (PR-6): raising a request is its own key (`orders.request_change`), given to everybody who passed the work door.
  user: { id: 'u1', name: 'مودريتور', role: 'MODERATOR', status: 'ACTIVE', permissions: ['orders.request_change'] },
  companyId: 'c1', storeId: 's1',
  country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Asia/Amman' },
};
const params = { params: Promise.resolve({ id: 'o1' }) };
const req = (body: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(ctx);
  assertOrderAccess.mockResolvedValue({
    allowed: true,
    order: { id: 'o1', confirmationStatus: 'CONFIRMED', claimedById: null },
  });
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'cr1', ...data }));
  db.orderNote.create.mockResolvedValue({});
  db.user.findMany.mockResolvedValue([]);
  db.order.findFirst.mockResolvedValue({
    quantity: 2, productId: 'p1', offerId: null, discountAmount: 0, customerNotes: null,
    customer: { fullName: 'أحمد', phone: '0791234567', altPhone: null, address: 'عمان', city: 'عمان' },
  });
});

describe('the value before', () => {
  it('is stored beside the value after', async () => {
    const res = await POST(req({ changes: { quantity: { to: 3 } }, reason: 'الزبون طلب ثلاثة' }), params);
    expect(res.status).toBeLessThan(300);
    expect(db.orderChangeRequest.create.mock.calls[0][0].data.changes).toEqual({ quantity: { from: 2, to: 3 } });
  });

  it('comes from the order, not from what the requester claims', async () => {
    // Negative test: the requester says the quantity was 10. It was 2.
    await POST(req({ changes: { quantity: { from: 10, to: 3 } }, reason: 'الزبون طلب ثلاثة' }), params);
    expect(db.orderChangeRequest.create.mock.calls[0][0].data.changes.quantity.from).toBe(2);
  });

  it('is read inside the company, so a request cannot peek at another tenant', async () => {
    await POST(req({ changes: { customerName: { to: 'محمد' } }, reason: 'خطأ بالاسم' }), params);
    expect(db.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1', companyId: 'c1' } })
    );
  });
});
