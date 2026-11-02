import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHOEVER TYPES AN ORDER AND CONFIRMS IT IS PAID ONCE (T-06, «الزبون على الخط — أكّده الآن»).
 *
 * An agent who types an order with the box ticked is its responsible moderator (`responsible-moderator.ts`: she does not hand
 * orders out) AND its confirmer (the confirmation door stamps `confirmedById`). The ledger's two parties are then ONE person:
 * `accrueForOrder` drops the confirmer whose id is the moderator's, takes one rule for her, and a second run finds her entry.
 * No commission code changes in T-06; this file pins the rule the new path leans on — nothing asserted it before.
 *
 * The worked example of the design: rules — CONFIRMATION_AGENT 5% per order, MODERATOR 1.000 JOD per order. An order of 45 JOD,
 * delivery included, the courier's fee 3 JOD: the sale is 42.000.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn() },
    commissionRule: { findMany: vi.fn() },
    commissionEntry: { findFirst: vi.fn(), create: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { accrueForOrder, type RuleLike } from './commission';

const base = { effectiveFrom: new Date('2026-01-01'), effectiveTo: null, isActive: true, appliesToUserId: null } as const;
const RULES: RuleLike[] = [
  { ...base, id: 'r-agent', appliesToRole: 'CONFIRMATION_AGENT', type: 'PERCENT', value: 5 },
  { ...base, id: 'r-mod', appliesToRole: 'MODERATOR', type: 'FIXED', value: 1 },
];

const ABEER = { id: 'abeer', role: 'CONFIRMATION_AGENT', commissionCurrency: null };
const MONA = { id: 'mona', role: 'MODERATOR', commissionCurrency: null };

const order = (moderator: typeof ABEER, confirmer: typeof ABEER) => ({
  id: 'o45', storeId: 's1', shippingStatus: 'DELIVERED', deliveredAt: new Date('2026-11-05'), currency: 'JOD',
  totalAmount: 45, deliveryFee: 3, priceIncludesDelivery: true,
  moderatorId: moderator.id, claimedById: confirmer.id, confirmedById: confirmer.id,
  moderator, confirmer,
});

/** What the ledger holds, entry by entry. */
const entries = () => db.commissionEntry.create.mock.calls.map((c) => ({ userId: c[0].data.userId, amount: c[0].data.amount, ruleId: c[0].data.ruleId }));

beforeEach(() => {
  vi.clearAllMocks();
  db.commissionRule.findMany.mockResolvedValue(RULES);
  db.commissionEntry.findFirst.mockResolvedValue(null);
  db.commissionEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'e', ...data }));
});

const accrue = () => accrueForOrder(db as never, { companyId: 'c1', orderId: 'o45', minorUnit: 3 });

describe('the 45 JOD order', () => {
  it('BEFORE (Mona types, Abeer pulls and confirms): two people worked it — two entries, 1.000 + 2.100', async () => {
    db.order.findFirst.mockResolvedValue(order(MONA, ABEER));
    const r = await accrue();
    expect(r.created).toBe(2);
    expect(entries()).toEqual([
      { userId: 'mona', amount: 1, ruleId: 'r-mod' },
      { userId: 'abeer', amount: 2.1, ruleId: 'r-agent' },
    ]);
  });

  it('AFTER (Abeer types it with «أكّده الآن» and confirms it): ONE entry, 2.100, by the agent rule', async () => {
    db.order.findFirst.mockResolvedValue(order(ABEER, ABEER));
    const r = await accrue();
    expect(r).toMatchObject({ created: 1, amount: 2.1 });
    expect(entries()).toEqual([{ userId: 'abeer', amount: 2.1, ruleId: 'r-agent' }]);
  });

  it('and the accrual job running a second time pays her nothing more', async () => {
    db.order.findFirst.mockResolvedValue(order(ABEER, ABEER));
    await accrue();
    db.commissionEntry.findFirst.mockResolvedValue({ id: 'already' });
    db.commissionEntry.create.mockClear();
    const again = await accrue();
    expect(again.created).toBe(0);
    expect(db.commissionEntry.create).not.toHaveBeenCalled();
  });
});
