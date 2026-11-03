import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ requireContext: vi.fn(), requirePermission: vi.fn(), findMany: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({ requireContext: () => h.requireContext() }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (k: string) => h.requirePermission(k) }));
vi.mock('@/lib/db', () => ({ db: { product: { findMany: (a: unknown) => h.findMany(a) } } }));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  h.requireContext.mockResolvedValue({ companyId: 'c1', storeId: 's1' });
  h.requirePermission.mockResolvedValue(undefined);
  h.findMany.mockResolvedValue([
    { image: '/api/media/c1/a.jpg', images: [{ url: '/api/media/c1/a.jpg' }, { url: '/api/media/c1/b.jpg' }] },
    { image: null, images: [{ url: '/api/media/c1/c.jpg' }] },
  ]);
});

describe('«من صور منتجاتك»', () => {
  it('lists this store’s own product photographs, once each', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).photos).toEqual(['/api/media/c1/a.jpg', '/api/media/c1/b.jpg', '/api/media/c1/c.jpg']);
    expect(h.findMany.mock.calls[0][0].where).toEqual({ companyId: 'c1', storeId: 's1', status: 'ACTIVE' });
    expect(h.requirePermission).toHaveBeenCalledWith('storefront.view');
  });

  it('reads nothing for somebody without the permission', async () => {
    h.requirePermission.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const res = await GET();
    expect(res.status).not.toBe(200);
    expect(h.findMany).not.toHaveBeenCalled();
  });
});
