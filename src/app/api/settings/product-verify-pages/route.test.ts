import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/settings/product-verify-pages` — «باركود المنتجات», the owner's designs.
 *
 * Covers: the list reads on `settings.view`, every write asks `settings.edit` BEFORE the database; a product of
 * another company is not found; validation answers in Arabic; a short link is unique across every page and every
 * old slug («الرابط مستعمل لمنتج تاني»); changing it keeps the old one as a redirect; every write is audited.
 */

const { db, tx, requireContext, requirePermission, logAudit } = vi.hoisted(() => {
  const tx = {
    productVerifyPageSlug: { upsert: vi.fn(), deleteMany: vi.fn() },
    productVerifyPage: { update: vi.fn() },
  };
  return {
    tx,
    db: {
      product: { findFirst: vi.fn(), findMany: vi.fn() },
      productVerifyPage: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
      productVerifyPageSlug: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    logAudit: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { DELETE, GET, PATCH, POST } from './route';

const URL_ = 'http://x/api/settings/product-verify-pages';
const send = (fn: typeof POST, method: string, body: unknown) =>
  fn(new Request(URL_, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

const PRODUCT = { id: 'prod-1', name: 'كريم الأذن', nameEn: 'Ear Cream', sku: 'EAR-01' };

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'co-1' });
  requirePermission.mockResolvedValue(undefined);
  db.product.findFirst.mockResolvedValue(PRODUCT);
  db.product.findMany.mockResolvedValue([]);
  db.productVerifyPage.findMany.mockResolvedValue([]);
  db.productVerifyPage.findUnique.mockResolvedValue(null);
  db.productVerifyPageSlug.findUnique.mockResolvedValue(null);
  db.productVerifyPage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'page-1', active: true, ...data }));
});

describe('the list reads on settings.view, the writes on settings.edit', () => {
  it('GET asks settings.view, and lists only this company', async () => {
    await GET(new Request(URL_));
    expect(requirePermission).toHaveBeenCalledWith('settings.view');
    expect(db.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'co-1' } }));
    expect(db.productVerifyPage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'co-1' } }));
  });

  it('NEGATIVE: a refusal is a 403 on every method, before the database is written', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission settings.edit'));
    expect((await GET(new Request(URL_))).status).toBe(403);
    expect((await send(POST, 'POST', { productId: 'prod-1' })).status).toBe(403);
    expect((await send(PATCH, 'PATCH', { id: 'page-1', headline: 'x' })).status).toBe(403);
    expect((await send(DELETE, 'DELETE', { id: 'page-1' })).status).toBe(403);
    expect(db.productVerifyPage.create).not.toHaveBeenCalled();
    expect(tx.productVerifyPage.update).not.toHaveBeenCalled();
    expect(db.productVerifyPage.delete).not.toHaveBeenCalled();
  });

  it('the writes ask settings.edit — not settings.view', async () => {
    await send(POST, 'POST', { productId: 'prod-1' });
    expect(requirePermission).toHaveBeenCalledWith('settings.edit');
    expect(requirePermission).not.toHaveBeenCalledWith('settings.view');
  });
});

describe('creating a product page', () => {
  it('suggests a free short link from the product when none is sent, with a random public id', async () => {
    const res = await send(POST, 'POST', { productId: 'prod-1' });
    expect(res.status).toBe(201);
    const data = db.productVerifyPage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ companyId: 'co-1', productId: 'prod-1', slug: 'ear-cream', createdById: 'u1' });
    expect(data.publicId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_VERIFY_PAGE_CREATED', entityId: 'page-1' }));
  });

  it('GET ?suggest= gives the same suggestion, numbered when it is taken', async () => {
    db.productVerifyPage.findUnique.mockImplementation(async ({ where }: { where: { slug: string } }) => (where.slug === 'ear-cream' ? { id: 'other' } : null));
    const res = await GET(new Request(`${URL_}?suggest=prod-1`));
    expect(await res.json()).toEqual({ slug: 'ear-cream-2' });
  });

  it('NEGATIVE: another company\'s product is not found', async () => {
    db.product.findFirst.mockResolvedValue(null);
    expect((await send(POST, 'POST', { productId: 'theirs' })).status).toBe(404);
    expect(db.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'theirs', companyId: 'co-1' } }));
  });

  it('NEGATIVE: one page per product', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue({ id: 'page-0' });
    expect((await send(POST, 'POST', { productId: 'prod-1' })).status).toBe(409);
  });

  it('NEGATIVE: a short link another page has — now or before — is refused in the owner\'s words', async () => {
    db.productVerifyPageSlug.findUnique.mockResolvedValue({ pageId: 'page-9' });
    const res = await send(POST, 'POST', { productId: 'prod-1', slug: 'krem' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('الرابط مستعمل لمنتج تاني');
    expect(db.productVerifyPage.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ slug: 'api' }, 'محجوزة'],
    [{ slug: 'a' }, 'قصير'],
    [{ primaryColor: 'blue' }, 'اللون'],
    [{ imageUrl: 'http://x.example/a.png' }, 'https://'],
  ])('NEGATIVE: %j is a 400 in Arabic', async (design, word) => {
    const res = await send(POST, 'POST', { productId: 'prod-1', ...design });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(word);
    expect(db.productVerifyPage.create).not.toHaveBeenCalled();
  });
});

describe('changing a page', () => {
  beforeEach(() => {
    db.productVerifyPage.findFirst.mockResolvedValue({ id: 'page-1', slug: 'krem-old', active: true });
    tx.productVerifyPage.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'page-1', slug: 'krem-old', active: true, oldSlugs: [], ...data }));
  });

  it('a new short link keeps the old one as this page\'s, for the redirect', async () => {
    const res = await send(PATCH, 'PATCH', { id: 'page-1', slug: 'krem' });
    expect(res.status).toBe(200);
    expect(tx.productVerifyPageSlug.upsert).toHaveBeenCalledWith({
      where: { slug: 'krem-old' },
      create: { slug: 'krem-old', pageId: 'page-1' },
      update: {},
    });
    expect(tx.productVerifyPage.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'page-1' }, data: expect.objectContaining({ slug: 'krem' }) }));
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRODUCT_VERIFY_PAGE_UPDATED', previousData: expect.objectContaining({ slug: 'krem-old' }), newData: expect.objectContaining({ slug: 'krem' }) })
    );
  });

  it('the same slug again writes no history', async () => {
    await send(PATCH, 'PATCH', { id: 'page-1', slug: 'krem-old', headline: 'عنوان' });
    expect(tx.productVerifyPageSlug.upsert).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a slug another page has is refused, and nothing is written', async () => {
    db.productVerifyPage.findUnique.mockResolvedValue({ id: 'page-2' });
    const res = await send(PATCH, 'PATCH', { id: 'page-1', slug: 'taken' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('الرابط مستعمل لمنتج تاني');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('NEGATIVE: another company\'s page is not found', async () => {
    db.productVerifyPage.findFirst.mockResolvedValue(null);
    expect((await send(PATCH, 'PATCH', { id: 'page-x', headline: 'x' })).status).toBe(404);
    expect(db.productVerifyPage.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'page-x', companyId: 'co-1' } }));
  });

  it('switching it off is a save like any other', async () => {
    await send(PATCH, 'PATCH', { id: 'page-1', active: false });
    expect(tx.productVerifyPage.update).toHaveBeenCalledWith(expect.objectContaining({ data: { active: false } }));
  });

  it('DELETE removes only this company\'s page, audited', async () => {
    db.productVerifyPage.findFirst.mockResolvedValue({ id: 'page-1', slug: 'krem', productId: 'prod-1' });
    expect((await send(DELETE, 'DELETE', { id: 'page-1' })).status).toBe(200);
    expect(db.productVerifyPage.delete).toHaveBeenCalledWith({ where: { id: 'page-1' } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_VERIFY_PAGE_DELETED' }));
  });
});
