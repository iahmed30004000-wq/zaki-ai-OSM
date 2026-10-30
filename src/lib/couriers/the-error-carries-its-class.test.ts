import { describe, expect, it, vi } from 'vitest';
import { LogesTechsAdapter } from './logestechs';
import { errorClassOfHttpStatus, type CourierEvent } from './types';
import { isAnOutage, outageReason } from './outage';

/**
 * «THE COMPANY IS NOT AVAILABLE» HAS THREE CAUSES, AND THE ADAPTER NOW SAYS WHICH (RV146).
 *
 * `fetchEvents` used to turn every failure into the same `rawStatus: 'ERROR'`, so the outage detector could not tell
 * «404: I do not know this barcode» from «503: I am down» from «403: your account is refused». The event now carries
 * `errorClass`. All simulated: a fetch stub, no call to any company.
 */

const adapterWith = (fetchImpl: typeof fetch) =>
  new LogesTechsAdapter({
    email: 'a@b.c', password: 'x', companyId: 136, serviceTypeId: 1, vehicleTypeId: 0,
    sender: { name: 'متجر', phone: '0790000000', businessName: 'متجر' },
    origin: { addressLine1: 'Main Street', cityId: 36237 },
    fetchImpl,
  });
const answering = (status: number, body = 'x') => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

describe('the class of a failed question', () => {
  it.each([
    [404, 'UNKNOWN_PARCEL'],
    [400, 'REFUSED'], [401, 'REFUSED'], [403, 'REFUSED'], [429, 'REFUSED'],
    [500, 'UNREACHABLE'], [502, 'UNREACHABLE'], [503, 'UNREACHABLE'],
  ] as const)('an HTTP %i is %s', async (status, expected) => {
    const [event] = await adapterWith(answering(status)).fetchEvents(['KSA1']);
    expect(event.rawStatus).toBe('ERROR');
    expect(event.errorClass).toBe(expected);
    expect(errorClassOfHttpStatus(status)).toBe(expected);
  });

  it('no network at all is UNREACHABLE', async () => {
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const [event] = await adapterWith(down).fetchEvents(['KSA1']);
    expect(event.errorClass).toBe('UNREACHABLE');
  });

  it('a 200 whose body is not JSON is UNREACHABLE — the company did not answer properly', async () => {
    const [event] = await adapterWith(answering(200, '<html>maintenance</html>')).fetchEvents(['KSA1']);
    expect(event.rawStatus).toBe('ERROR');
    expect(event.errorClass).toBe('UNREACHABLE');
  });

  it('NEGATIVE: a good answer carries no class at all', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ status: 'SCANNED_BY_DRIVER_AND_IN_CAR' }), { status: 200 })) as unknown as typeof fetch;
    const [event] = await adapterWith(ok).fetchEvents(['KSA1']);
    expect(event.rawStatus).toBe('SCANNED_BY_DRIVER_AND_IN_CAR');
    expect(event.errorClass).toBeUndefined();
  });
});

describe('the first chunk, and the reason it is given', () => {
  const err = (errorClass?: CourierEvent['errorClass']): CourierEvent => ({
    trackingNumber: 'B', rawStatus: 'ERROR', occurredAt: new Date(), status: null, ...(errorClass ? { errorClass } : {}),
  });
  const answer = (): CourierEvent => ({ trackingNumber: 'B', rawStatus: 'SHIPPED', occurredAt: new Date(), status: 'SHIPPED' });

  it('all «not found» is an outage whose reason says the company knows none of them', () => {
    const chunk = Array.from({ length: 10 }, () => err('UNKNOWN_PARCEL'));
    expect(isAnOutage(chunk)).toBe(true);
    expect(outageReason(chunk)).toBe('ردّت «غير موجود» على أول 10 باركودات كلها');
  });

  it('a refused account and a company that does not answer are told apart', () => {
    expect(outageReason([err('REFUSED'), err('REFUSED')])).toBe('رفضت الطلب أو الحساب');
    expect(outageReason([err('UNREACHABLE'), err('UNREACHABLE')])).toBe('لا تردّ');
    // Mixed, or an adapter that does not say: the cautious wording.
    expect(outageReason([err('UNKNOWN_PARCEL'), err('UNREACHABLE')])).toBe('لا تردّ');
    expect(outageReason([err(), err()])).toBe('لا تردّ');
  });

  it('NEGATIVE: one error among answers is a miss, not an outage; one lone error is not enough either', () => {
    expect(isAnOutage([err('UNKNOWN_PARCEL'), answer(), answer()])).toBe(false);
    expect(isAnOutage([err('UNKNOWN_PARCEL')])).toBe(false);
    expect(isAnOutage([])).toBe(false);
  });
});
