import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ZAKI PAGES HEARS ITS ORDERS' STATUS (2026-11-21) — `pages.order_status`
 *
 *  · Only an order that came from Zaki Pages (it carries `externalLandingPageId`), only at the four moments —
 *    confirmed · delivered · cancelled · returned — and only to an app that registered for this event by name.
 *  · The body is `{event, at, data}` with the order's id and number, the page's id, the status and its moment:
 *    nothing about the customer.
 *  · One idempotency key per (company, order, status), with the company in it; a repeat writes no second row.
 *  · Delivered through the same signed outbox as the six: `X-Zaki-Signature = sha256=HMAC(secret, "<ts ms>.<body>")`.
 *  · The six stay exactly what they were, and their apps hear nothing new.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, decryptSecret } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn() },
    appInstall: { findMany: vi.fn() },
    appDelivery: { createMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  },
  decryptSecret: vi.fn(),
}));
vi.mock('../db', () => ({ db }));
vi.mock('../secrets', () => ({ decryptSecret: (...a: unknown[]) => decryptSecret(...a) }));

import { APP_EVENTS, PAGES_ORDER_STATUS_EVENT, deliverOne, emitAppEvent, pagesStatusKey, type AppEvent } from './events';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const PAGES_ORDER = { id: 'ord-1', orderNumber: 'JO-2026-0007', externalLandingPageId: 'pg-page-1' };
const PAGES_APP = { id: 'i-pages', app: { events: JSON.stringify([PAGES_ORDER_STATUS_EVENT]), webhookUrl: 'https://pages.example.test/webhooks/oms' } };
const REPLIES_APP = { id: 'i-replies', app: { events: JSON.stringify([...APP_EVENTS]), webhookUrl: 'https://replies.test/h' } };
/** What the six's call sites send — the customer is never in it, but this proves none of it is copied anyway. */
const SIX_PAYLOAD = { orderId: 'ord-1', orderNumber: 'JO-2026-0007', total: 22, currency: 'JOD', customerPhone: '0790000001', customerName: 'زبون تجريبي' };

const pagesRows = () =>
  db.appDelivery.createMany.mock.calls.map((c) => c[0]).filter((a) => a.data.some((d: { event: string }) => d.event === PAGES_ORDER_STATUS_EVENT));

beforeEach(() => {
  vi.clearAllMocks();
  decryptSecret.mockReturnValue('pages-shared-secret-0123456789');
  db.order.findFirst.mockResolvedValue(PAGES_ORDER);
  db.appInstall.findMany.mockResolvedValue([PAGES_APP, REPLIES_APP]);
  db.appDelivery.createMany.mockImplementation(async (a: { data: unknown[] }) => ({ count: a.data.length }));
  db.appDelivery.update.mockResolvedValue({});
});

describe('when Zaki Pages is told', () => {
  it.each([
    ['order.confirmed', 'confirmed'],
    ['order.delivered', 'delivered'],
    ['order.cancelled', 'cancelled'],
    ['order.returned', 'returned'],
  ] as const)('%s of a Zaki Pages order → one «%s» row, for the Pages app only', async (event, status) => {
    await emitAppEvent('c1', event, SIX_PAYLOAD);
    const [call] = pagesRows();
    expect(call.data).toHaveLength(1);
    const row = call.data[0];
    expect(row).toMatchObject({ companyId: 'c1', installId: 'i-pages', event: PAGES_ORDER_STATUS_EVENT, url: PAGES_APP.app.webhookUrl, status: 'PENDING' });
    expect(row.idempotencyKey).toBe(`pages.order_status:c1:ord-1:${status}`);
    expect(JSON.parse(row.payload).data.status).toBe(status);
    expect(call.skipDuplicates).toBe(true);
    // The order is looked up inside the company, and only when it came from Zaki Pages.
    expect(db.order.findFirst.mock.calls[0][0].where).toEqual({ id: 'ord-1', companyId: 'c1', externalLandingPageId: { not: null } });
  });

  it.each(['order.created', 'order.shipped'] as const)('NEGATIVE: %s is not one of the four — nothing for Pages, not even a lookup', async (event) => {
    await emitAppEvent('c1', event, SIX_PAYLOAD);
    expect(pagesRows()).toEqual([]);
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an order that did not come from Zaki Pages (store, OMS landing page, messages, phone, sheet) → nothing', async () => {
    db.order.findFirst.mockResolvedValue(null);
    await emitAppEvent('c1', 'order.confirmed', SIX_PAYLOAD);
    expect(pagesRows()).toEqual([]);
  });

  it('NEGATIVE: no app registered for it → nothing; and the replies app never gets the new event', async () => {
    db.appInstall.findMany.mockResolvedValue([REPLIES_APP]);
    await emitAppEvent('c1', 'order.confirmed', SIX_PAYLOAD);
    expect(pagesRows()).toEqual([]);
    // The six went out exactly as before, to the app that asked for them.
    const six = db.appDelivery.createMany.mock.calls[0][0].data;
    expect(six).toHaveLength(1);
    expect(six[0]).toMatchObject({ installId: 'i-replies', event: 'order.confirmed' });
    expect(six[0]).not.toHaveProperty('idempotencyKey');
    expect(JSON.parse(six[0].payload).data).toEqual(SIX_PAYLOAD);
  });

  it('the six’s return value is untouched: it still counts the apps that heard the six', async () => {
    expect(await emitAppEvent('c1', 'order.confirmed', SIX_PAYLOAD)).toBe(1);
  });

  it('never throws — a broken lookup costs Pages its event, never the order its status', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.order.findFirst.mockRejectedValue(new Error('database gone ord-1 0790000001'));
    try {
      await expect(emitAppEvent('c1', 'order.delivered', SIX_PAYLOAD)).resolves.toBe(1);
      expect(JSON.stringify(err.mock.calls)).not.toContain('0790000001');
    } finally {
      err.mockRestore();
    }
  });
});

describe('what Zaki Pages is told', () => {
  it('exactly {event, at, data}, and data is the order’s id and number, the page, the status, its moment and the key — nothing else', async () => {
    await emitAppEvent('c1', 'order.confirmed', SIX_PAYLOAD);
    const body = JSON.parse(pagesRows()[0].data[0].payload);
    expect(Object.keys(body).sort()).toEqual(['at', 'data', 'event']);
    expect(body.event).toBe(PAGES_ORDER_STATUS_EVENT);
    expect(Object.keys(body.data).sort()).toEqual(['idempotency_key', 'order_id', 'order_number', 'page_id', 'status', 'status_at']);
    expect(body.data).toMatchObject({ order_id: 'ord-1', order_number: 'JO-2026-0007', page_id: 'pg-page-1', status: 'confirmed', idempotency_key: 'pages.order_status:c1:ord-1:confirmed' });
    expect(new Date(body.data.status_at).toISOString()).toBe(body.data.status_at);
  });

  it('NO PII: neither the customer’s name nor phone nor the money ever reaches the body', async () => {
    await emitAppEvent('c1', 'order.delivered', SIX_PAYLOAD);
    const payload = pagesRows()[0].data[0].payload as string;
    for (const v of ['0790000001', 'زبون تجريبي', 'customer', 'phone', 'total', 'address']) expect(payload).not.toContain(v);
  });

  it('the idempotency key names the company: two companies, one order id, two keys', () => {
    expect(pagesStatusKey('c1', 'ord-1', 'confirmed')).not.toBe(pagesStatusKey('c2', 'ord-1', 'confirmed'));
    expect(pagesStatusKey('c1', 'ord-1', 'confirmed')).toContain('c1');
    expect(pagesStatusKey('c1', 'ord-1', 'confirmed')).not.toBe(pagesStatusKey('c1', 'ord-1', 'delivered'));
  });

  it('a repeat of the same status is the same key, so the outbox writes it once', async () => {
    db.appDelivery.createMany.mockImplementation(async (a: { data: { event: string }[] }) => ({ count: a.data[0].event === PAGES_ORDER_STATUS_EVENT ? 0 : 1 }));
    await emitAppEvent('c1', 'order.confirmed', SIX_PAYLOAD);
    await emitAppEvent('c1', 'order.confirmed', SIX_PAYLOAD);
    const keys = pagesRows().map((c) => c.data[0].idempotencyKey);
    expect(keys).toEqual(['pages.order_status:c1:ord-1:confirmed', 'pages.order_status:c1:ord-1:confirmed']);
    expect(pagesRows().every((c) => c.skipDuplicates === true)).toBe(true);
  });
});

describe('how it is delivered — signed, retried, and the secret never shown', () => {
  /** Zaki Pages' side, as it must verify: HMAC-SHA256 over «<timestamp>.<raw body>», ms timestamp, a 5-minute window. */
  function pagesVerifies(secret: string, headers: Record<string, string>, raw: string, nowMs: number): boolean {
    const ts = Number(headers['X-Zaki-Timestamp']);
    if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > 5 * 60_000) return false;
    const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(`${headers['X-Zaki-Timestamp']}.${raw}`).digest('hex'));
    const got = Buffer.from(headers['X-Zaki-Signature'] ?? '');
    return want.length === got.length && timingSafeEqual(want, got);
  }

  it('the four headers, the body untouched, and a signature Pages can verify with the shared secret', async () => {
    await emitAppEvent('c1', 'order.confirmed', SIX_PAYLOAD);
    const row = pagesRows()[0].data[0];
    db.appDelivery.findUnique.mockResolvedValue({ id: 'd-pages', url: row.url, payload: row.payload, event: row.event, attempts: 0, install: { app: { secret: 'enc', code: 'ZAKI_PAGES' } } });
    fetchMock.mockResolvedValue({ status: 200 });
    expect(await deliverOne('d-pages')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://pages.example.test/webhooks/oms');
    expect(init.body).toBe(row.payload);
    const h = init.headers as Record<string, string>;
    expect(h['X-Zaki-Event']).toBe(PAGES_ORDER_STATUS_EVENT);
    expect(h['X-Zaki-Delivery']).toBe('d-pages');
    expect(h['X-Zaki-Timestamp']).toMatch(/^\d{13}$/);
    expect(pagesVerifies('pages-shared-secret-0123456789', h, init.body, Date.now())).toBe(true);
    // A wrong secret, or a body changed by one byte, does not verify.
    expect(pagesVerifies('another-secret-000000000000', h, init.body, Date.now())).toBe(false);
    expect(pagesVerifies('pages-shared-secret-0123456789', h, init.body.replace('confirmed', 'cancelled'), Date.now())).toBe(false);
    // The secret itself travels nowhere.
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('pages-shared-secret-0123456789');
  });

  it('a failure is retried with the outbox’s backoff and dead-lettered after the last try', async () => {
    db.appDelivery.findUnique.mockResolvedValue({ id: 'd', url: 'https://pages.example.test/webhooks/oms', payload: '{}', event: PAGES_ORDER_STATUS_EVENT, attempts: 0, install: { app: { secret: 'enc', code: 'ZAKI_PAGES' } } });
    fetchMock.mockResolvedValue({ status: 503 });
    await deliverOne('d');
    expect(db.appDelivery.update.mock.calls[0][0].data).toMatchObject({ status: 'PENDING', error: 'HTTP 503' });
  });
});

describe('the six', () => {
  it('stay exactly six, and the new event is not one of them', () => {
    expect((APP_EVENTS as readonly string[]).includes(PAGES_ORDER_STATUS_EVENT)).toBe(false);
    expect(APP_EVENTS).toHaveLength(6);
    const _typed: AppEvent[] = [...APP_EVENTS];
    expect(_typed).toHaveLength(6);
  });
});
