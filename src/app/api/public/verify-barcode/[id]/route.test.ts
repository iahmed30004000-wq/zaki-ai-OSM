import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/public/verify-barcode/[id]` — the ONLY thing a caller may ever learn is `{ genuine: boolean }`.
 *
 * Covers: a valid code → genuine; an unknown code → not genuine; rate limiting (per-IP and per-store);
 * and that no response ever leaks the product, the note, the company, or whether the store id itself is real.
 */

const { db, ip } = vi.hoisted(() => ({
  db: { store: { findFirst: vi.fn() }, authenticityCode: { findUnique: vi.fn(), update: vi.fn() } },
  ip: { value: 'local' },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  getClientIp: () => ip.value,
}));

import { POST } from './route';

const STORE_ID = 'aaaaaaaa-2222-4333-8444-555555555555';

const scan = (code: unknown, storeId = STORE_ID) =>
  POST(
    new Request(`http://x/api/public/verify-barcode/${storeId}`, {
      method: 'POST',
      body: JSON.stringify({ code }),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id: storeId }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  ip.value = `198.51.100.${Math.floor(Math.random() * 250) + 1}`; // a fresh address each test, so buckets don't bleed across tests
  db.store.findFirst.mockImplementation(async () => ({ companyId: 'company-1' }));
  db.authenticityCode.update.mockResolvedValue({});
});

describe('a code on the list', () => {
  it('answers genuine, and only that — no product, no note, no company, no id', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'acode1' });
    const res = await scan('ABC-123');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ genuine: true });
  });

  it('a scanned verify link (the printed QR) is looked up by the code inside it', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'acode1' });
    const res = await scan('https://crm.zakiai.io/verify/168f776f-7144-4422-864d-e63ac8c6ddc8?code=p-00042');
    expect(await res.json()).toEqual({ genuine: true });
    expect(db.authenticityCode.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ companyId_code: expect.objectContaining({ code: 'P-00042' }) }) })
    );
  });

  it('a code of 300 digits — as long as the add form allows — is looked up whole and can read genuine', async () => {
    const long = '7'.repeat(300);
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'acode1' });
    const res = await scan(long);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ genuine: true });
    expect(db.authenticityCode.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ companyId_code: expect.objectContaining({ code: long }) }) })
    );
  });

  it('bumps the scan count, but the verdict does not wait on it, and a write failure cannot flip the answer', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'acode1' });
    db.authenticityCode.update.mockRejectedValue(new Error('db down'));
    const res = await scan('abc-123');
    expect((await res.json()).genuine).toBe(true);
    expect(db.authenticityCode.update).toHaveBeenCalledWith({
      where: { id: 'acode1' },
      data: { scanCount: { increment: 1 }, lastScanAt: expect.any(Date) },
    });
  });

  it('is case-insensitive and trims whitespace, like the stored code', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'acode1' });
    await scan('  abc-123  ');
    expect(db.authenticityCode.findUnique).toHaveBeenCalledWith({
      where: { companyId_code: { companyId: 'company-1', code: 'ABC-123' } },
      select: { id: true },
    });
  });
});

describe('a code not on the list', () => {
  it('answers not genuine', async () => {
    db.authenticityCode.findUnique.mockResolvedValue(null);
    const res = await scan('NOT-REAL');
    expect(await res.json()).toEqual({ genuine: false });
  });

  it('a garbage/empty/oversized code is simply not genuine — never a 400, never a crash', async () => {
    db.authenticityCode.findUnique.mockResolvedValue(null);
    for (const bad of ['', '  ', 'a'.repeat(301), 'has a space', 'ثيثث', '<script>']) {
      const res = await scan(bad);
      expect(res.status, bad).toBe(bad.trim() ? 200 : 400);
    }
  });
});

describe('a store that is missing, paused, or malformed', () => {
  it('answers not genuine — the same shape as a wrong code, never a 404 that would tell the two apart', async () => {
    db.store.findFirst.mockResolvedValue(null);
    const res = await scan('ABC-123');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ genuine: false });
    expect(db.authenticityCode.findUnique).not.toHaveBeenCalled();
  });

  it('a malformed id never reaches the database at all', async () => {
    const res = await scan('ABC-123', 'not-a-uuid');
    expect(await res.json()).toEqual({ genuine: false });
    expect(db.store.findFirst).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  it('caps one address at 20 scans a minute, whichever store it tries', async () => {
    db.authenticityCode.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 20; i += 1) expect((await scan('X')).status).toBe(200);
    const blocked = await scan('X');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('a flood aimed at one store cannot be dodged by rotating addresses — the per-store bucket still trips', async () => {
    db.authenticityCode.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 600; i += 1) {
      ip.value = `203.0.113.${i % 250}`;
      await scan('X', 'bbbbbbbb-3333-4333-8444-555555555555');
    }
    ip.value = '203.0.113.250';
    const blocked = await scan('X', 'bbbbbbbb-3333-4333-8444-555555555555');
    expect(blocked.status).toBe(429);
  });
});

describe('CORS and method', () => {
  it('always carries the public CORS headers, even on an error', async () => {
    db.store.findFirst.mockRejectedValue(new Error('boom'));
    const res = await scan('ABC-123');
    expect(res.status).toBe(500);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
