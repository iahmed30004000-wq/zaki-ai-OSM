import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  findFirst: vi.fn(),
  storeShelf: vi.fn(),
}));

vi.mock('next/headers', () => ({ draftMode: async () => ({ enable: h.enable, disable: h.disable, isEnabled: false }) }));
vi.mock('@/lib/geo-context', () => ({ requireContext: () => h.requireContext() }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (k: string) => h.requirePermission(k) }));
vi.mock('@/lib/db', () => ({ db: { store: { findFirst: (a: unknown) => h.findFirst(a) } } }));
vi.mock('@/lib/storefront', () => ({ storeShelf: (...a: unknown[]) => h.storeShelf(...a) }));

import { POST } from './route';

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/store/preview', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.requireContext.mockResolvedValue({ companyId: 'c1', storeId: 's1' });
  h.requirePermission.mockResolvedValue(undefined);
  h.findFirst.mockResolvedValue({ id: 's1', slug: 'my-shop', companyId: 'c1' });
  h.storeShelf.mockResolvedValue([
    { handle: 'towel', category: null },
    { handle: 'soap', category: { id: 'k9', name: 'حمّام' } },
  ]);
});

describe('the door into the real preview', () => {
  it.each([
    ['home', '/s/my-shop'],
    ['products', '/s/my-shop/shop'],
    ['category', '/s/my-shop/shop?cat=k9'],
    ['product', '/s/my-shop/p/towel'],
    ['search', '/s/my-shop/shop?q='],
    ['cart', '/s/my-shop/cart'],
  ])('opens «%s» at this shop’s own address', async (page, href) => {
    const res = await post({ page });
    expect(res.status).toBe(200);
    expect((await res.json()).href).toBe(href);
    expect(h.enable).toHaveBeenCalled();
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('set-cookie')).toContain('zaki-store-preview=s1');
  });

  it('reads the store by the session’s store AND company', async () => {
    await post({ page: 'home' });
    expect(h.findFirst.mock.calls[0][0].where).toEqual({ id: 's1', companyId: 'c1' });
    expect(h.requirePermission).toHaveBeenCalledWith('storefront.view');
  });

  it.each([
    ['no session', () => h.requireContext.mockRejectedValue(new Error('UNAUTHORIZED'))],
    ['no permission', () => h.requirePermission.mockRejectedValue(new Error('FORBIDDEN'))],
    ['a store that is not this company’s', () => h.findFirst.mockResolvedValue(null)],
  ])('answers «not found» to %s, and turns nothing on', async (_w, arrange) => {
    arrange();
    const res = await post({ page: 'home' });
    expect(res.status).toBe(404);
    expect(h.enable).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('and to a page it does not know', async () => {
    expect((await post({ page: 'admin' })).status).toBe(404);
    expect(h.enable).not.toHaveBeenCalled();
  });

  it('a shop with no products opens the shelf for «منتج» and «قسم»', async () => {
    h.storeShelf.mockResolvedValue([]);
    expect((await (await post({ page: 'product' })).json()).href).toBe('/s/my-shop/shop');
    expect((await (await post({ page: 'category' })).json()).href).toBe('/s/my-shop/shop');
  });

  it('`{ off: true }` turns it off again, for a signed-in seller', async () => {
    const res = await post({ off: true });
    expect(res.status).toBe(204);
    expect(h.disable).toHaveBeenCalled();
    expect(h.enable).not.toHaveBeenCalled();
  });

  it('and even turning it off asks who is calling', async () => {
    h.requireContext.mockRejectedValue(new Error('UNAUTHORIZED'));
    expect((await post({ off: true })).status).toBe(404);
    expect(h.disable).not.toHaveBeenCalled();
  });
});
