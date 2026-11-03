import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  draft: { isEnabled: true },
  dest: 'iframe' as string | null,
  cookie: 's1' as string | undefined,
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('next/headers', () => ({
  draftMode: async () => h.draft,
  headers: async () => ({ get: (k: string) => (k === 'sec-fetch-dest' ? h.dest : null) }),
  cookies: async () => ({ get: () => (h.cookie ? { value: h.cookie } : undefined) }),
}));
vi.mock('./geo-context', () => ({ requireContext: () => h.requireContext() }));
vi.mock('./authorization', () => ({ requirePermission: (k: string) => h.requirePermission(k) }));
vi.mock('./db', () => ({ db: { store: { findFirst: (a: unknown) => h.findFirst(a) } } }));

import { previewStoreIdFor } from './store-preview';

/**
 * «المعاينة الحقيقية» DRAWS A DRAFT ONLY FOR THE SELLER'S OWN FRAME.
 *
 * Every one of the five conditions is taken away in turn, and each alone is
 * enough to make the shop the live one again.
 */
beforeEach(() => {
  h.draft = { isEnabled: true };
  h.dest = 'iframe';
  h.cookie = 's1';
  h.requireContext.mockReset().mockResolvedValue({ companyId: 'c1', storeId: 's1' });
  h.requirePermission.mockReset().mockResolvedValue(undefined);
  h.findFirst.mockReset().mockResolvedValue({ id: 's1' });
});

describe('who gets the draft', () => {
  it('the seller of this store, in a frame, after the door turned it on', async () => {
    expect(await previewStoreIdFor('my-shop')).toBe('s1');
    expect(h.requirePermission).toHaveBeenCalledWith('storefront.view');
    // The store is looked up by the SESSION's store and company, and by this address.
    expect(h.findFirst.mock.calls[0][0].where).toEqual({ id: 's1', companyId: 'c1', slug: 'my-shop' });
  });

  it.each([
    ['draft mode off — every customer', () => { h.draft = { isEnabled: false }; }],
    ['the same seller, in a TAB', () => { h.dest = 'document'; }],
    ['no frame header at all', () => { h.dest = null; }],
    ['no preview cookie', () => { h.cookie = undefined; }],
    ['no session', () => { h.requireContext.mockRejectedValue(new Error('UNAUTHORIZED')); }],
    ['no permission', () => { h.requirePermission.mockRejectedValue(new Error('FORBIDDEN')); }],
    ['the cookie names another store', () => { h.cookie = 's2'; }],
    ['the address is another company’s shop (or not the session’s store)', () => { h.findFirst.mockResolvedValue(null); }],
  ])('nobody else: %s', async (_what, arrange) => {
    arrange();
    expect(await previewStoreIdFor('my-shop')).toBeNull();
  });

  it('and never throws — outside a request it is simply no preview', async () => {
    h.findFirst.mockRejectedValue(new Error('db down'));
    await expect(previewStoreIdFor('my-shop')).resolves.toBeNull();
  });
});
