import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PAGES-LEADS WEBHOOK CHECKS THE SIGNATURE BEFORE THE BODY (step E1)
 *
 *  1. The order: rate limit → raw body (size cap) → SIGNATURE → parse → strict payload → the owner's switch → keep. A wrong, stale or missing signature is ONE 401 that says nothing about which;
 *     with no secret configured it is a 503 and nothing else is looked at; a body that is not JSON or not the payload is refused only AFTER the signature held.
 *  2. The owner's switch is the company's of the product: OFF the answer is «received» and nothing is stored; ON the lead is kept (201), a retry is `duplicate` (200).
 *  3. No value of the lead (name, number, city) is echoed in any answer.
 *  4. The route is public by design: it asks no session, only the signature.
 * ═════════════════════════════════════════════════════════════════
 */
const SECRET = 'route-test-secret-not-real';
const { rate, take, sw, db } = vi.hoisted(() => ({
  rate: { allowed: true },
  take: vi.fn(async (..._a: unknown[]) => ({ ok: true, created: true, recentOrder: false }) as unknown),
  sw: { on: true, asked: [] as string[] },
  db: { product: { findUnique: vi.fn(async (..._a: unknown[]) => ({ companyId: 'c1' }) as unknown) } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ allowed: rate.allowed }), getClientIp: () => '1.2.3.4' }));
vi.mock('@/lib/leads/leads-v2-switch', () => ({ leadsV2Switch: async (_c: unknown, companyId: string) => (sw.asked.push(companyId), { enabled: sw.on, enabledAt: sw.on ? new Date(0) : null }) }));
vi.mock('@/lib/leads/lead-intake', async (orig) => ({ ...((await orig()) as object), takeLead: (...a: unknown[]) => take(...a) }));

import { POST } from './route';
import { sign } from '@/lib/leads/pages-signature';

const BODY = { id: 'L1', full_name: 'سارة الحلبي', phone: '0933620102', city: 'دمشق', product_id: 'p1' };
const call = (over: { body?: string; ts?: string | null; sig?: string | null; secret?: string } = {}) => {
  const raw = over.body ?? JSON.stringify(BODY);
  const ts = over.ts === undefined ? String(Date.now()) : over.ts;
  const secret = over.secret ?? SECRET;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ts !== null) headers['X-Zaki-Timestamp'] = ts;
  const sig = over.sig === undefined ? (ts === null ? null : sign(secret, ts, raw)) : over.sig;
  if (sig !== null) headers['X-Zaki-Signature'] = sig;
  return POST(new Request('http://x/api/webhooks/pages/leads', { method: 'POST', headers, body: raw }));
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAGES_WEBHOOK_SECRET = SECRET;
  rate.allowed = true;
  sw.on = true;
  sw.asked = [];
  take.mockResolvedValue({ ok: true, created: true, recentOrder: false });
  db.product.findUnique.mockResolvedValue({ companyId: 'c1' });
});

describe('the signature comes first', () => {
  it('a wrong, stale or missing signature is ONE 401, and nothing else is read', async () => {
    const stale = String(Date.now() - 10 * 60_000);
    const answers = await Promise.all([call({ secret: 'someone else' }), call({ ts: stale }), call({ ts: null }), call({ sig: null }), call({ sig: 'sha256=00' })]);
    for (const r of answers) {
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    }
    expect(db.product.findUnique).not.toHaveBeenCalled();
    expect(take).not.toHaveBeenCalled();
  });

  it('a body that is not JSON is refused only AFTER the signature held — a bad signature on junk is still the 401', async () => {
    const junk = 'not json at all';
    expect((await call({ body: junk, sig: 'sha256=00' })).status).toBe(401);
    expect((await call({ body: junk })).status).toBe(400);
  });

  it('with no secret configured: 503 and nothing else looked at, even for a request that would have matched an empty secret', async () => {
    delete process.env.PAGES_WEBHOOK_SECRET;
    const r = await call({ secret: '' });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('NOT_CONFIGURED');
    expect(db.product.findUnique).not.toHaveBeenCalled();
  });

  it('the rate limit comes before everything, and a body over 64 KB is refused before it is judged', async () => {
    rate.allowed = false;
    expect((await call()).status).toBe(429);
    rate.allowed = true;
    expect((await call({ body: JSON.stringify({ ...BODY, full_name: 'ا'.repeat(70_000) }) })).status).toBe(413);
    expect(take).not.toHaveBeenCalled();
  });
});

describe('after the signature', () => {
  it('a payload that is not the strict one is a 422 and keeps nothing', async () => {
    const r = await call({ body: JSON.stringify({ ...BODY, price: 1 }) });
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe('INVALID_LEAD');
    expect(take).not.toHaveBeenCalled();
  });

  it('a product that is not in the catalogue is a 422', async () => {
    db.product.findUnique.mockResolvedValueOnce(null);
    const r = await call();
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe('UNKNOWN_PRODUCT');
  });

  it('the switch asked is the one of the PRODUCT\'s company; OFF: «received», nothing stored', async () => {
    sw.on = false;
    const r = await call();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, stored: false });
    expect(sw.asked).toEqual(['c1']);
    expect(take).not.toHaveBeenCalled();
  });

  it('ON: a new lead is 201 and a retry is 200 with duplicate; the flag is passed on', async () => {
    const first = await call();
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true, stored: true, duplicate: false, recentOrder: false });
    take.mockResolvedValueOnce({ ok: true, created: false, recentOrder: true });
    const again = await call();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, stored: true, duplicate: true, recentOrder: true });
  });

  it('a refusal of the intake (unknown product, no digits) is its own code and status', async () => {
    take.mockResolvedValueOnce({ ok: false, code: 'INVALID_PHONE', status: 422 });
    const r = await call();
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe('INVALID_PHONE');
  });
});

describe('no value of the lead is echoed', () => {
  it('no answer — success or refusal — carries the name, the number or the city', async () => {
    take.mockResolvedValueOnce({ ok: true, created: true, recentOrder: true });
    const answers = [await call(), await call({ ts: null }), await call({ body: JSON.stringify({ ...BODY, price: 1 }) }), await call({ body: 'junk' })];
    for (const r of answers) {
      const text = await r.text();
      expect(text).not.toContain('سارة');
      expect(text).not.toContain('0933620102');
      expect(text).not.toContain('دمشق');
    }
  });

  it('the route asks no session: public by design, only the signature; and it writes nothing itself', async () => {
    const src = readFileSync('src/app/api/webhooks/pages/leads/route.ts', 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');
    expect(src).not.toMatch(/requireContext|requireAuth|getCurrentUser|requirePermission/);
    expect(src).not.toMatch(/\.(create|update|upsert|delete)\w*\(/);
    expect(Object.keys(await import('./route')).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual(['POST']);
  });
});
