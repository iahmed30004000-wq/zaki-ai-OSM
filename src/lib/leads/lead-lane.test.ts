import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE LEAD LANE (step E2)
 *
 *  1. The lane is the store's NEW leads, oldest first, each with the LIVE offers of its product and the 24-hour flag; nothing else is in it.
 *  2. A conversion makes a NORMAL order only through the existing landing door, with an OFFER of the product (never a typed price) and the address the agent took; an offer that is not live is
 *     refused before the door is touched.
 *  3. The ad pair rides along: utm_campaign as the door's campaign (cut to the door's 40), utm_content stamped on the order's `adId` AFTER it exists, never over an ad already there.
 *  4. The lead is CONVERTED only once the order exists; a refusal of the door leaves it NEW (still in the lane).
 *  5. Dismissing takes only a NEW lead of this store.
 * ═════════════════════════════════════════════════════════════════
 */
const { door, offers } = vi.hoisted(() => ({
  door: vi.fn(async (..._a: unknown[]) => ({ ok: true, body: { orderNumber: 'LP-1001' } }) as unknown),
  offers: vi.fn(async (..._a: unknown[]) => new Map<string, unknown[]>([['p1', [{ id: 'o1', name: 'قطعتين', price: 40 }]]])),
}));
vi.mock('../v1/landing-door', () => ({ takeLandingOrder: (...a: unknown[]) => door(...a) }));
vi.mock('../offers', () => ({ activeOffersForProducts: (...a: unknown[]) => offers(...a) }));
vi.mock('../db', () => ({ db: {} }));

import { convertLead, dismissLead, readLeadLane } from './lead-lane';

const SCOPE = { companyId: 'c1', storeId: 's1' };
const LEAD = { id: 'L1', companyId: 'c1', storeId: 's1', fullName: 'سارة', phone: '0933620102', city: 'دمشق', productId: 'p1', utmCampaign: 'x'.repeat(60), utmContent: 'ad77', status: 'NEW' };

function client(over: Record<string, unknown> = {}) {
  return {
    lead: {
      findMany: vi.fn(async () => [{ ...LEAD, receivedAt: new Date(1), recentOrderId: null }, { ...LEAD, id: 'L2', receivedAt: new Date(2), recentOrderId: 'o9' }]),
      findFirst: vi.fn(async () => LEAD),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    product: { findMany: vi.fn(async () => [{ id: 'p1', name: 'منتج' }]) },
    order: { updateMany: vi.fn(async () => ({ count: 1 })) },
    ...over,
  } as never;
}
const input = { leadId: 'L1', offerId: 'o1', address: 'المزة، شارع 5' };

beforeEach(() => {
  vi.clearAllMocks();
  door.mockResolvedValue({ ok: true, body: { orderNumber: 'LP-1001' } });
});

describe('the lane (rule 1)', () => {
  it('asks only this store\'s NEW leads, oldest first, and attaches offers, product name and the flag', async () => {
    const c = client();
    const lane = await readLeadLane(c, SCOPE, 2, new Date());
    const where = (c as any).lead.findMany.mock.calls[0][0];
    expect(where.where).toEqual({ companyId: 'c1', storeId: 's1', status: 'NEW' });
    expect(where.orderBy).toEqual({ receivedAt: 'asc' });
    expect(lane.map((l) => [l.id, l.productName, l.recentOrder, l.offers.length])).toEqual([['L1', 'منتج', false, 1], ['L2', 'منتج', true, 1]]);
  });

  it('an empty lane reads nothing else', async () => {
    const c = client();
    (c as any).lead.findMany.mockResolvedValueOnce([]);
    expect(await readLeadLane(c, SCOPE, 2, new Date())).toEqual([]);
    expect(offers).not.toHaveBeenCalled();
  });
});

describe('a conversion (rules 2-4)', () => {
  it('goes through the landing door with the offer, the address and the lead\'s own words — no price anywhere', async () => {
    const c = client();
    const r = await convertLead(c, SCOPE, input, 2);
    expect(r).toEqual({ ok: true, orderNumber: 'LP-1001' });
    const [company, sent] = door.mock.calls[0] as [string, Record<string, unknown>];
    expect(company).toBe('c1');
    expect(sent).toMatchObject({ productId: 'p1', offerId: 'o1', landingPageId: 'lead-L1', full_name: 'سارة', phone: '0933620102', address: 'المزة، شارع 5', city: 'دمشق' });
    expect(Object.keys(sent).some((k) => /price|total|discount|amount/i.test(k))).toBe(false);
  });

  it('refuses an offer that is not a live offer of the product — the door is not touched', async () => {
    const c = client();
    const r = await convertLead(c, SCOPE, { ...input, offerId: 'made-up' }, 2);
    expect(r).toMatchObject({ ok: false, code: 'OFFER_NOT_LIVE', status: 409 });
    expect(door).not.toHaveBeenCalled();
    expect((c as any).lead.updateMany).not.toHaveBeenCalled();
  });

  it('a lead that is not NEW (or not this store\'s) is 404 and nothing is made', async () => {
    const c = client();
    (c as any).lead.findFirst.mockResolvedValueOnce(null);
    expect(await convertLead(c, SCOPE, input, 2)).toMatchObject({ ok: false, code: 'LEAD_NOT_FOUND', status: 404 });
    expect(door).not.toHaveBeenCalled();
  });

  it('carries the ad pair: the campaign cut to 40, and utm_content on the order AFTER it exists, never over an ad already there', async () => {
    const c = client();
    await convertLead(c, SCOPE, input, 2);
    expect((door.mock.calls[0][1] as { campaign: string }).campaign).toHaveLength(40);
    expect((c as any).order.updateMany).toHaveBeenCalledWith({ where: { companyId: 'c1', orderNumber: 'LP-1001', adId: null }, data: { adId: 'ad77' } });
    const order = (c as any).order.updateMany.mock.invocationCallOrder[0];
    expect(order).toBeGreaterThan(door.mock.invocationCallOrder[0]);
  });

  it('a failed ad stamp does not fail the conversion', async () => {
    const c = client();
    (c as any).order.updateMany.mockRejectedValueOnce(new Error('boom'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await convertLead(c, SCOPE, input, 2)).toMatchObject({ ok: true });
    quiet.mockRestore();
  });

  it('marks the lead CONVERTED only after the order exists, and only if it is still NEW', async () => {
    const c = client();
    await convertLead(c, SCOPE, input, 2);
    expect((c as any).lead.updateMany).toHaveBeenCalledWith({ where: { id: 'L1', companyId: 'c1', status: 'NEW' }, data: { status: 'CONVERTED' } });
    expect((c as any).lead.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(door.mock.invocationCallOrder[0]);
  });

  it('a refusal of the door leaves the lead NEW and says why', async () => {
    door.mockResolvedValueOnce({ ok: false, status: 409, body: { error: 'هذا العرض لم يعد متاحًا' } });
    const c = client();
    const r = await convertLead(c, SCOPE, input, 2);
    expect(r).toMatchObject({ ok: false, code: 'DOOR_REFUSED', status: 409, message: 'هذا العرض لم يعد متاحًا' });
    expect((c as any).lead.updateMany).not.toHaveBeenCalled();
    expect((c as any).order.updateMany).not.toHaveBeenCalled();
  });
});

describe('dismissing (rule 5)', () => {
  it('takes only a NEW lead of this store', async () => {
    const c = client();
    expect(await dismissLead(c, SCOPE, 'L1')).toBe(true);
    expect((c as any).lead.updateMany).toHaveBeenCalledWith({ where: { id: 'L1', companyId: 'c1', storeId: 's1', status: 'NEW' }, data: { status: 'DISMISSED' } });
    (c as any).lead.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await dismissLead(c, SCOPE, 'gone')).toBe(false);
  });
});
