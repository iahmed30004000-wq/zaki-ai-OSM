import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/settings/authenticity-codes` — the owner's own list, one add at a time.
 *
 * Covers: permission-gated (GET and every write ask `settings.authenticity_codes`), dedupe on add with a
 * clear message, delete removes exactly the row asked for (never another company's), and the public shape
 * (`note`/`productId`/`createdById`) never leaks anywhere this route does not explicitly return it from.
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    authenticityCode: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
    store: { findMany: vi.fn() },
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
});

describe('every door asks settings.authenticity_codes', () => {
  it('GET asks it', async () => {
    await GET();
    expect(requirePermission).toHaveBeenCalledWith('settings.authenticity_codes');
  });

  it('a refusal on GET is a 403, not a crash and not the list', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission settings.authenticity_codes'));
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('POST and DELETE ask it too, before touching the database', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden'));
    expect((await post({ code: 'ABC-123' })).status).toBe(403);
    expect(db.authenticityCode.create).not.toHaveBeenCalled();
    expect((await del({ id: 'row-1' })).status).toBe(403);
    expect(db.authenticityCode.delete).not.toHaveBeenCalled();
  });
});

describe('adding a code', () => {
  it('stores it uppercased, scoped to the caller’s own company', async () => {
    db.authenticityCode.create.mockResolvedValue({ id: 'row-1', code: 'ABC-123' });
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

  it('a malformed code (too short, or outside letters/digits/dashes) is refused — never stored', async () => {
    for (const bad of ['', 'ab', 'has a space', 'ثيثث']) {
      const res = await post({ code: bad });
      expect(res.status, bad).toBe(400);
    }
    expect(db.authenticityCode.create).not.toHaveBeenCalled();
  });
});

describe('deleting a code', () => {
  it('only a row of the caller’s own company can be deleted', async () => {
    db.authenticityCode.findFirst.mockResolvedValue({ id: 'row-1', code: 'ABC-123' });
    await del({ id: 'row-1' });
    expect(db.authenticityCode.findFirst).toHaveBeenCalledWith({ where: { id: 'row-1', companyId: 'co-1' }, select: { id: true, code: true } });
    expect(db.authenticityCode.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
  });

  it('a row that is missing, or belongs to another company, is a 404 — never deleted', async () => {
    db.authenticityCode.findFirst.mockResolvedValue(null);
    const res = await del({ id: 'someone-elses' });
    expect(res.status).toBe(404);
    expect(db.authenticityCode.delete).not.toHaveBeenCalled();
  });
});
