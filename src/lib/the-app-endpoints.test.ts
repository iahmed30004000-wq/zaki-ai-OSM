import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «ZAKI ORDERS» — THE THREE DOORS THE APP NEEDED (22/11):
 *   · `POST /api/orders/quote` — the figure the order door will write, from the door's own pricing (order-quote.ts);
 *   · `Idempotency-Key` on `POST /api/orders` — a queued order sent twice is one order (app-idempotency.ts);
 *   · `/api/client-errors` — crashes from the phone, with no customer data (client-error.ts).
 */

const { ledger, tenant } = vi.hoisted(() => ({
  ledger: new Map<string, { requestHash: string; status: number; response: string }>(),
  tenant: { user: { id: 'u1' }, companyId: 'c1' },
}));

vi.mock('./db', async () => {
  const { Prisma } = await import('@prisma/client');
  return {
    db: {
      idempotencyRecord: {
        create: vi.fn(async ({ data }: { data: { companyId: string; key: string; requestHash: string } }) => {
          const k = `${data.companyId}|${data.key}`;
          if (ledger.has(k)) throw new Prisma.PrismaClientKnownRequestError('taken', { code: 'P2002', clientVersion: 'x' });
          ledger.set(k, { requestHash: data.requestHash, status: 0, response: '' });
        }),
        findUnique: vi.fn(async ({ where }: { where: { companyId_key: { companyId: string; key: string } } }) =>
          ledger.get(`${where.companyId_key.companyId}|${where.companyId_key.key}`) ?? null
        ),
        update: vi.fn(async ({ where, data }: { where: { companyId_key: { companyId: string; key: string } }; data: { status: number; response: string } }) => {
          Object.assign(ledger.get(`${where.companyId_key.companyId}|${where.companyId_key.key}`)!, data);
        }),
        deleteMany: vi.fn(async ({ where }: { where: { companyId: string; key: string } }) => {
          const k = `${where.companyId}|${where.key}`;
          if (ledger.get(k)?.status === 0) ledger.delete(k);
          return { count: 1 };
        }),
      },
    },
  };
});
vi.mock('./auth', () => ({ requireCompanyTenant: vi.fn(async () => tenant) }));

import { quoteOrder, type QuoteOffer, type QuoteProduct } from './order-quote';
import { withAppIdempotency, REPLAY_HEADER } from './app-idempotency';
import { cleanClientError, scrubDigits } from './client-error';
import { priceByOffer } from './offer-line-price';

const P: QuoteProduct = { id: 'p1', name: 'كريم', basePrice: 25 };
const THREE_FOR_75: QuoteOffer = { id: 'o3', name: '3 + 1 هدية', quantity: 3, freeQuantity: 1, price: 75, listPrice: null };

function quote(lines: { productId: string; offerId?: string | null; quantity: number }[], over: Partial<{ products: QuoteProduct[]; offers: QuoteOffer[] }> = {}) {
  return quoteOrder({
    lines,
    products: new Map((over.products ?? [P]).map((p) => [p.id, p])),
    liveOffers: new Map([['p1', over.offers ?? [THREE_FOR_75]]]),
    minorUnit: 0,
    priceIncludesDelivery: true,
  });
}

describe('the quote: the door’s own pricing, an inexact offer as two lines', () => {
  it('a whole bundle: one line, the offer, its gift, the bundle price', () => {
    const q = quote([{ productId: 'p1', offerId: 'o3', quantity: 3 }]);
    expect(q.ok).toBe(true);
    expect(q.lines).toMatchObject([{ offerId: 'o3', quantity: 3, freeQuantity: 1, lineTotal: 75, basis: 'OFFER' }]);
    expect(q.cod).toBe(75);
    expect(q.items).toEqual([{ productId: 'p1', offerId: 'o3', quantity: 3, unitPrice: 75 }]);
  });

  it('4 on a «3 بـ75» is TWO lines: 3 on the offer with its gift, 1 at the base price with none', () => {
    const q = quote([{ productId: 'p1', offerId: 'o3', quantity: 4 }]);
    expect(q.lines).toMatchObject([
      { offerId: 'o3', quantity: 3, freeQuantity: 1, lineTotal: 75, basis: 'OFFER', from: 0 },
      { offerId: null, quantity: 1, freeQuantity: 0, lineTotal: 25, basis: 'BASE', from: 0 },
    ]);
    // The same total priceByOffer gives the one line — two lines, not a second rule.
    expect(q.cod).toBe(priceByOffer(THREE_FOR_75, 4, { basePrice: 25, minorUnit: 0 }).lineTotal);
    expect(q.items).toHaveLength(2);
  });

  it('7 on it: two bundles (two gifts) and one at base', () => {
    const q = quote([{ productId: 'p1', offerId: 'o3', quantity: 7 }]);
    expect(q.lines.map((l) => [l.quantity, l.freeQuantity, l.lineTotal])).toEqual([[6, 2, 150], [1, 0, 25]]);
    expect(q.cod).toBe(175);
  });

  it('shorter than a bundle: the offer is let go, the base price, no gift — and it says so', () => {
    const q = quote([{ productId: 'p1', offerId: 'o3', quantity: 2 }]);
    expect(q.lines).toMatchObject([{ offerId: null, quantity: 2, freeQuantity: 0, lineTotal: 50, basis: 'BASE' }]);
    expect(q.lines[0].notes.length).toBeGreaterThan(0);
  });

  it('prices an offer at the figure the web form sends: before the bundle’s own reduction (RV422, unchanged here)', () => {
    const reduced = { ...THREE_FOR_75, price: 70, listPrice: 75 };
    expect(quote([{ productId: 'p1', offerId: 'o3', quantity: 3 }], { offers: [reduced] }).cod).toBe(75);
  });

  it('no offer: the base price times the quantity', () => {
    expect(quote([{ productId: 'p1', quantity: 2 }]).cod).toBe(50);
  });

  it('refuses with a sentence, never a figure: an unknown base price, an offer not on sale, a product not in the store', () => {
    for (const q of [
      quote([{ productId: 'p1', quantity: 1 }], { products: [{ ...P, basePrice: null }] }),
      quote([{ productId: 'p1', offerId: 'o3', quantity: 4 }], { products: [{ ...P, basePrice: null }] }),
      quote([{ productId: 'p1', offerId: 'gone', quantity: 3 }]),
      quote([{ productId: 'other', quantity: 1 }]),
    ]) {
      expect(q.ok).toBe(false);
      expect(q.cod).toBeNull();
      expect(q.items).toEqual([]);
      expect(q.lines.some((l) => l.basis === 'REFUSED' && l.notes[0].length > 0)).toBe(true);
    }
  });

  it('says when a chosen offer carries delivery', () => {
    expect(quote([{ productId: 'p1', offerId: 'o3', quantity: 3 }], { offers: [{ ...THREE_FOR_75, deliveryIncluded: true }] }).anyOfferIncludesDelivery).toBe(true);
  });
});

describe('Idempotency-Key on the order door: one order however many times it arrives', () => {
  beforeEach(() => ledger.clear());
  let made = 0;
  const handler = vi.fn(async (req: Request) => {
    const body = await req.json();
    made++;
    return Response.json({ success: true, order: { id: `ord${made}`, phone: body.phone } });
  });
  const send = (key: string, body: unknown) =>
    withAppIdempotency(new Request('https://crm.test/api/orders', { method: 'POST', body: JSON.stringify(body) }), key, handler);

  it('the same key and body: the order is made once, the retry gets the first answer, marked as a replay', async () => {
    made = 0;
    const first = await send('k1', { phone: '0991' });
    const again = await send('k1', { phone: '0991' });
    expect(made).toBe(1);
    expect(await again.json()).toEqual(await first.json());
    expect(again.headers.get(REPLAY_HEADER)).toBe('true');
    expect(first.headers.get(REPLAY_HEADER)).toBeNull();
  });

  it('the same key with a different body is refused, not answered with the first order', async () => {
    await send('k2', { phone: '0991' });
    const res = await send('k2', { phone: '0992' });
    expect(res.status).toBe(409);
    expect((await res.json()).errorAr).toBeTruthy();
  });

  it('a refused order keeps no claim: the corrected retry is a new attempt', async () => {
    const refusing = vi.fn(async () => Response.json({ error: 'bad phone' }, { status: 400 }));
    const req = () => new Request('https://crm.test/api/orders', { method: 'POST', body: '{"phone":"x"}' });
    await withAppIdempotency(req(), 'k3', refusing);
    await withAppIdempotency(req(), 'k3', refusing);
    expect(refusing).toHaveBeenCalledTimes(2);
  });

  it('keys are per person, inside the company', async () => {
    await send('k4', { phone: '1' });
    expect([...ledger.keys()]).toEqual(['c1|app:u1:k4']);
  });
});

describe('client errors: no customer data is kept', () => {
  it('blanks any run of eight digits or more, keeps short numbers', () => {
    expect(scrubDigits('order 0991 234 567 failed at line 42')).toBe('order [رقم] failed at line 42');
    expect(scrubDigits('timeout after 3000 ms')).toBe('timeout after 3000 ms');
  });

  it('cuts every field and holds the phone’s clock between a month ago and now', () => {
    const now = new Date('2026-11-22T12:00:00Z');
    const e = cleanClientError(
      { kind: 'CRASH', message: 'x'.repeat(5000), stack: 's', screen: 'orders', appVersion: '1.0.0', occurredAt: '2031-01-01T00:00:00Z' },
      now
    );
    expect(e.message).toHaveLength(2000);
    expect(e.occurredAt.getTime()).toBe(now.getTime());
    const old = cleanClientError({ kind: 'ANR', message: 'm', appVersion: '1', occurredAt: '2020-01-01' }, now);
    expect(now.getTime() - old.occurredAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(cleanClientError({ kind: 'ERROR', message: 'm', appVersion: '1', occurredAt: 'nonsense' }, now).occurredAt).toEqual(now);
  });
});

describe('the wiring, read from the source', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('the order door goes through the ledger only when the key is sent', () => {
    const src = read('src/app/api/orders/route.ts');
    expect(src).toContain("req.headers.get('idempotency-key')");
    expect(src).toContain('withAppIdempotency(req, key, createOrder) : createOrder(req)');
  });

  it('the quote is gated like creating an order, and writes nothing', () => {
    const src = read('src/app/api/orders/quote/route.ts');
    expect(src).toContain("requirePermission('orders.create')");
    expect(src).toContain('requireContext()');
    expect(src).not.toMatch(/\.(create|update|upsert|delete)(Many)?\(/);
  });

  it('crash reports: the sender is the session, the reader holds audit.view', () => {
    const src = read('src/app/api/client-errors/route.ts');
    expect(src).toContain('userId: user.id');
    expect(src).toContain("requirePermission('audit.view')");
  });
});
