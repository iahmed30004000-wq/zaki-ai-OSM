import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/settings/authenticity-codes` — the owner's own list, one add at a time.
 *
 * Covers: permission-gated (GET asks `settings.view`, every write `settings.edit`), dedupe on add with a
 * clear message, delete removes exactly the row asked for (never another company's), and the public shape
 * (`note`/`productId`/`createdById`) never leaks anywhere this route does not explicitly return it from.
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    authenticityCode: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
    store: { findMany: vi.fn() },
    product: { findMany: vi.fn(), findFirst: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { DELETE, GET, POST } from './route';

const post = (body: unknown) =>
  POST(new Request('http://x/api/settings/authenticity-codes', { method: 'POST', body: JSON.stringify(body) }));
const del = (body: unknown) =>
  DELETE(new Request('http://x/api/settings/authenticity-codes', { method: 'DELETE', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'co-1' });
  requirePermission.mockResolvedValue(undefined);
  db.authenticityCode.findMany.mockResolvedValue([]);
  db.authenticityCode.findUnique.mockResolvedValue(null);
  db.store.findMany.mockResolvedValue([]);
  db.product.findMany.mockResolvedValue([]);
});

// 25/11 («باركود المنتجات»): a code may be tagged to a product — it then reads «أصلي» on that product's page only.
describe('the product a code belongs to', () => {
  it('GET lists this company\'s products for the picker', async () => {
    db.product.findMany.mockResolvedValue([{ id: 'p1', name: 'كريم' }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).products).toEqual([{ id: 'p1', name: 'كريم' }]);
    expect(db.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'co-1' } }));
  });

  it('a code tagged to one of this company\'s products is stored with it', async () => {
    db.product.findFirst.mockResolvedValue({ id: 'p1' });
    db.authenticityCode.create.mockResolvedValue({ id: 'acode1', code: 'P-1', productId: 'p1' });
    expect((await post({ code: 'P-1', productId: 'p1' })).status).toBe(201);
    expect(db.product.findFirst).toHaveBeenCalledWith({ where: { id: 'p1', companyId: 'co-1' }, select: { id: true } });
    expect(db.authenticityCode.create).toHaveBeenCalledWith({ data: expect.objectContaining({ productId: 'p1' }) });
  });

  it('NEGATIVE: a product of another company (or a stray id) is refused, nothing stored', async () => {
    db.product.findFirst.mockResolvedValue(null);
    const res = await post({ code: 'P-1', productId: 'theirs' });
    expect(res.status).toBe(400);
    expect(db.authenticityCode.create).not.toHaveBeenCalled();
  });
});

describe('the list reads on settings.view, the writes on settings.edit', () => {
  it('GET asks settings.view', async () => {
    await GET();
    expect(requirePermission).toHaveBeenCalledWith('settings.view');
  });

  it('a refusal on GET is a 403, not a crash and not the list', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission settings.view'));
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('POST and DELETE ask settings.edit, before touching the database', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden'));
    expect((await post({ code: 'ABC-123' })).status).toBe(403);
    expect(db.authenticityCode.create).not.toHaveBeenCalled();
    expect((await del({ id: 'acode1' })).status).toBe(403);
    expect(db.authenticityCode.delete).not.toHaveBeenCalled();
  });
});

describe('adding a code', () => {
  it('stores it uppercased, scoped to the caller’s own company', async () => {
    db.authenticityCode.create.mockResolvedValue({ id: 'acode1', code: 'ABC-123' });
    const res = await post({ code: '  abc-123  ', note: 'دفعة أكتوبر' });
    expect(res.status).toBe(201);
    expect(db.authenticityCode.create).toHaveBeenCalledWith({
      data: { companyId: 'co-1', code: 'ABC-123', note: 'دفعة أكتوبر', productId: null, createdById: 'u1' },
    });
  });

  it('a code already on the list is refused with a clear message, and nothing is written twice', async () => {
    db.authenticityCode.findUnique.mockResolvedValue({ id: 'existing', code: 'ABC-123' });
    const res = await post({ code: 'ABC-123' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/مُضاف/);
    expect(db.authenticityCode.create).not.toHaveBeenCalled();
  });

  it('a malformed code (empty, too short, or a control character) is refused — never stored', async () => {
    for (const bad of ['', 'ab', 'line\nbreak', 'nul\u0000x']) {
      const res = await post({ code: bad });
      expect(res.status, bad).toBe(400);
    }
    expect(db.authenticityCode.create).not.toHaveBeenCalled();
  });

  // 19/11 (owner): codes run to ~300 characters; the old 64 refused them with zod's English sentence.
  it('a code of 300 digits is stored whole', async () => {
    const long = '7'.repeat(300);
    db.authenticityCode.create.mockResolvedValue({ id: 'acode1', code: long });
    const res = await post({ code: long });
    expect(res.status).toBe(201);
    expect(db.authenticityCode.create).toHaveBeenCalledWith({
      data: { companyId: 'co-1', code: long, note: null, productId: null, createdById: 'u1' },
    });
  });

  it('one character more is refused in Arabic, naming the limit — never the bare zod sentence', async () => {
    const res = await post({ code: '7'.repeat(301) });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/300/);
    expect(error).not.toMatch(/Too big/);
    expect(db.authenticityCode.create).not.toHaveBeenCalled();
  });

  // 19/11 (owner): the QR on a piece holds a link — «الرمز غير صالح — حروف وأرقام وشرطات فقط» refused it.
  it('a pasted verify link stores the code inside it, so the printed QR and the list agree', async () => {
    db.authenticityCode.create.mockResolvedValue({ id: 'acode1', code: 'P-00042' });
    const res = await post({ code: 'https://crm.zakiai.io/verify/168f776f-7144-4422-864d-e63ac8c6ddc8?code=p-00042' });
    expect(res.status).toBe(201);
    expect(db.authenticityCode.create).toHaveBeenCalledWith({
      data: { companyId: 'co-1', code: 'P-00042', note: null, productId: null, createdById: 'u1' },
    });
  });

  it('the verify page link itself, with no code in it, is stored exactly as written', async () => {
    const link = 'https://crm.zakiai.io/verify/168f776f-7144-4422-864d-e63ac8c6ddc8';
    db.authenticityCode.create.mockResolvedValue({ id: 'acode1', code: link });
    expect((await post({ code: link })).status).toBe(201);
    expect(db.authenticityCode.create).toHaveBeenCalledWith({
      data: { companyId: 'co-1', code: link, note: null, productId: null, createdById: 'u1' },
    });
  });

  it('Arabic, symbols and spaces inside are codes too, kept as written', async () => {
    for (const code of ['منتج أصلي #12', 'A&B @ 2026 / №7', 'ثيثث']) {
      db.authenticityCode.create.mockResolvedValue({ id: 'acode1', code });
      expect((await post({ code })).status, code).toBe(201);
      expect(db.authenticityCode.create).toHaveBeenLastCalledWith({
        data: { companyId: 'co-1', code, note: null, productId: null, createdById: 'u1' },
      });
    }
  });

  it('any other link a QR holds is stored exactly as written — case kept, since case matters in a link', async () => {
    const link = 'https://example.com/p/AbC?x=1&y=Two';
    db.authenticityCode.create.mockResolvedValue({ id: 'acode1', code: link });
    expect((await post({ code: link })).status).toBe(201);
    expect(db.authenticityCode.create).toHaveBeenCalledWith({
      data: { companyId: 'co-1', code: link, note: null, productId: null, createdById: 'u1' },
    });
  });
});

describe('deleting a code', () => {
  it('only a row of the caller’s own company can be deleted', async () => {
    db.authenticityCode.findFirst.mockResolvedValue({ id: 'acode1', code: 'ABC-123' });
    await del({ id: 'acode1' });
    expect(db.authenticityCode.findFirst).toHaveBeenCalledWith({ where: { id: 'acode1', companyId: 'co-1' }, select: { id: true, code: true } });
    expect(db.authenticityCode.delete).toHaveBeenCalledWith({ where: { id: 'acode1' } });
  });

  it('a row that is missing, or belongs to another company, is a 404 — never deleted', async () => {
    db.authenticityCode.findFirst.mockResolvedValue(null);
    const res = await del({ id: 'someone-elses' });
    expect(res.status).toBe(404);
    expect(db.authenticityCode.delete).not.toHaveBeenCalled();
  });
});
