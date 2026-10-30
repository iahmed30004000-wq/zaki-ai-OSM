import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «لا شركة في السياق» — PRESSED BY THE OWNER, ON HIS OWN SYSTEM.
 *
 * He opened the product form, went to add a category, and the server
 * refused him with those four words. The categories list had been empty
 * the whole time, which read as «nobody has made one yet».
 *
 * A SUPER_ADMIN is a PLATFORM account: `user.companyId` is null on it, and
 * he works inside a company through the context selector. This door read
 * that null as «belongs to no company»:
 *
 *   GET    → `{ categories: [] }`   — an empty shelf list, for ever
 *   POST   → 400 «لا شركة في السياق»
 *   PATCH  → the same
 *   DELETE → the same
 *
 * So the one account that may arrange the shelves was the only one that
 * could not. And the capability was not decorative: `products.list`
 * narrows by `categoryId` for anyone whose permission is scoped to
 * categories, so «this person sees only the skincare line» was a setting
 * the permissions screen offered, the service enforced, and nobody could
 * ever configure.
 *
 * `requireCompanyTenant()` is what the rest of the system already uses for
 * exactly this: the platform's company for a SUPER_ADMIN, the user's own
 * for everybody else, and a throw for a user who has neither. Nothing
 * widens; one null stops being read as an answer.
 *
 * These claims are about the ANSWER, not about the source text: they run
 * the door with a company-less owner behind it and read the status and the
 * body.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { requireAuth, requireCompanyTenant, can, db, logAudit } = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireCompanyTenant: vi.fn(),
  can: vi.fn(),
  db: {
    category: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  logAudit: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: (...a: unknown[]) => requireAuth(...a),
  requireCompanyTenant: (...a: unknown[]) => requireCompanyTenant(...a),
}));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a) }));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
  forbiddenAr: () => 'لا تملك الصلاحية.',
}));

import { GET, POST } from './route';

/** The owner's real shape: a platform account with no company on it. */
const OWNER = { id: 'u-owner', name: 'المالك', role: 'SUPER_ADMIN', companyId: null };

const post = async (body: unknown): Promise<Response> => {
  const res = await POST(
    new Request('http://localhost/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  // A door that answers nothing at all is its own failure, and reading
  // `.status` off `undefined` would report it as something else entirely.
  if (!res) throw new Error('POST /api/categories answered nothing');
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue(OWNER);
  // What the real one does for a SUPER_ADMIN: resolve the platform's company.
  requireCompanyTenant.mockResolvedValue({ user: OWNER, companyId: 'c1' });
  can.mockReturnValue(true);
  db.category.findMany.mockResolvedValue([{ id: 'cat1', name: 'العناية بالبشرة', nameEn: null }]);
  db.category.findFirst.mockResolvedValue(null);
  db.category.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'cat-new',
    name: data.name,
    nameEn: data.nameEn ?? null,
  }));
  logAudit.mockResolvedValue(undefined);
});

describe('the owner, whose account carries no company', () => {
  it('sees the company’s categories instead of an empty list', async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.categories, 'القائمة رجعت فاضية للمالك').toHaveLength(1);
    expect(db.category.findMany.mock.calls[0][0].where.companyId).toBe('c1');
  });

  it('and can name a new one — not refused with «لا شركة في السياق»', async () => {
    const res = await post({ name: 'العطور' });
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(JSON.stringify(body)).not.toContain('لا شركة في السياق');
    expect(body.category.name).toBe('العطور');
  });

  it('and the new one is filed under the resolved company, never under a null', async () => {
    // The company has to come from the resolver, because there is nothing
    // on his account to take it from — and a category written with
    // `companyId: null` would belong to nobody and show up for nobody.
    await post({ name: 'العطور' });

    const written = db.category.create.mock.calls[0][0].data;
    expect(written.companyId, 'التصنيف انكتب بلا شركة').toBe('c1');
  });

  it('and the audit line is filed under the same company', async () => {
    await post({ name: 'العطور' });
    expect(logAudit.mock.calls[0][0].companyId).toBe('c1');
  });
});

describe('and nothing widened while fixing it', () => {
  // was: 'a user without products.edit still cannot name one' — the writes ask categories.manage since PR-11.
  it('a user without categories.manage still cannot name one', async () => {
    can.mockReturnValue(false);
    const res = await post({ name: 'العطور' });

    expect(res.status).toBe(403);
    expect(can).toHaveBeenCalledWith(expect.anything(), 'categories.manage');
    expect(db.category.create).not.toHaveBeenCalled();
  });

  it('a user with no company and no platform role is still refused', async () => {
    // `requireCompanyTenant` throws for this case, and the route must not
    // swallow it into a create with an undefined company.
    requireCompanyTenant.mockRejectedValue(new Error('User has no assigned company tenant'));
    const res = await post({ name: 'العطور' });

    expect(res.status).toBe(500);
    expect(db.category.create).not.toHaveBeenCalled();
  });

  it('and a duplicate name is still refused by name, not by a constraint error', async () => {
    db.category.findFirst.mockResolvedValue({ id: 'cat1' });
    const res = await post({ name: 'العناية بالبشرة' });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('يوجد تصنيف بهذا الاسم');
  });

  it('and a name too short is still refused before any write', async () => {
    const res = await post({ name: 'ا' });
    expect(res.status).toBe(400);
    expect(db.category.create).not.toHaveBeenCalled();
  });
});
