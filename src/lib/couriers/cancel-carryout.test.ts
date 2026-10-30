import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE MESSAGE TO THE COURIER KEEPS ITS EXPLANATION.
 *
 * A cancellation raised with its structured reason is carried out, on a parcel
 * the company holds, as a message to the company. «سبب آخر» alone tells them
 * nothing, so for «أخرى» the sentence the request was raised with goes beside
 * it. Every other reason is its own words, as before.
 */

const { db } = vi.hoisted(() => ({
  db: { deliveryProvider: { findFirst: vi.fn<(...a: unknown[]) => Promise<{ name: string; phone: string | null } | null>>() } },
}));
vi.mock('../db', () => ({ db }));
vi.mock('../audit', () => ({ logAudit: vi.fn() }));
vi.mock('../notify', () => ({ notify: vi.fn() }));

import { courierCancelCarryOut, reasonForCourier } from './cancel-carryout';

const SAID = 'الزبون سافر خارج البلد';

describe('reasonForCourier', () => {
  it('«أخرى» carries the sentence beside it', () => {
    expect(reasonForCourier({ cancelReason: 'OTHER', reason: ` ${SAID} ` })).toBe('سبب آخر: ' + SAID);
  });

  it('every other structured reason is its own words, with no sentence added', () => {
    expect(reasonForCourier({ cancelReason: 'CUSTOMER_CHANGED_MIND', reason: SAID })).not.toContain(SAID);
    expect(reasonForCourier({ cancelReason: 'CUSTOMER_CHANGED_MIND', reason: SAID })).toBeTruthy();
  });

  it('a request with no reason stored falls back to the customer’s sentence, as before', () => {
    expect(reasonForCourier({ cancelReason: null, reason: SAID })).toBe(SAID);
  });
});

describe('the message actually sent', () => {
  beforeEach(() => {
    db.deliveryProvider.findFirst.mockResolvedValue({ name: 'شركة', phone: '0777' });
  });

  const ask = async (cancelReason: string | null) =>
    courierCancelCarryOut({
      companyId: 'c1', storeId: 's1', user: { id: 'u1', name: 'المدير' }, courierNotified: false,
      order: { id: 'o1', orderNumber: 'SY-5', trackingNumber: 'BC-77', deliveryProviderId: 'p1' },
      request: { id: 'r1', requestedById: 'a1', reason: SAID, cancelReason },
    });

  it('for «أخرى» the text to the company contains the sentence', async () => {
    const out = await ask('OTHER');

    expect(out.status).toBe(409);
    expect(String(out.body.message)).toContain('سبب آخر: ' + SAID);
  });

  it('NEGATIVE: for a plain reason the message does not carry the sentence', async () => {
    const out = await ask('CUSTOMER_CHANGED_MIND');

    expect(String(out.body.message)).not.toContain(SAID);
  });
});
