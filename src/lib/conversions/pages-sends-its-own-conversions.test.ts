import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ZAKI PAGES SENDS ITS OWN CUSTOM CONVERSIONS — THIS SYSTEM DOES NOT SEND THEM TWICE (2026-11-21)
 *
 *  · An order with `ccSender = "pages"` (the landing door writes it from `cc_sender`) is owed nothing by this system's
 *    sender: its rows are written SKIPPED with «تُرسَل من صفحات ذكي», never PENDING, and never reach Meta.
 *  · A row queued before the door wrote the sender (at creation) is skipped by the sender itself.
 *  · Every other selling-page order — a Zaki Pages order without the flag, a store order, an OMS landing-page order —
 *    is queued and sent exactly as before.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, sendEvents } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn() },
    customConversion: { findMany: vi.fn() },
    conversionDelivery: { createMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
  sendEvents: vi.fn(),
}));
vi.mock('../db', () => ({ db }));
vi.mock('./meta-capi', async (orig) => ({
  ...(await orig<typeof import('./meta-capi')>()),
  sendEvents: (...a: unknown[]) => sendEvents(...a),
}));

import { encryptSecret } from '../secrets';
import { deliverConversion, queueConversions } from './emit';
import { PAGES_SENDS_AR } from './types';

const CONVERSION = { id: 'conv0001aaaa', pixel: { scope: 'GLOBAL', storeId: null, countryId: null } };
const order = (over: Record<string, unknown>) => ({ source: 'Landing Page', landingPageId: null, storeId: 's1', countryId: 'jo', ccSender: null, ...over });

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = 'c'.repeat(64);
});

beforeEach(() => {
  vi.clearAllMocks();
  db.customConversion.findMany.mockResolvedValue([CONVERSION]);
  db.conversionDelivery.createMany.mockImplementation(async (a: { data: unknown[] }) => ({ count: a.data.length }));
  db.conversionDelivery.update.mockResolvedValue({});
  sendEvents.mockResolvedValue({ received: 1, traceId: 't' });
});

describe('queueing', () => {
  it.each(['order.created', 'order.confirmed', 'order.delivered'] as const)(
    'a «pages» order at %s: written SKIPPED with the reason, nothing owed, nothing due',
    async (trigger) => {
      db.order.findFirst.mockResolvedValue(order({ ccSender: 'pages' }));
      expect(await queueConversions('c1', trigger, 'o1')).toBe(0);
      const [row] = db.conversionDelivery.createMany.mock.calls[0][0].data;
      expect(row).toMatchObject({ status: 'SKIPPED', nextAttemptAt: null, lastError: PAGES_SENDS_AR, orderId: 'o1' });
      // Still one row per (conversion, order), so a later attempt collapses onto it.
      expect(db.conversionDelivery.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    }
  );

  it('the sender is read in the query', async () => {
    db.order.findFirst.mockResolvedValue(order({}));
    await queueConversions('c1', 'order.confirmed', 'o1');
    expect(db.order.findFirst.mock.calls[0][0].select).toMatchObject({ ccSender: true });
  });

  it.each([
    ['a Zaki Pages order without the flag', order({})],
    ['a Zaki Pages order whose sender is «oms»', order({ ccSender: 'oms' })],
    ['a store order', order({ source: 'Store' })],
    ['an OMS landing-page order', order({ landingPageId: 'lp-own' })],
  ])('NEGATIVE: %s is queued PENDING, exactly as before', async (_n, o) => {
    db.order.findFirst.mockResolvedValue(o);
    expect(await queueConversions('c1', 'order.confirmed', 'o1')).toBe(1);
    const [row] = db.conversionDelivery.createMany.mock.calls[0][0].data;
    expect(row.status).toBe('PENDING');
    expect(row.nextAttemptAt).toBeInstanceOf(Date);
    expect(row).not.toHaveProperty('lastError');
  });

  it('NEGATIVE: an order typed in from messages is still owed nothing at all', async () => {
    db.order.findFirst.mockResolvedValue(order({ source: 'WhatsApp', ccSender: 'pages' }));
    expect(await queueConversions('c1', 'order.confirmed', 'o1')).toBe(0);
    expect(db.conversionDelivery.createMany).not.toHaveBeenCalled();
  });
});

describe('sending', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'd1', eventId: 'conv0001.o1', attempts: 0,
    conversion: {
      eventName: 'OrderConfirmed', trigger: 'order.confirmed', valueSource: 'ORDER_TOTAL',
      pixel: { pixelId: '111111111111111', capiDatasetId: null, capiToken: encryptSecret('TOKEN'), capiTestCode: null, platform: 'META' },
    },
    order: {
      id: 'o1', orderNumber: 'JO-2026-0007', totalAmount: 22, collectedAmount: null, currency: 'JOD',
      createdAt: new Date(), confirmedAt: new Date(), deliveredAt: null,
      productId: 'p1', landingPageId: null, landingPage: null, country: { code: 'JO' },
      customer: { id: 'cu1', fullName: 'زبون', phone: '790000001', rawPhone: null, city: 'عمّان' },
      fbcEnc: null, fbpEnc: null, clientUserAgent: null, ccSender: null,
      ...over,
    },
  });

  it('a row of a «pages» order queued before the flag was written is skipped, and Meta hears nothing', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row({ ccSender: 'pages' }));
    expect(await deliverConversion('d1')).toBe(false);
    expect(sendEvents).not.toHaveBeenCalled();
    expect(db.conversionDelivery.update.mock.calls[0][0].data).toMatchObject({ status: 'SKIPPED', nextAttemptAt: null, lastError: PAGES_SENDS_AR });
    expect(db.conversionDelivery.findUnique.mock.calls[0][0].select.order.select).toMatchObject({ ccSender: true });
  });

  it('NEGATIVE: any other order is sent as before', async () => {
    db.conversionDelivery.findUnique.mockResolvedValue(row({}));
    expect(await deliverConversion('d1')).toBe(true);
    expect(sendEvents).toHaveBeenCalledTimes(1);
  });
});
