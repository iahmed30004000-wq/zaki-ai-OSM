import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * META HEARS THE CLICK A LANDING-PAGE ORDER CAME FROM (the owner's item 1; contract oms-lp.v1 §4).
 *
 * The confirmed and delivered conversions this system sends (`deliverConversion`) matched a landing-page sale on the
 * hashed phone, name and city only: the visitor's click cookie, browser cookie and browser never reached the OMS. The
 * landing door now keeps them (`v1/landing-attribution.ts`, the cookies sealed), and the sender opens them into
 * Meta's `user_data` — `fbc`, `fbp`, `client_user_agent`, as Meta specifies them: plain, not hashed.
 *
 * Held here: present → sent; absent (every order from another door) → omitted, nothing empty sent; a sealed value that
 * cannot be opened → left out, and the event still goes; the event keeps its OWN id, never the landing system's.
 */

const { db, sendEvents } = vi.hoisted(() => ({
  db: { conversionDelivery: { findUnique: vi.fn(), update: vi.fn() } },
  sendEvents: vi.fn(),
}));
vi.mock('../db', () => ({ db }));
vi.mock('./meta-capi', async (orig) => ({
  ...(await orig<typeof import('./meta-capi')>()),
  sendEvents: (...a: unknown[]) => sendEvents(...a),
}));

import { encryptSecret } from '../secrets';
import { deliverConversion } from './emit';

const FBC = 'fb.1.1763380000000.IwAR2abcDEF';
const FBP = 'fb.1.1763380000000.1234567890';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';

function row(order: object) {
  return {
    id: 'd1', eventId: 'conv0001.o1', attempts: 0,
    conversion: {
      eventName: 'OrderDelivered', trigger: 'order.delivered', valueSource: 'COLLECTED_AMOUNT',
      pixel: { pixelId: '111111111111111', capiDatasetId: null, capiToken: encryptSecret('TOKEN'), capiTestCode: null, platform: 'META' },
    },
    order: {
      id: 'o1', orderNumber: 'JO-2026-0007', totalAmount: 22, collectedAmount: null, currency: 'JOD',
      createdAt: new Date(), confirmedAt: new Date(), deliveredAt: new Date(),
      productId: 'p1', landingPageId: null, landingPage: null, country: { code: 'JO' },
      customer: { id: 'c1', fullName: 'زبون تجريبي', phone: '790000001', rawPhone: null, city: 'عمّان' },
      fbcEnc: null, fbpEnc: null, clientUserAgent: null, lpPurchaseEventId: null,
      ...order,
    },
  };
}
const sent = () => sendEvents.mock.calls[0][2][0] as { event_id: string; user_data: Record<string, unknown> };

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = 'b'.repeat(64);
});

beforeEach(() => {
  vi.clearAllMocks();
  db.conversionDelivery.update.mockResolvedValue({});
  sendEvents.mockResolvedValue({ received: 1, traceId: 't' });
});

describe('the delivered / confirmed event of a landing-page order', () => {
  it('carries the click cookie, the browser cookie and the browser, opened from their seal', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row({ fbcEnc: encryptSecret(FBC), fbpEnc: encryptSecret(FBP), clientUserAgent: UA }));
    expect(await deliverConversion('d1')).toBe(true);
    expect(sent().user_data).toMatchObject({ fbc: FBC, fbp: FBP, client_user_agent: UA });
    // The phone is still there: the click is added to the match, it does not replace it.
    expect(sent().user_data.ph).toHaveLength(1);
  });

  it('keeps its own event id, never the landing system’s Purchase id', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row({ fbcEnc: encryptSecret(FBC), lpPurchaseEventId: 'ev-5f1c2d' }));
    await deliverConversion('d1');
    expect(sent().event_id).toBe('conv0001.o1');
    expect(JSON.stringify(sendEvents.mock.calls)).not.toContain('ev-5f1c2d');
  });

  it('reads them in the query', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row({}));
    await deliverConversion('d1');
    const select = db.conversionDelivery.findUnique.mock.calls[0][0].select.order.select;
    expect(select).toMatchObject({ fbcEnc: true, fbpEnc: true, clientUserAgent: true });
  });

  it('NEGATIVE: an order from any other door has none of them, and none is sent — not even empty', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row({}));
    expect(await deliverConversion('d1')).toBe(true);
    for (const k of ['fbc', 'fbp', 'client_user_agent']) expect(sent().user_data, k).not.toHaveProperty(k);
  });

  it('NEGATIVE: a sealed value that cannot be opened is left out, and the sale still reaches Meta', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row({ fbcEnc: 'v1:not:a:seal', fbpEnc: encryptSecret(FBP), clientUserAgent: UA }));
    expect(await deliverConversion('d1')).toBe(true);
    expect(sent().user_data).not.toHaveProperty('fbc');
    expect(sent().user_data).toMatchObject({ fbp: FBP, client_user_agent: UA });
  });
});
