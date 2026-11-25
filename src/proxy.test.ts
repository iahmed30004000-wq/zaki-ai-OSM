import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE EDGE PASS, FROM A SHOPPER'S SIDE.
 *
 * A shopper has no session. Everything a public page needs to draw itself
 * must reach them anyway; everything of the dashboard's must not. The
 * self-hosted font faces fell between the two — their extension is not in
 * the matcher's static-asset list, so the request reached the session check
 * and every public page was answered with a 302 to /login for its own font.
 */

const { hostSite, redirectFor, countRedirectHit } = vi.hoisted(() => ({
  hostSite: vi.fn(),
  redirectFor: vi.fn(),
  countRedirectHit: vi.fn(),
}));
vi.mock('@/lib/store-redirects', () => ({ redirectFor, countRedirectHit }));
vi.mock('@/lib/landing-domain', async (orig) => ({
  ...(await orig<typeof import('@/lib/landing-domain')>()),
  hostSite,
}));

import { proxy } from './proxy';

const get = (path: string, host = 'app.example.com', cookie?: string) =>
  proxy(
    new Request(`https://${host}${path}`, {
      headers: cookie ? { host, cookie } : { host },
    })
  );

const post = (path: string) =>
  proxy(new Request(`https://app.example.com${path}`, { method: 'POST', headers: { host: 'app.example.com' } }));

beforeEach(() => {
  vi.resetAllMocks();
  hostSite.mockResolvedValue(null); // the app's own hostname
  redirectFor.mockResolvedValue(null); // no old address claims this path
});

/**
 * AN ADDRESS AN ADVERTISEMENT STILL POINTS AT.
 *
 * The clicks are already paid for. These pin that the forward happens, that
 * it carries the campaign code (without which the sale loses its credit),
 * and that it can never touch an order being posted.
 */
describe('an old address that still arrives', () => {
  it('forwards a renamed landing page, with the status the seller chose', async () => {
    redirectFor.mockResolvedValue({ id: 'r1', to: '/lp/new', kind: 301 });
    const res = await get('/lp/old');
    expect(res.status).toBe(301);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/lp/new');
  });

  it('keeps the campaign code, so the sale keeps its credit', async () => {
    redirectFor.mockResolvedValue({ id: 'r1', to: '/lp/new', kind: 302 });
    const res = await get('/lp/old?c=ad-7');
    expect(new URL(res.headers.get('location')!).searchParams.get('c')).toBe('ad-7');
  });

  it('carries it onto an absolute destination too', async () => {
    redirectFor.mockResolvedValue({ id: 'r1', to: 'https://elsewhere.example/promo', kind: 302 });
    const url = new URL((await get('/lp/old?c=ad-7')).headers.get('location')!);
    expect(url.host).toBe('elsewhere.example');
    expect(url.searchParams.get('c')).toBe('ad-7');
  });

  it('counts the hit without the customer waiting on it', async () => {
    redirectFor.mockResolvedValue({ id: 'r1', to: '/lp/new', kind: 302 });
    await get('/lp/old');
    expect(countRedirectHit).toHaveBeenCalledWith('r1');
  });

  it('never swallows an order being posted', async () => {
    redirectFor.mockResolvedValue({ id: 'r1', to: '/lp/new', kind: 302 });
    const res = await post('/lp/old');
    expect(res.headers.get('location')).toBeNull();
    expect(redirectFor).not.toHaveBeenCalled();
  });

  it('is not consulted for the dashboard or the API', async () => {
    redirectFor.mockResolvedValue({ id: 'r1', to: '/lp/new', kind: 302 });
    await get('/orders');
    await get('/api/orders');
    expect(redirectFor).not.toHaveBeenCalled();
  });
});

describe('what a visitor with no session may fetch', () => {
  it.each([
    '/fonts/kawkab-300.woff2',
    '/fonts/kawkab-700.woff2',
    '/fonts/kawkab-OFL.txt',
  ])('%s — a face a public page declares, so it must not need signing in', async (path) => {
    const res = await get(path);
    expect(res.status, path).toBe(200);
    expect(res.headers.get('location'), path).toBeNull();
  });

  it.each(['/lp/winter', '/s/seha', '/login'])('%s passes through', async (path) => {
    expect((await get(path)).headers.get('location')).toBeNull();
  });

  // 19/11: the authenticity checker (#407) shipped answering its API but sending every customer to /login for the page itself.
  it('/verify/<store> — the public barcode checker — passes through', async () => {
    expect((await get('/verify/2f1c7a3e-0b9d-4c55-9a6e-1d2b3c4d5e6f')).headers.get('location')).toBeNull();
  });

  // 25/11 («باركود المنتجات»): a product's own page at its short address, and at its stable id — a printed barcode
  // opens either with no session.
  it.each(['/v/krem-alozn', '/v/krem-alozn?code=P-00042', '/verify/p/AbCdEf123_-x'])('%s — a product page — passes through', async (path) => {
    expect((await get(path)).headers.get('location')).toBeNull();
  });
});

describe('what it may not', () => {
  it.each(['/', '/orders', '/finance/wallets', '/fonts-admin', '/settings/tracking', '/verify-admin', '/vip', '/v-admin'])(
    '%s is the dashboard, and sends them to sign in',
    async (path) => {
      const res = await get(path);
      expect(res.status, path).toBe(307);
      expect(new URL(res.headers.get('location')!).pathname, path).toBe('/login');
    }
  );
});

describe("a seller's own domain", () => {
  it('serves the fonts from our own folder, not rewritten under the page', async () => {
    hostSite.mockResolvedValue({ path: '/lp/winter', companyId: 'c1' });
    const res = await get('/fonts/kawkab-300.woff2', 'shop.example.com');
    expect(hostSite).not.toHaveBeenCalled(); // skipped before the lookup
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
  });
});
