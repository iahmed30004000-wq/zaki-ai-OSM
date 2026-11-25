import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/public/verify-product/[publicId]` — one product's page asks «هل هذه القطعة أصلية؟». The ONLY thing a caller
 * may learn is `{ genuine: boolean }`: an unknown page, a switched-off page, an unknown code and a code of ANOTHER
 * product all read the same `{ genuine: false }`.
 */

const { db, ip } = vi.hoisted(() => ({
  db: {
    productVerifyPage: { findUnique: vi.fn() },
    authenticityCode: { findUnique: vi.fn(), update: vi.fn() },
  },
  ip: { value: 'local' },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  getClientIp: () => ip.value,
}));

import { OPTIONS, POST } from './route';

const PAGE = 'AbCdEf123_-x';
const PRODUCT = '22222222-2222-4222-8222-222222222222';

const scan = (code: unknown, publicId = PAGE, raw?: string) =>
  POST(
    new Request(`http://x/api/public/verify-product/${publicId}`, {
      method: 'POST',
      body: raw ?? JSON.stringify({ code }),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ publicId }) }
  );

let n = 0;
beforeEach(() => {
  vi.resetAllMocks();
  // A fresh address each test (counted, not random), so no two tests share a bucket.
  ip.value = `198.51.100.${++n}`;
  db.productVerifyPage.findUnique.mockResolvedValue({ companyId: 'co-1', productId: PRODUCT, active: true, imageUrl: null, logoUrl: null });
  db.authenticityCode.update.mockResolvedValue({});
});

describe('genuine — and nothing else', () => {
  it('a code tagged to this product: exactly { genuine: true }', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'c1', productId: PRODUCT });
    const res = await scan('p-0042');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ genuine: true });
    expect(db.authenticityCode.findUnique).toHaveBeenCalledWith({
      where: { companyId_code: { companyId: 'co-1', code: 'P-0042' } },
      select: { id: true, productId: true },
    });
  });

  it('a code for every product (untagged): genuine', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'c1', productId: null });
    expect(await (await scan('P-0042')).json()).toEqual({ genuine: true });
  });

  it('a scanned piece QR — the page link with ?code= — is checked by the code inside it', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'c1', productId: PRODUCT });
    expect(await (await scan('https://crm.example/v/krem?code=p-0042')).json()).toEqual({ genuine: true });
    expect(db.authenticityCode.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId_code: { companyId: 'co-1', code: 'P-0042' } } }));
  });
});

describe('not genuine, all in the same shape', () => {
  it('NEGATIVE: a code of ANOTHER product — a label moved between products', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'c1', productId: '33333333-3333-4333-8333-333333333333' });
    const res = await scan('P-0042');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ genuine: false });
  });

  it('NEGATIVE: an unknown code', async () => {
    db.authenticityCode.findUnique.mockResolvedValue(null);
    expect(await (await scan('NOPE-1')).json()).toEqual({ genuine: false });
  });

  it('NEGATIVE: a switched-off page answers exactly like a wrong code, and never looks the code up', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue({ companyId: 'co-1', productId: PRODUCT, active: false });
    const res = await scan('P-0042');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ genuine: false });
    expect(db.authenticityCode.findUnique).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an unknown page, the same', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue(null);
    expect(await (await scan('P-0042')).json()).toEqual({ genuine: false });
  });

  it('NEGATIVE: a malformed public id never reaches the database', async () => {
    expect(await (await scan('P-0042', 'not-an-id')).json()).toEqual({ genuine: false });
    expect(db.productVerifyPage.findUnique).not.toHaveBeenCalled();
  });

  it('the body never carries anything but `genuine` — no product, no code row, no id', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'c1', productId: PRODUCT });
    const text = await (await scan('P-0042')).text();
    for (const leak of ['c1', PRODUCT, 'co-1', 'productId', 'scan']) expect(text, leak).not.toContain(leak);
  });
});

describe('the door', () => {
  it('an empty code is a 400; broken JSON a 400; an oversized body a 413', async () => {
    expect((await scan('  ')).status).toBe(400);
    expect((await scan(null, PAGE, '{not json')).status).toBe(400);
    expect((await scan('x', PAGE, JSON.stringify({ code: 'x'.repeat(3000) }))).status).toBe(413);
  });

  it('caps one address at 20 checks a minute', async () => {
    db.authenticityCode.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 20; i += 1) expect((await scan('X-1')).status).toBe(200);
    const blocked = await scan('X-1');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('a flood aimed at one page trips the per-page bucket whatever the address', async () => {
    db.authenticityCode.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 600; i += 1) {
      ip.value = `203.0.113.${i % 250}`;
      await scan('X-1', 'ZZZZZZZZZZZZ');
    }
    ip.value = '203.0.113.251';
    expect((await scan('X-1', 'ZZZZZZZZZZZZ')).status).toBe(429);
  });

  it('CORS is open, on OPTIONS and even on an error', async () => {
    expect((await OPTIONS()).headers.get('Access-Control-Allow-Origin')).toBe('*');
    db.productVerifyPage.findUnique.mockRejectedValue(new Error('boom'));
    const res = await scan('P-0042');
    expect(res.status).toBe(500);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
