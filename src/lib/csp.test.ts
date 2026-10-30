import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import nextConfig from '../../next.config';
import { PIXEL_SCRIPT_ORIGINS, SELLING_PAGE_CSP, SELLING_PAGE_HEADERS } from './csp';

/**
 * PIXELS LOAD ON SELLING PAGES, AND NOWHERE ELSE.
 *
 * Every page used to send `script-src 'self'`, so the browser refused all
 * four pixel loaders and not one browser pixel ever fired — while the
 * dashboard, which should load none, asked for them on every screen.
 */

const directive = (csp: string, name: string) =>
  csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

describe('the selling-page policy', () => {
  it('lets every pixel loader in the adapters load — checked against the adapter source, so the two cannot drift', () => {
    const src = fs.readFileSync('src/lib/tracking/tracking-platforms.ts', 'utf8');
    const loaders = [...src.matchAll(/'(https:\/\/[^'/]+)\/[^']*'/g)].map((m) => m[1]);
    expect(loaders.length).toBeGreaterThanOrEqual(4);
    const scriptSrc = directive(SELLING_PAGE_CSP, 'script-src');
    for (const origin of loaders) expect(scriptSrc).toContain(origin);
  });

  it('still refuses to be framed by any other site', () => {
    expect(directive(SELLING_PAGE_CSP, 'frame-ancestors')).toBe("frame-ancestors 'self'");
  });
});

describe('which paths get which policy', () => {
  it('landing pages and every storefront path answer with the selling-page headers', async () => {
    const rules = await nextConfig.headers!();
    const lp = rules.find((r) => r.source === '/lp/:slug');
    const store = rules.find((r) => r.source === '/s/:path*');
    expect(lp?.headers).toBe(SELLING_PAGE_HEADERS);
    expect(store?.headers).toBe(SELLING_PAGE_HEADERS);
  });

  it('the dashboard keeps the shut policy — no pixel origin anywhere in it', async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === '/:path*')!;
    const csp = all.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
    for (const origin of PIXEL_SCRIPT_ORIGINS) expect(csp).not.toContain(origin);
  });

  it('the old tracking address sends people to the new one', async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects).toContainEqual(
      expect.objectContaining({ source: '/settings/pixels', destination: '/settings/tracking' })
    );
  });
});

describe('the uploaded HTML of a landing page', () => {
  it("is sandboxed by the header that actually reaches the browser — the config's", async () => {
    // Next writes the config's headers first and drops a route's same-named
    // one, so a sandbox sent only by the route never arrived.
    const rules = await nextConfig.headers!();
    const raw = rules.find((r) => r.source === '/lp/:slug/raw')!;
    const csp = raw.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
    const sandbox = directive(csp, 'sandbox');
    expect(sandbox).toContain('sandbox allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('cannot submit a form anywhere — the order form is ours, outside the frame', async () => {
    const rules = await nextConfig.headers!();
    const raw = rules.find((r) => r.source === '/lp/:slug/raw')!;
    const csp = raw.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
    expect(directive(csp, 'sandbox')).not.toContain('allow-forms');
    expect(csp).not.toContain('allow-forms');
    // belt and braces: even a sandbox that allowed forms could only post home
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
    // and what the page legitimately needs is still granted
    expect(directive(csp, 'sandbox')).toContain('allow-scripts');
    expect(directive(csp, 'sandbox')).toContain('allow-popups');
  });
});

describe("a shopper's stored image", () => {
  it('is inert, by the header that actually reaches the browser', async () => {
    // Same trap as the raw HTML above: the route sent `default-src 'none';
    // sandbox` and the browser was handed the dashboard's catch-all instead.
    const rules = await nextConfig.headers!();
    const media = rules.find((r) => r.source === '/api/public/media/:path*');
    expect(media, 'no rule for the public media route').toBeDefined();
    const csp = media!.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
    expect(directive(csp, 'default-src')).toBe("default-src 'none'");
    expect(csp).toContain('sandbox');
    expect(csp).not.toContain('allow-same-origin');
    expect(media!.headers).toContainEqual({ key: 'X-Content-Type-Options', value: 'nosniff' });
  });

  it('is declared after the catch-all, or the catch-all would win', async () => {
    const rules = await nextConfig.headers!();
    const all = rules.findIndex((r) => r.source === '/:path*');
    const media = rules.findIndex((r) => r.source === '/api/public/media/:path*');
    expect(all).toBeLessThan(media);
  });

  it('says the same thing in the route it is served from', () => {
    const route = fs.readFileSync('src/app/api/public/media/[...parts]/route.ts', 'utf8');
    expect(route).toContain("default-src 'none'; sandbox");
  });
});

describe('the dashboard registers no pixel', () => {
  it.each(['src/app/(system)/layout.tsx', 'src/components/public/PublicLayout.tsx'])(
    '%s starts the engine empty — pixels come from the selling page being rendered',
    (file) => {
      const layout = fs.readFileSync(file, 'utf8');
      expect(layout).toContain('<GlobalTrackingProvider pixels={[]}>');
      expect(layout).not.toMatch(/getSiteTrackingPixels|getTrackingPixelsForPage/);
    }
  );

  it('the root layout starts no engine at all', () => {
    expect(fs.readFileSync('src/app/layout.tsx', 'utf8')).not.toMatch(/GlobalTrackingProvider|TrackingPixels/);
  });
});
