import { describe, expect, it, vi, beforeEach } from 'vitest';

/** Queue rules: caps, "finish what you hold", auto-release, pull priority. */

const { db } = vi.hoisted(() => ({
  db: {
    order: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('./db', () => ({ db }));

import {
  AUTO_RELEASE_BUSINESS_MINUTES,
  CLAIM_CAPS,
  pickNextCandidate,
  pullRefusal,
  releaseStaleClaims,
} from './confirmation-queue';
import { zonedTimeToInstant } from './business-calendar';

const JO = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const scope = { companyId: 'c1', storeId: 's1' };

beforeEach(() => vi.clearAllMocks());

describe('pullRefusal', () => {
  it('refuses while the agent holds an order with no logged attempt', () => {
    expect(pullRefusal({ total: 3, withoutAttempt: 1 })?.code).toBe('UNTOUCHED_ORDER');
  });

  it('refuses at the 300 owned cap', () => {
    expect(pullRefusal({ total: CLAIM_CAPS.total, withoutAttempt: 0 })?.code).toBe('CAP_TOTAL');
  });

  it('refuses at the 40 no-attempt cap', () => {
    expect(pullRefusal({ total: 50, withoutAttempt: CLAIM_CAPS.withoutAttempt })?.code).toBe('CAP_WITHOUT_ATTEMPT');
  });

  it('allows a clean agent to pull', () => {
    expect(pullRefusal({ total: 5, withoutAttempt: 0 })).toBeNull();
  });
});

describe('releaseStaleClaims', () => {
  it('releases a claim with no attempt after 90 business minutes', async () => {
    const claimedAt = zonedTimeToInstant(JO.timezone, 2026, 9, 20, 10, 0);
    const now = zonedTimeToInstant(JO.timezone, 2026, 9, 20, 11, 45); // 105 business minutes
    db.order.findMany.mockResolvedValue([{ id: 'o1', claimedAt, claimedById: 'u1', companyId: 'c1' }]);
    db.order.updateMany.mockResolvedValue({ count: 1 });

    const released = await releaseStaleClaims(db as never, scope, JO, now);
    expect(released).toBe(1);
    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ claimedById: null }) })
    );
    expect(db.orderClaimHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'RELEASED' }) })
    );
  });

  it('does not release a claim that is only old in wall-clock time', async () => {
    // Claimed Thursday 16:30, checked Sunday 09:30 = 60 business minutes.
    const claimedAt = zonedTimeToInstant(JO.timezone, 2026, 9, 17, 16, 30);
    const now = zonedTimeToInstant(JO.timezone, 2026, 9, 20, 9, 30);
    db.order.findMany.mockResolvedValue([{ id: 'o1', claimedAt, claimedById: 'u1', companyId: 'c1' }]);

    expect(await releaseStaleClaims(db as never, scope, JO, now)).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(AUTO_RELEASE_BUSINESS_MINUTES).toBe(90);
  });
});

describe('pickNextCandidate', () => {
  it('prefers a postponed order that is due within the lead days', async () => {
    db.order.findFirst.mockResolvedValueOnce({ id: 'postponed-1' });
    expect(await pickNextCandidate(db as never, scope)).toBe('postponed-1');
    expect(db.order.findFirst.mock.calls[0][0].where.confirmationStatus).toBe('POSTPONED');
  });

  it('falls back to the oldest waiting order', async () => {
    db.order.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'oldest' });
    expect(await pickNextCandidate(db as never, scope)).toBe('oldest');
    expect(db.order.findFirst.mock.calls[1][0].orderBy).toEqual({ createdAt: 'asc' });
  });

  it('never offers an order someone already claimed', async () => {
    db.order.findFirst.mockResolvedValue(null);
    await pickNextCandidate(db as never, scope);
    for (const call of db.order.findFirst.mock.calls) {
      expect(call[0].where.claimedById).toBeNull();
    }
  });
});
