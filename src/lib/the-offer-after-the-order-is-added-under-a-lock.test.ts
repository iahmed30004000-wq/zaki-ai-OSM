import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ط44 — THE OFFER AFTER THE ORDER CAN BE ADDED TWICE, AND IS NOT ANY MORE.
 *
 * Two presses at the same moment both read the order and the count of post-order add-ons (0), both passed the gates
 * and both wrote: 20 became 50 with an offer at 15. The transaction now takes the order's row FIRST (an UPDATE holds
 * it until the end), so the second press waits there; then the count and the gates are read again on the order as it
 * is now. `version` moves with the lock, so a staff member saving from an older copy is told the order changed.
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — decided: the lock is the UPDATE itself (no new table, no migration, no
 * unique index — the partial index is a production write and stays the owner's).
 */

const dbMock = vi.hoisted(() => ({
  order: { findFirst: vi.fn(), update: vi.fn() },
  orderAddOn: { count: vi.fn(), create: vi.fn() },
  offer: { findFirst: vi.fn(), findMany: vi.fn() },
  company: { findUnique: vi.fn() },
  landingPage: { update: vi.fn() },
  orderActivity: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('./db', () => ({ db: dbMock, default: dbMock }));
vi.mock('./price-honesty', () => ({
  evidencedWasPrices: async () => new Map<string, number>(),
  struckThroughPrice: () => null,
}));

import { addPostOrderOffer } from './post-order-offer';

const NOW = new Date('2026-10-29T12:00:00Z');
const ORDER = {
  id: 'ord1', orderNumber: 'JO-2026-0001', companyId: 'c1', status: 'NEW', confirmationStatus: 'NEW',
  createdAt: new Date(NOW.getTime() - 60_000), currency: 'JOD', landingPageId: 'lp1', productId: 'p1',
  items: [{ productId: 'p1' }], store: { country: { minorUnit: 3 } }, _count: { contactAttempts: 0 },
};
const liveOffer = {
  id: 'of1', name: 'علبة كمان', quantity: 1, freeQuantity: 0, sellingPrice: 25, discount: 10,
  compareAtPrice: null, isDefault: false, deliveryIncluded: true, endsAt: null,
};

const order = (over: Record<string, unknown> = {}) => ({ ...ORDER, ...over });
const press = () => addPostOrderOffer({ orderId: 'ord1', orderNumber: 'JO-2026-0001', offerId: 'of1', now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.company.findUnique.mockResolvedValue({ settings: null });
  dbMock.orderAddOn.count.mockResolvedValue(0);
  dbMock.order.findFirst.mockResolvedValue(ORDER);
  dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(dbMock));
  dbMock.orderAddOn.create.mockResolvedValue({ id: 'a1', productName: 'علبة', quantity: 1, price: 15, total: 15 });
  dbMock.order.update.mockResolvedValue({ orderNumber: 'JO-2026-0001', totalAmount: 40, currency: 'JOD' });
  dbMock.offer.findFirst.mockResolvedValue({ id: 'of1', productId: 'p1', product: { id: 'p1', name: 'علبة', status: 'ACTIVE' } });
  dbMock.offer.findMany.mockResolvedValue([liveOffer]);
});

describe('the lock', () => {
  it('is the first thing the transaction does, and it moves the version and nothing else', async () => {
    const r = await press();
    expect(r.ok).toBe(true);
    expect(dbMock.order.update.mock.calls[0][0]).toMatchObject({ where: { id: 'ord1' }, data: { version: { increment: 1 } } });
    // The money is the SECOND write, after the checks the lock made safe.
    expect(dbMock.order.update.mock.calls[1][0].data).toEqual({ totalAmount: { increment: 15 } });
  });

  it('the press that finds the other\'s add-on once it has the row is told «already added» and writes nothing', async () => {
    // The first read (before the lock) saw none; under the lock the first press\'s add-on is there.
    dbMock.orderAddOn.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const r = await press();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ALREADY_ADDED');
    expect(dbMock.orderAddOn.create).not.toHaveBeenCalled();
    expect(dbMock.landingPage.update).not.toHaveBeenCalled();
    // Only the lock was taken: the total did not move.
    expect(dbMock.order.update).toHaveBeenCalledTimes(1);
  });

  it('an order confirmed between the first read and the lock is refused with the confirmation\'s own sentence', async () => {
    dbMock.order.findFirst.mockResolvedValueOnce(ORDER).mockResolvedValueOnce(order({ confirmationStatus: 'CONFIRMED' }));
    const r = await press();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_NEW');
    expect(dbMock.orderAddOn.create).not.toHaveBeenCalled();
    expect(dbMock.order.update).toHaveBeenCalledTimes(1);
  });

  it('and one called about in that gap is refused as «contacted»', async () => {
    dbMock.order.findFirst.mockResolvedValueOnce(ORDER).mockResolvedValueOnce(order({ _count: { contactAttempts: 1 } }));
    const r = await press();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('CONTACTED');
  });

  it('NEGATIVE: an order that stayed untouched takes the add-on once, and the total moves by exactly the bundle', async () => {
    const r = await press();
    expect(r.ok).toBe(true);
    expect(dbMock.orderAddOn.create).toHaveBeenCalledTimes(1);
    expect(dbMock.order.update).toHaveBeenCalledTimes(2);
  });

  it('NEGATIVE: a refusal before the transaction (the gates) never takes the lock', async () => {
    dbMock.order.findFirst.mockResolvedValue(order({ _count: { contactAttempts: 2 } }));
    const r = await press();
    expect(r.ok).toBe(false);
    expect(dbMock.$transaction).not.toHaveBeenCalled();
    expect(dbMock.order.update).not.toHaveBeenCalled();
  });
});
