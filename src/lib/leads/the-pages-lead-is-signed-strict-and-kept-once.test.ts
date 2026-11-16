import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { SIGNATURE_WINDOW_MS, sign, verifyPagesSignature } from './pages-signature';
import { leadSchema, recentOrderOfTheSame, takeLead } from './lead-intake';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PAGES LEAD IS SIGNED, STRICT AND KEPT ONCE (step E1)
 *
 *  1. The signature is `sha256=HMAC(secret, "<timestamp>.<raw body>")` — the shape the OMS signs its own app events with — and without a configured secret EVERYTHING is refused (fail closed).
 *  2. The timestamp must be within five minutes of the server's clock, either side; a missing header, a malformed timestamp, a stale one, a body changed by one byte and a signature of another length are all refused.
 *  3. The payload is strict: only the eight known fields, texts trimmed and bounded, the optional ones null when empty; anything else is refused.
 *  4. A lead is kept ONCE per external id; its company and store come from the catalogue's product; an unknown product or a number with no digits is refused (422).
 *  5. A number that ordered the same product in the last 24 hours (any spelling of it, not refused) FLAGS the lead — the lead is kept anyway; an older order, another product or a refused one does not flag it.
 *  6. It creates no order and no customer, and reaches no model.
 * ═════════════════════════════════════════════════════════════════
 */

const SECRET = 'test-secret-not-a-real-one';
const NOW = 1_800_000_000_000;
const ts = (offsetMs = 0) => String(NOW + offsetMs);
const BODY = JSON.stringify({ id: 'L1', full_name: 'سارة', phone: '0933620102', product_id: 'p1' });

describe('the signature', () => {
  const good = () => ({ timestamp: ts(), signature: sign(SECRET, ts(), BODY), rawBody: BODY, now: NOW, secret: SECRET });

  it('accepts what the pages system signs with the shared secret', () => {
    expect(verifyPagesSignature(good())).toBe('OK');
  });

  it('has the shape of the app events: sha256=<hex of HMAC over "<timestamp>.<body>">', () => {
    expect(sign(SECRET, '1800000000000', 'x')).toMatch(/^sha256=[0-9a-f]{64}$/);
    // the signed string is exactly "<timestamp>.<body>" — checked against an independent computation, as the OMS's own events are signed
    expect(sign(SECRET, '1800000000000', '{"a":1}')).toBe('sha256=' + createHmac('sha256', SECRET).update('1800000000000.{"a":1}', 'utf8').digest('hex'));
  });

  it('fails CLOSED without a secret: nothing is accepted, not even a signature that would match an empty secret', () => {
    expect(verifyPagesSignature({ ...good(), secret: null })).toBe('NOT_CONFIGURED');
    expect(verifyPagesSignature({ ...good(), secret: '', signature: sign('', ts(), BODY) })).toBe('NOT_CONFIGURED');
  });

  it('refuses a missing timestamp or signature, and a malformed timestamp', () => {
    expect(verifyPagesSignature({ ...good(), timestamp: null })).toBe('MISSING');
    expect(verifyPagesSignature({ ...good(), signature: null })).toBe('MISSING');
    for (const bad of ['abc', '12', '1.8e12', '-1800000000000', '1800000000000x']) expect(verifyPagesSignature({ ...good(), timestamp: bad })).toBe('BAD');
  });

  it('holds the window: five minutes either side are fine, one millisecond more is stale', () => {
    for (const offset of [0, SIGNATURE_WINDOW_MS, -SIGNATURE_WINDOW_MS]) {
      expect(verifyPagesSignature({ timestamp: ts(offset), signature: sign(SECRET, ts(offset), BODY), rawBody: BODY, now: NOW, secret: SECRET }), String(offset)).toBe('OK');
    }
    for (const offset of [SIGNATURE_WINDOW_MS + 1, -SIGNATURE_WINDOW_MS - 1, 3_600_000]) {
      expect(verifyPagesSignature({ timestamp: ts(offset), signature: sign(SECRET, ts(offset), BODY), rawBody: BODY, now: NOW, secret: SECRET }), String(offset)).toBe('STALE');
    }
  });

  it('refuses a body changed by one byte, another secret, another timestamp, and a signature of another length', () => {
    expect(verifyPagesSignature({ ...good(), rawBody: BODY + ' ' })).toBe('BAD');
    expect(verifyPagesSignature({ ...good(), secret: 'another-secret' })).toBe('BAD');
    expect(verifyPagesSignature({ ...good(), timestamp: ts(1_000) })).toBe('BAD');
    expect(verifyPagesSignature({ ...good(), signature: good().signature.slice(0, -2) })).toBe('BAD');
    expect(verifyPagesSignature({ ...good(), signature: good().signature + '00' })).toBe('BAD');
    expect(verifyPagesSignature({ ...good(), signature: 'sha256=' })).toBe('BAD');
  });

  it('reads the secret from the environment only, and compares in constant time', () => {
    const src = readFileSync('src/lib/leads/pages-signature.ts', 'utf8');
    expect(src).toContain('process.env.PAGES_WEBHOOK_SECRET');
    expect(src).toContain('crypto.timingSafeEqual');
    expect(src).not.toMatch(/['"`]sha256=[0-9a-f]{20,}/);
  });
});

describe('the payload', () => {
  const ok = { id: 'L1', full_name: ' سارة ', phone: '0933620102', product_id: 'p1' };

  it('accepts the eight fields, trims, and makes the empty optional ones null', () => {
    const v = leadSchema.parse({ ...ok, city: '', page: '', utm_campaign: 'c1', utm_content: 'ad9' });
    expect(v).toEqual({ id: 'L1', full_name: 'سارة', phone: '0933620102', city: null, product_id: 'p1', page: null, utm_campaign: 'c1', utm_content: 'ad9' });
  });

  it.each([
    ['a field it does not know', { ...ok, price: 1 }],
    ['no id', { ...ok, id: undefined }],
    ['an empty name', { ...ok, full_name: '   ' }],
    ['no phone', { ...ok, phone: undefined }],
    ['no product', { ...ok, product_id: undefined }],
    ['a name over 200', { ...ok, full_name: 'ا'.repeat(201) }],
    ['a page over 500', { ...ok, page: 'x'.repeat(501) }],
    ['a number as the id', { ...ok, id: 5 }],
    ['an array', [ok]],
  ])('refuses %s', (_n, input) => {
    expect(leadSchema.safeParse(input).success).toBe(false);
  });
});

function world(over: { product?: unknown; existing?: unknown; customers?: unknown[]; order?: unknown } = {}) {
  const c = {
    product: { findUnique: vi.fn(async (..._a: unknown[]) => ('product' in over ? over.product : { id: 'p1', companyId: 'c1', storeId: 's1', store: { country: { code: 'SY' } } })) },
    lead: { findUnique: vi.fn(async (..._a: unknown[]) => over.existing ?? null), create: vi.fn(async (..._a: unknown[]) => ({})) },
    customer: { findMany: vi.fn(async (..._a: unknown[]) => over.customers ?? []) },
    order: { findFirst: vi.fn(async (..._a: unknown[]) => over.order ?? null) },
  };
  return c;
}
const lead = { id: 'L1', full_name: 'سارة', phone: '0933620102', city: 'دمشق', product_id: 'p1', page: 'https://pages.zakiai.io/x', utm_campaign: 'camp', utm_content: 'ad1' };
const at = new Date('2026-11-17T12:00:00Z');

describe('keeping it', () => {
  it('keeps one row with the catalogue\'s company and store, the canonical number key and the utm pair as sent', async () => {
    const c = world();
    const r = await takeLead(c as never, lead, at);
    expect(r).toEqual({ ok: true, created: true, recentOrder: false });
    expect((c.lead.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data).toMatchObject({
      companyId: 'c1', storeId: 's1', externalId: 'L1', fullName: 'سارة', phone: '0933620102', phoneKey: '933620102', city: 'دمشق', productId: 'p1', pageUrl: 'https://pages.zakiai.io/x', utmCampaign: 'camp', utmContent: 'ad1', recentOrderId: null,
    });
  });

  it('is idempotent on the external id: a retry keeps nothing and says so', async () => {
    const c = world({ existing: { recentOrderId: null } });
    expect(await takeLead(c as never, lead, at)).toEqual({ ok: true, created: false, recentOrder: false });
    expect(c.lead.create).not.toHaveBeenCalled();
    expect(world({ existing: { recentOrderId: 'o9' } }).lead.findUnique).toBeDefined();
  });

  it('refuses (422) an unknown product, a product with no store, and a number with no digits — keeping nothing', async () => {
    for (const [c, code] of [
      [world({ product: null }), 'UNKNOWN_PRODUCT'],
      [world({ product: { id: 'p1', companyId: 'c1', storeId: null, store: null } }), 'UNKNOWN_PRODUCT'],
      [world(), 'INVALID_PHONE'],
    ] as const) {
      const r = await takeLead(c as never, code === 'INVALID_PHONE' ? { ...lead, phone: 'no digits' } : lead, at);
      expect(r).toMatchObject({ ok: false, code, status: 422 });
      expect(c.lead.create).not.toHaveBeenCalled();
    }
  });
});

describe('the 24-hour flag', () => {
  it('a number that ordered the same product flags the lead, which is kept anyway', async () => {
    const c = world({ customers: [{ id: 'cu1' }], order: { id: 'o1' } });
    expect(await takeLead(c as never, lead, at)).toEqual({ ok: true, created: true, recentOrder: true });
    expect((c.lead.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data.recentOrderId).toBe('o1');
  });

  it('asks for the store\'s customers under every spelling of the number, orders of the last 24 hours, not refused, no replacement, same product', async () => {
    const c = world({ customers: [{ id: 'cu1' }], order: null });
    await recentOrderOfTheSame(c as never, { companyId: 'c1', storeId: 's1', countryCode: 'SY' }, '+963933620102', 'p1', at);
    const customers = (c.customer.findMany.mock.calls[0] as unknown as [{ where: { phone: { in: string[] } } & Record<string, unknown> }])[0].where;
    expect(customers).toMatchObject({ companyId: 'c1', storeId: 's1' });
    expect(customers.phone.in).toEqual(expect.arrayContaining(['933620102', '963933620102']));
    const orders = (c.order.findFirst.mock.calls[0] as unknown as [{ where: Record<string, any> }])[0].where;
    expect(orders).toMatchObject({ companyId: 'c1', customerId: { in: ['cu1'] }, replacesOrderId: null });
    expect(orders.createdAt.gte.toISOString()).toBe('2026-11-16T12:00:00.000Z');
    expect(orders.createdAt.lte.toISOString()).toBe(at.toISOString());
    expect(orders.confirmationStatus.notIn).toEqual(expect.arrayContaining(['REJECTED']));
    expect(JSON.stringify(orders)).toContain('"productId":{"in":["p1"]}');
  });

  it('with no customer of that number nothing more is asked', async () => {
    const c = world({ customers: [] });
    expect(await takeLead(c as never, lead, at)).toMatchObject({ ok: true, recentOrder: false });
    expect(c.order.findFirst).not.toHaveBeenCalled();
  });
});

describe('what it never does', () => {
  it('creates no order and no customer, and reaches no model or network', () => {
    const src = readFileSync('src/lib/leads/lead-intake.ts', 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');
    expect(src).not.toMatch(/order\.create|customer\.create|orderItem\.create/);
    expect((src.match(/\.create\(/g) ?? []).length).toBe(1); // the lead itself
    expect(src).not.toMatch(/fetch\(|aiChat|ai-provider|openai/i);
  });
});
