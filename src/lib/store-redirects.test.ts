import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = vi.hoisted(() => ({
  db: {
    landingPage: { findFirst: vi.fn() },
    storeRedirect: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import {
  isSelfRedirect,
  standDownRedirectsTo,
  landingSlugOf,
  mayClaimFrom,
  redirectCreateSchema,
  redirectFor,
  forgetRedirects,
  suggestSlugRedirect,
} from './store-redirects';

const STORE = { id: 's1', slug: 'seha', companyId: 'c1' };

beforeEach(() => {
  vi.resetAllMocks();
  forgetRedirects();
  db.landingPage.findFirst.mockResolvedValue(null);
  db.storeRedirect.findMany.mockResolvedValue([]);
  db.storeRedirect.upsert.mockResolvedValue({});
});

describe('a shop cannot forward somebody else’s address', () => {
  it('refuses /lp/<slug> while another company’s page holds that slug', async () => {
    // Without this, store A adds a redirect for B's live address and takes
    // B's already-paid traffic to A's shop.
    db.landingPage.findFirst.mockResolvedValue({ id: 'other-company-page', companyId: 'c2' });
    const verdict = await mayClaimFrom('/lp/their-offer', STORE);
    expect(verdict.ok).toBe(false);
    // The lookup is about the ADDRESS, not about who asks: a live page wins
    // whoever owns it.
    expect(db.landingPage.findFirst.mock.calls[0][0].where).toMatchObject({ slug: 'their-offer' });
  });

  it('refuses one of the shop’s OWN live pages — that would take it off the air', async () => {
    // The paths differ, so the self-redirect guard never sees this one.
    db.landingPage.findFirst.mockResolvedValue({ id: 'my-own-page', companyId: 'c1' });
    const verdict = await mayClaimFrom('/lp/my-live-offer', STORE);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error).toContain('صفحة عندك');
  });

  it('allows a slug nobody else holds — which is the case right after a rename', async () => {
    expect((await mayClaimFrom('/lp/my-old-slug', STORE)).ok).toBe(true);
  });

  it('allows a path under the shop’s own storefront without asking anything', async () => {
    for (const from of ['/s/seha', '/s/seha/p/sku-1', '/s/seha/pages/privacy']) {
      expect((await mayClaimFrom(from, STORE)).ok, from).toBe(true);
    }
    expect(db.landingPage.findFirst).not.toHaveBeenCalled();
  });

  it('refuses another store’s storefront path', async () => {
    expect((await mayClaimFrom('/s/other-shop/p/x', STORE)).ok).toBe(false);
  });

  it('refuses the app’s own paths — a redirect is for the shop’s old addresses', async () => {
    for (const from of ['/orders', '/dashboard', '/admin/users', '/login', '/']) {
      expect((await mayClaimFrom(from, STORE)).ok, from).toBe(false);
    }
  });
});

describe('an address another company already forwards is not free', () => {
  it('refuses /lp/<slug> when another company holds a redirect from it, suggested or accepted', async () => {
    db.storeRedirect.findFirst.mockResolvedValue({ companyId: 'c2' });
    const verdict = await mayClaimFrom('/lp/just-renamed', STORE);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error).toContain('شركة أخرى');
    // No filter on suggested/isActive: a suggestion is a claim too.
    const where = db.storeRedirect.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ from: '/lp/just-renamed', companyId: { not: 'c1' } });
    expect(where.suggested).toBeUndefined();
    expect(where.isActive).toBeUndefined();
  });

  it('NEGATIVE: the same company’s redirect is not another company’s', async () => {
    // The query excludes it, and the row is checked again in code.
    db.storeRedirect.findFirst.mockResolvedValue({ companyId: 'c1' });
    expect((await mayClaimFrom('/lp/mine-already', STORE)).ok).toBe(true);
  });

  it('NEGATIVE: nobody forwarding it leaves the address claimable', async () => {
    expect((await mayClaimFrom('/lp/free-address', STORE)).ok).toBe(true);
  });

  it('a live page is still refused first, with its own sentence', async () => {
    db.landingPage.findFirst.mockResolvedValue({ id: 'p', companyId: 'c1' });
    db.storeRedirect.findFirst.mockResolvedValue({ companyId: 'c2' });
    const verdict = await mayClaimFrom('/lp/both', STORE);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error).toContain('صفحة عندك');
  });

  it('the shop’s own storefront paths never ask', async () => {
    db.storeRedirect.findFirst.mockResolvedValue({ companyId: 'c2' });
    expect((await mayClaimFrom('/s/seha/p/x', STORE)).ok).toBe(true);
    expect(db.storeRedirect.findFirst).not.toHaveBeenCalled();
  });
});

describe('a live page always beats a redirect', () => {
  it('a page taking a slug stands down whatever forwards away from it', async () => {
    db.storeRedirect.updateMany.mockResolvedValue({ count: 1 });
    await standDownRedirectsTo('now-a-page');
    const call = db.storeRedirect.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ from: '/lp/now-a-page', isActive: true });
    expect(call.data).toEqual({ isActive: false });
  });

  it('whoever owns it — the address is one space for every company', async () => {
    // A redirect another company claimed while the slug was free would
    // otherwise keep sending this page's visitors away, and its owner would
    // have nothing to look at.
    db.storeRedirect.updateMany.mockResolvedValue({ count: 1 });
    await standDownRedirectsTo('x');
    expect(db.storeRedirect.updateMany.mock.calls[0][0].where.companyId).toBeUndefined();
  });

  it('deactivated, not deleted, so the seller can see it happened', async () => {
    db.storeRedirect.updateMany.mockResolvedValue({ count: 1 });
    await standDownRedirectsTo('x');
    expect(db.storeRedirect.updateMany.mock.calls[0][0].data).toEqual({ isActive: false });
  });
});

describe('a redirect that eats itself', () => {
  it.each([
    ['/lp/a', '/lp/a'],
    ['/lp/a', '/lp/a/'],
  ])('%s → %s is a loop', (from, to) => {
    expect(isSelfRedirect(from, to)).toBe(true);
  });

  it('a real move is not', () => {
    expect(isSelfRedirect('/lp/old', '/lp/new')).toBe(false);
  });
});

describe('what a redirect may be', () => {
  it.each([
    ['//evil.example'],
    ['/\\evil.example'],
    ['/lp/x?c=ad1'],
    ['/lp/x#top'],
    ['lp/x'],
    ['https://example.com/x'],
  ])('the source %s is refused', (from) => {
    // A source carrying a query would silently never match: the proxy
    // compares the PATH. An absolute source is not an address we serve.
    expect(redirectCreateSchema.safeParse({ from, to: '/lp/y' }).success, from).toBe(false);
  });

  it.each([['//evil.example'], ['javascript:alert(1)'], ['data:text/html,x'], ['']])(
    'the destination %s is refused',
    (to) => {
      expect(redirectCreateSchema.safeParse({ from: '/lp/x', to }).success, to).toBe(false);
    }
  );

  it('sends somebody away only to a path here or an http(s) address', () => {
    for (const to of ['/lp/new', '/s/seha', 'https://example.com/promo']) {
      expect(redirectCreateSchema.safeParse({ from: '/lp/x', to }).success, to).toBe(true);
    }
  });

  it('defaults to 302, because a wrong 301 is cached hard and hard to undo', () => {
    expect(redirectCreateSchema.parse({ from: '/lp/x', to: '/lp/y' }).kind).toBe(302);
  });

  it('accepts no status but 301 and 302', () => {
    for (const kind of [200, 307, 308, 404, 0]) {
      expect(redirectCreateSchema.safeParse({ from: '/lp/x', to: '/lp/y', kind }).success, String(kind)).toBe(false);
    }
  });
});

describe('a suggestion does not forward', () => {
  it('is left out of what the proxy matches on', async () => {
    await redirectFor('/lp/anything');
    // The one query the request path makes: live and decided only.
    expect(db.storeRedirect.findMany.mock.calls[0][0].where).toMatchObject({ isActive: true, suggested: false });
  });

  it('a slug change writes one, unapplied', async () => {
    await suggestSlugRedirect({ companyId: 'c1', storeId: 's1', oldSlug: 'old', newSlug: 'new' });
    const call = db.storeRedirect.upsert.mock.calls[0][0];
    expect(call.create).toMatchObject({ from: '/lp/old', to: '/lp/new', kind: 302, suggested: true });
  });

  it('and does not overwrite a redirect the seller already decided on that path', async () => {
    await suggestSlugRedirect({ companyId: 'c1', storeId: 's1', oldSlug: 'old', newSlug: 'new' });
    expect(db.storeRedirect.upsert.mock.calls[0][0].update).toEqual({});
  });

  it('is not written for a page that belongs to no store, or a slug that did not change', async () => {
    await suggestSlugRedirect({ companyId: 'c1', storeId: null, oldSlug: 'a', newSlug: 'b' });
    await suggestSlugRedirect({ companyId: 'c1', storeId: 's1', oldSlug: 'same', newSlug: 'same' });
    expect(db.storeRedirect.upsert).not.toHaveBeenCalled();
  });

  it('never fails the rename it came from', async () => {
    db.storeRedirect.upsert.mockRejectedValue(new Error('db down'));
    await expect(
      suggestSlugRedirect({ companyId: 'c1', storeId: 's1', oldSlug: 'old', newSlug: 'new' })
    ).resolves.toBeUndefined();
  });
});

describe('matching a path', () => {
  it('finds the redirect and its status', async () => {
    db.storeRedirect.findMany.mockResolvedValue([{ id: 'r1', from: '/lp/old', to: '/lp/new', kind: 301 }]);
    expect(await redirectFor('/lp/old')).toEqual({ id: 'r1', to: '/lp/new', kind: 301 });
    expect(await redirectFor('/lp/other')).toBeNull();
  });

  it('a status that is neither 301 nor 302 in the row reads as 302', async () => {
    db.storeRedirect.findMany.mockResolvedValue([{ id: 'r1', from: '/lp/old', to: '/lp/new', kind: 307 }]);
    expect((await redirectFor('/lp/old'))?.kind).toBe(302);
  });

  it('two claims on one path resolve to the older, so the answer never depends on row order', async () => {
    db.storeRedirect.findMany.mockResolvedValue([
      { id: 'older', from: '/lp/x', to: '/a', kind: 302 },
      { id: 'newer', from: '/lp/x', to: '/b', kind: 302 },
    ]);
    expect((await redirectFor('/lp/x'))?.id).toBe('older');
    // The order asked for is what makes "older" mean anything.
    expect(db.storeRedirect.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
  });

  it('a database briefly out of reach turns no page into an error', async () => {
    db.storeRedirect.findMany.mockRejectedValue(new Error('db down'));
    expect(await redirectFor('/lp/old')).toBeNull();
  });

  it('reads the table once for many requests', async () => {
    db.storeRedirect.findMany.mockResolvedValue([]);
    await redirectFor('/lp/a');
    await redirectFor('/lp/b');
    await redirectFor('/lp/c');
    expect(db.storeRedirect.findMany).toHaveBeenCalledTimes(1);
  });

  it('and reads it again the moment one is saved', async () => {
    db.storeRedirect.findMany.mockResolvedValue([]);
    await redirectFor('/lp/a');
    forgetRedirects();
    await redirectFor('/lp/a');
    expect(db.storeRedirect.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('reading a source path', () => {
  it('picks out the landing slug, and nothing that is not one', () => {
    expect(landingSlugOf('/lp/winter-offer')).toBe('winter-offer');
    expect(landingSlugOf('/lp/winter-offer/raw')).toBeNull();
    expect(landingSlugOf('/s/seha')).toBeNull();
    expect(landingSlugOf('/lp/X')).toBeNull();
  });
});
