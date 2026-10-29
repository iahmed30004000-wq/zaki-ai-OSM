import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ط36 — META RECEIVES THE CUSTOMER'S PHONE AND COUNTRY FROM THE ORDER'S COUNTRY.
 *
 * `deliverConversion` passed no dial code (the phone fell back to Jordan's 962 — a Syrian 0944123456, stored as
 * 944123456, was hashed as 962944123456) and read `Customer.country`, which no door ever sets, so every row said «EG».
 * Meta matched nothing on phone and country, and the match-quality score looked fine because the fields were present.
 * The ORDER's country decides both now. Fixtures use `country: 'EG'` on the customer — as production does — so a
 * regression to reading it fails here.
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — decided: the order's country only; the browser's user agent and click ids
 * are NOT captured (that changes order creation and stores addresses — the owner's call).
 */

const { db, sendEvents } = vi.hoisted(() => ({
  db: { conversionDelivery: { findUnique: vi.fn(), update: vi.fn() } },
  sendEvents: vi.fn(),
}));
vi.mock('../db', () => ({ db }));
vi.mock('../secrets', () => ({ decryptSecret: () => 'TOKEN' }));
vi.mock('./meta-capi', async (orig) => ({
  ...(await orig<typeof import('./meta-capi')>()),
  sendEvents: (...a: unknown[]) => sendEvents(...a),
}));

import { deliverConversion } from './emit';
import { buildUserData, customerPhoneFacts } from './hash';

const sha = (v: string) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

function row(countryCode: string | null, phone: string) {
  return {
    id: 'd1', eventId: 'e1', attempts: 0,
    conversion: {
      eventName: 'Purchase', trigger: 'order.confirmed', valueSource: 'ORDER_TOTAL',
      pixel: { pixelId: '111111111111111', capiDatasetId: null, capiToken: 'enc', capiTestCode: null, platform: 'META' },
    },
    order: {
      id: 'o1', orderNumber: 'X-1', totalAmount: 25, collectedAmount: null, currency: 'SYP',
      createdAt: new Date(), confirmedAt: new Date(), deliveredAt: null,
      productId: 'p1', landingPageId: null, landingPage: null,
      country: countryCode ? { code: countryCode } : null,
      // `country: 'EG'` — the column default, on every real row.
      customer: { id: 'c1', fullName: 'أحمد', phone, rawPhone: null, city: 'دمشق', country: 'EG' },
    },
  };
}

const sentUserData = () => sendEvents.mock.calls[0][2][0].user_data as { ph?: string[]; country?: string[] };

beforeEach(() => {
  vi.clearAllMocks();
  db.conversionDelivery.update.mockResolvedValue({});
  sendEvents.mockResolvedValue({ received: 1, traceId: 't' });
});

describe('the event Meta receives', () => {
  it('a Syrian customer of a Syrian store: Syria\'s dial code and «sy»', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row('SY', '944123456'));
    await deliverConversion('d1');
    expect(sentUserData().ph).toEqual([sha('963944123456')]);
    expect(sentUserData().country).toEqual([sha('sy')]);
  });

  it('a Jordanian customer of a Jordanian store: 962 and «jo» — and not «eg» from the customer row', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row('JO', '791234567'));
    await deliverConversion('d1');
    expect(sentUserData().ph).toEqual([sha('962791234567')]);
    expect(sentUserData().country).toEqual([sha('jo')]);
    expect(sentUserData().country).not.toEqual([sha('eg')]);
  });

  it('a foreign number kept whole (a Jordanian line ordering from a Syrian store) does not get Syria\'s code in front of its own', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row('SY', '962791234567'));
    await deliverConversion('d1');
    expect(sentUserData().ph).toEqual([sha('962791234567')]);
    expect(sentUserData().ph).not.toEqual([sha('963962791234567')]);
  });

  it('NEGATIVE: a number already carrying its own country code is not given it twice', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row('SY', '963944123456'));
    await deliverConversion('d1');
    expect(sentUserData().ph).toEqual([sha('963944123456')]);
  });

  it('NEGATIVE: an order with no country keeps the old reading (Jordan\'s code), it does not crash', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row(null, '791234567'));
    expect(await deliverConversion('d1')).toBe(true);
    expect(sentUserData().ph).toEqual([sha('962791234567')]);
  });

  it('reads the ORDER\'s country in the query, and no longer the customer\'s', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row('SY', '944123456'));
    await deliverConversion('d1');
    const select = db.conversionDelivery.findUnique.mock.calls[0][0].select.order.select;
    expect(select.country).toEqual({ select: { code: true } });
    expect(select.customer.select.country).toBeUndefined();
  });
});

describe('customerPhoneFacts', () => {
  it('names the dial code and the country of a national number', () => {
    expect(customerPhoneFacts('944123456', 'SY')).toEqual({ phone: '944123456', country: 'sy', phoneCountryCode: '963' });
  });

  it('marks a whole foreign number as international', () => {
    expect(customerPhoneFacts('962791234567', 'SY')).toMatchObject({ phone: '962791234567', phoneInternational: true });
  });

  it('a foreign number written with a plus and spaces is hashed as its digits (the non-digits go, the letter D does not)', () => {
    expect(customerPhoneFacts('+962 79 123 4567', 'SY')).toMatchObject({ phone: '962791234567', phoneInternational: true });
    expect(buildUserData(customerPhoneFacts('+962 79 123 4567', 'SY')).ph).toEqual([sha('962791234567')]);
    // The same digits typed plainly give the same fingerprint.
    expect(buildUserData(customerPhoneFacts('962791234567', 'SY')).ph).toEqual(buildUserData(customerPhoneFacts('+962 79 123 4567', 'SY')).ph);
  });

  it('buildUserData given a whole international phone with a plus and spaces hashes its digits only', () => {
    expect(buildUserData({ phone: '+962 79 123 4567', phoneInternational: true }).ph).toEqual([sha('962791234567')]);
    expect(buildUserData({ phone: '00962-79-123-4567', phoneInternational: true }).ph).toEqual([sha('962791234567')]);
  });

  it('a national number with spaces and dashes is hashed with the stores own code', () => {
    expect(buildUserData(customerPhoneFacts('944 123-456', 'SY')).ph).toEqual([sha('963944123456')]);
  });

  it('NEGATIVE: a country with no rule, or no phone, is passed through untouched', () => {
    expect(customerPhoneFacts('791234567', 'ZZ')).toEqual({ phone: '791234567', country: 'zz' });
    expect(customerPhoneFacts(null, 'SY')).toEqual({ phone: null, country: 'sy' });
    expect(customerPhoneFacts('791234567', null)).toEqual({ phone: '791234567', country: null });
  });
});
