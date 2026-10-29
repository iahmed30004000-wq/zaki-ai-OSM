import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «شحنة متأخّرة» ON THE DAY'S CARD IS THE FOLLOW-UP BOARD'S LATE, NOT A SECOND OPINION.
 *
 * The card carried its own copy of the arithmetic. A parcel that arrived is not late, a lane with no threshold on file
 * is never late, and a parcel that has been out longer than its lane allows is — and the card and the board's badge must
 * say the same number because they ask the same function (`transitOf`).
 */

const { db, requireContext } = vi.hoisted(() => ({
  db: {
    order: { count: vi.fn(), findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: (...a: unknown[]) => requireContext(...a),
  ContextError: class extends Error {},
}));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, p: string) => p === 'ops.track' }));
vi.mock('@/lib/confirmation-queue', () => ({
  POSTPONE_LEAD_DAYS: 2,
  waitingCount: vi.fn(async () => 0),
  awaitingConfirmationCount: vi.fn(async () => 0),
}));

import { GET } from './route';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const row = (over: Record<string, unknown> = {}) => ({
  shippedAt: ago(10), regionId: 'r1', deliveryProviderId: 'p1', shippingStatus: 'SHIPPED', deliveredAt: null, returnedAt: null, ...over,
});

const lateCount = async () => {
  const items = ((await (await GET()).json()) as { items: { key: string; count: number }[] }).items;
  return items.find((i) => i.key === 'LATE_SHIPMENTS')?.count ?? 0;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u' }, companyId: 'c', storeId: 's' });
  db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r1', deliveryProviderId: 'p1', lateThresholdDays: 3 }]);
});

describe('the day’s late card', () => {
  it('— counts a parcel on the road past its lane’s time', async () => {
    db.order.findMany.mockResolvedValue([row()]);
    expect(await lateCount()).toBe(1);
  });

  it('— does not count one inside its time, or one on a lane nobody priced', async () => {
    db.order.findMany.mockResolvedValue([row({ shippedAt: ago(2) }), row({ deliveryProviderId: 'p9' })]);
    expect(await lateCount()).toBe(0);
  });

  it('— does not count a parcel that arrived or came back, however long ago it shipped', async () => {
    db.order.findMany.mockResolvedValue([row({ deliveredAt: ago(1) }), row({ returnedAt: ago(1) })]);
    expect(await lateCount()).toBe(0);
  });

  it('— and asks the database only for parcels with no delivery and no return date', async () => {
    db.order.findMany.mockResolvedValue([]);
    await lateCount();
    expect(db.order.findMany.mock.calls[0][0].where).toMatchObject({ deliveredAt: null, returnedAt: null });
  });
});
