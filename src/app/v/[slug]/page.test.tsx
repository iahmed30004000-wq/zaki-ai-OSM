import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/v/<slug>` — a printed barcode never breaks: an old slug answers a PERMANENT redirect (308, `permanentRedirect`) to
 * the current one with the piece's `?code=` carried along; an unknown or switched-off page is a 404. `/verify/p/<id>`
 * (the stable id) redirects the same way.
 */

const { lookupBySlug, slugForPublicId, nav } = vi.hoisted(() => ({
  lookupBySlug: vi.fn(),
  slugForPublicId: vi.fn(),
  nav: {
    permanentRedirect: vi.fn((to: string) => {
      throw Object.assign(new Error('NEXT_REDIRECT'), { to });
    }),
    notFound: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
  },
}));
vi.mock('next/navigation', () => nav);
vi.mock('@/lib/product-verify', () => ({ lookupBySlug, slugForPublicId }));
vi.mock('@/components/verify/ProductVerifyView', () => ({ ProductVerifyView: () => null }));

import Page from './page';
import ByIdPage from '../../verify/p/[publicId]/page';

const open = (slug: string, query: Record<string, string> = {}) =>
  Page({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(query) });

beforeEach(() => vi.clearAllMocks());

describe('/v/<slug>', () => {
  it('an OLD slug → 308 to the current one, the piece code carried along', async () => {
    lookupBySlug.mockResolvedValue({ kind: 'moved', slug: 'krem' });
    await expect(open('krem-old', { code: 'P 1' })).rejects.toThrow('NEXT_REDIRECT');
    expect(nav.permanentRedirect).toHaveBeenCalledWith('/v/krem?code=P+1');
  });

  it('an old slug with no code → the bare current link', async () => {
    lookupBySlug.mockResolvedValue({ kind: 'moved', slug: 'krem' });
    await expect(open('krem-old')).rejects.toThrow('NEXT_REDIRECT');
    expect(nav.permanentRedirect).toHaveBeenCalledWith('/v/krem');
  });

  it('NEGATIVE: unknown or switched off → 404, never a redirect', async () => {
    lookupBySlug.mockResolvedValue({ kind: 'none' });
    await expect(open('nope')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it('the current slug draws the page', async () => {
    lookupBySlug.mockResolvedValue({ kind: 'page', page: { publicId: 'AbCdEf123_-x' }, design: { backgroundColor: '#ffffff', name: 'x' } });
    await expect(open('krem')).resolves.toBeTruthy();
    expect(nav.notFound).not.toHaveBeenCalled();
  });
});

describe('/verify/p/<publicId>', () => {
  it('redirects (308) to the current short link, with the code', async () => {
    slugForPublicId.mockResolvedValue('krem');
    await expect(ByIdPage({ params: Promise.resolve({ publicId: 'AbCdEf123_-x' }), searchParams: Promise.resolve({ code: 'P-1' }) })).rejects.toThrow('NEXT_REDIRECT');
    expect(nav.permanentRedirect).toHaveBeenCalledWith('/v/krem?code=P-1');
  });

  it('NEGATIVE: unknown or off → 404', async () => {
    slugForPublicId.mockResolvedValue(null);
    await expect(ByIdPage({ params: Promise.resolve({ publicId: 'zzzzzzzzzzzz' }), searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
