import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «شغلي» ASKS ITS COUNTS TOGETHER, NOT ONE BEHIND THE OTHER (RV181).
 *
 * Eleven counts, awaited in a row, are eleven round trips whose answers nobody needed in order. The numbers are unchanged;
 * the poll now waits for its slowest count instead of the sum of all of them. This holds both halves: that they start
 * together, and that every number still lands under its own key.
 */

const { db, requireContext, waitingCount, awaitingConfirmationCount, grants } = vi.hoisted(() => ({
  db: {
    order: { count: vi.fn(), findMany: vi.fn() },
    orderChangeRequest: { count: vi.fn() },
    orderIssue: { count: vi.fn() },
    courierStatement: { count: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  waitingCount: vi.fn(),
  awaitingConfirmationCount: vi.fn(),
  grants: { allows: (_p: string): boolean => true },
}));
vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: (...a: unknown[]) => requireContext(...a),
  ContextError: class extends Error {},
}));
vi.mock('@/lib/authorization', () => ({ can: (_u: unknown, p: string) => grants.allows(p) }));
vi.mock('@/lib/confirmation-queue', () => ({
  POSTPONE_LEAD_DAYS: 2,
  waitingCount: (...a: unknown[]) => waitingCount(...a),
  awaitingConfirmationCount: (...a: unknown[]) => awaitingConfirmationCount(...a),
}));

import { GET } from './route';

/** A promise that stays pending until `open()` — to see who has started while nobody has finished. */
function gate<T>(value: T) {
  let open!: () => void;
  const p = new Promise<T>((resolve) => {
    open = () => resolve(value);
  });
  return { p, open };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u' }, companyId: 'c', storeId: 's' });
  grants.allows = () => true;
  db.order.findMany.mockResolvedValue([]);
  db.deliveryFee.findMany.mockResolvedValue([]);
});

describe('the counts start together', () => {
  it('— every count has been asked before the first one has answered', async () => {
    const g = gate(7);
    waitingCount.mockReturnValue(g.p);
    awaitingConfirmationCount.mockReturnValue(g.p);
    db.order.count.mockReturnValue(g.p);
    db.orderChangeRequest.count.mockReturnValue(g.p);
    db.orderIssue.count.mockReturnValue(g.p);
    db.courierStatement.count.mockReturnValue(g.p);

    const pending = GET();
    await flush();

    // None of them can have answered yet — and all of them have been asked.
    expect(waitingCount).toHaveBeenCalledTimes(1);
    // someone who pulls from the pool is not also shown «طلباتي غير المؤكَّدة» (kindsFor) — so that one is not asked
    expect(awaitingConfirmationCount).not.toHaveBeenCalled();
    expect(db.order.count).toHaveBeenCalledTimes(4); // ready to ship · returns · to prepare · postponed
    expect(db.orderChangeRequest.count).toHaveBeenCalledTimes(1);
    expect(db.orderIssue.count).toHaveBeenCalledTimes(1);
    expect(db.courierStatement.count).toHaveBeenCalledTimes(1);
    expect(db.deliveryFee.findMany).toHaveBeenCalledTimes(1);

    g.open();
    expect((await pending).status).toBe(200);
  });

  it('— and each number still lands under its own key', async () => {
    waitingCount.mockResolvedValue(1);
    awaitingConfirmationCount.mockResolvedValue(2);
    grants.allows = (p) => p !== 'confirmation.pull' && p !== 'confirmation.supervise';
    db.orderChangeRequest.count.mockResolvedValue(3);
    db.orderIssue.count.mockResolvedValue(4);
    db.courierStatement.count.mockResolvedValue(5);
    // ready to ship · returns · to prepare · postponed, in the order they are asked
    db.order.count.mockResolvedValueOnce(6).mockResolvedValueOnce(7).mockResolvedValueOnce(8).mockResolvedValueOnce(9);

    const items = ((await (await GET()).json()) as { items: { key: string; count: number }[] }).items;
    const by = Object.fromEntries(items.map((i) => [i.key, i.count]));
    expect(by.CONFIRM_POOL, 'من لا يسحب لا يرى الطابور').toBeUndefined();
    expect(waitingCount).not.toHaveBeenCalled();
    expect(by).toMatchObject({
      MY_UNCONFIRMED: 2, CHANGE_REQUESTS: 3, ISSUES_OPEN: 4, STATEMENTS_OPEN: 5,
      READY_TO_SHIP: 6, RETURNS_WAITING: 7, TO_PREPARE: 8, POSTPONED_DUE: 9, LATE_SHIPMENTS: 0,
    });
  });

  it('— a number past the ceiling is still «كثير», 999', async () => {
    waitingCount.mockResolvedValue(5000);
    awaitingConfirmationCount.mockResolvedValue(0);
    db.order.count.mockResolvedValue(0);
    db.orderChangeRequest.count.mockResolvedValue(0);
    db.orderIssue.count.mockResolvedValue(0);
    db.courierStatement.count.mockResolvedValue(0);
    const items = ((await (await GET()).json()) as { items: { key: string; count: number }[] }).items;
    expect(items.find((i) => i.key === 'CONFIRM_POOL')?.count).toBe(999);
  });

  it('— NEGATIVE: one count failing fails the poll as before, never a half-true answer', async () => {
    waitingCount.mockResolvedValue(1);
    awaitingConfirmationCount.mockResolvedValue(1);
    db.order.count.mockResolvedValue(1);
    db.orderChangeRequest.count.mockRejectedValue(new Error('db down'));
    db.orderIssue.count.mockResolvedValue(1);
    db.courierStatement.count.mockResolvedValue(1);
    const res = await GET();
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('— NEGATIVE: a person who is shown no card asks the database nothing', async () => {
    // The route asks `can` per permission through kindsFor; with no grants there are no kinds.
    grants.allows = () => false;
    const res = await GET();
    expect(await res.json()).toEqual({ items: [] });
    expect(db.order.count).not.toHaveBeenCalled();
    expect(waitingCount).not.toHaveBeenCalled();
  });
});
