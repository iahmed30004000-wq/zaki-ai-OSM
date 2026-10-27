import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dashboardFiles, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THREE LINKS ENDED IN A 404, AND THE ORDER WAS NEVER MISSING.
 *
 * The confirmation queue (when it refuses a pull and names the order in the
 * way), the matching screen (from every line of a statement) and the
 * WhatsApp inbox (beside a conversation) all linked to `/orders/<id>`. No
 * page answered there. Each is the moment somebody is looking at a problem
 * and reaching for the order behind it — and what they met was «page not
 * found», about a thing that exists.
 *
 * An order opens as a PANEL on the orders list, and the list already opens
 * one by id (`?highlight=<id>`, which the discount alerts have always
 * linked to). So `/orders/<id>` is a door to that panel. See the page for
 * why it is a redirect and not a second place that renders an order.
 *
 * The same sweep covers `/no-access`, which `landingRoute` named for years
 * with nothing living there: the one case it was written for — a person
 * whose menu is empty — could not have been shown a page.
 * ═══════════════════════════════════════════════════════════════════════
 */

const guardRoute = vi.fn();
const requireActiveUser = vi.fn();

/** Next's `redirect` and `notFound` THROW, and nothing after them runs. */
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
const notFound = vi.fn(() => {
  throw new Error('NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirect(to),
  notFound: () => notFound(),
}));
vi.mock('@/lib/page-guard', () => ({
  guardRoute: (p: string) => guardRoute(p),
  requireActiveUser: () => requireActiveUser(),
}));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/components/shell/AccountScreens', () => ({ NoAccessScreen: () => null }));

import OrderAddress from '../app/(system)/(shell)/orders/[id]/page';
import NoAccessPage from '../app/(system)/no-access/page';
import { NoAccessScreen } from '@/components/shell/AccountScreens';
import { landingRoute, NO_ACCESS } from './route-registry';
import { can, attachGrants } from './authorization';

const ID = '3f2b8c1e-7a4d-4e65-9b0a-1c2d3e4f5a6b';
const ask = (id: string) => OrderAddress({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  guardRoute.mockResolvedValue({});
});

describe('/orders/<id> opens that order', () => {
  it('— by sending the id to the panel the list already opens', async () => {
    await expect(ask(ID)).rejects.toThrow(`REDIRECT:/orders?highlight=${ID}`);
  });

  it('and checks the door first, with the LIST’s own route', async () => {
    /*
     * The order matters as much as the call. A redirect decided before the
     * guard would tell somebody who may not open orders whether an id was
     * well-formed — and one decided AFTER leaves the guard's refusal
     * (a 403) to say the only thing they are entitled to know.
     */
    await expect(ask(ID)).rejects.toThrow();
    expect(guardRoute).toHaveBeenCalledWith('/orders');
    const guardAt = guardRoute.mock.invocationCallOrder[0];
    const redirectAt = redirect.mock.invocationCallOrder[0];
    expect(guardAt, 'التوجيه قبل البوّابة').toBeLessThan(redirectAt);
  });

  it('and a person the guard refuses is never redirected anywhere', async () => {
    guardRoute.mockRejectedValue(new Error('FORBIDDEN'));
    await expect(ask(ID)).rejects.toThrow('FORBIDDEN');
    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });

  it('and gets the REFUSAL even for a malformed id — the guard speaks before the id is judged', async () => {
    /*
     * The claim the page's own comment makes: «never learns whether the id
     * was real». A page that checked the id's shape first would answer a
     * person with no access to orders «404» for rubbish and «403» for a
     * well-formed id — and the difference is information they have no
     * business with. The order of the two lines is the whole behaviour.
     */
    guardRoute.mockRejectedValue(new Error('FORBIDDEN'));
    await expect(ask('rubbish')).rejects.toThrow('FORBIDDEN');
    expect(notFound).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'empty'],
    ['abc', 'a word'],
    ['12345', 'a number'],
    ['../../etc/passwd', 'a path'],
    [`${ID}x`, 'a uuid with a tail'],
    [`${ID}&state=DELIVERED`, 'a uuid that smuggles a second filter'],
    [`${ID}#fragment`, 'a uuid with a fragment'],
    ['javascript:alert(1)', 'a script'],
  ])('and %j (%s) is a 404, not a redirect built from it', async (bad) => {
    /*
     * The id goes into a URL without being encoded, which is only safe
     * BECAUSE nothing but a uuid gets that far. The smuggled-filter case is
     * the one that would have changed what the list shows.
     */
    await expect(ask(bad)).rejects.toThrow('NOT_FOUND');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('and an uppercase uuid is still an order', async () => {
    await expect(ask(ID.toUpperCase())).rejects.toThrow('REDIRECT:');
  });
});

describe('every link of this shape lands on a page that exists', () => {
  /**
   * THE CLAIM THAT WOULD HAVE CAUGHT IT: look at the LINKS, not the page.
   *
   * `a-link-is-a-promise.test.ts` reads registry paths, and a template
   * literal is not one — `/orders/${id}` is a string built at runtime that
   * no static check resolves. So this one reads the source for hrefs of
   * that shape and asks the filesystem whether a page answers.
   */
  const sources = () => dashboardFiles('.tsx').map((f) => ({ ...f, src: stripComments(f.src) }));

  it('— `/orders/${…}` has a page behind it', () => {
    const page = join(process.cwd(), 'src', 'app', '(system)', '(shell)', 'orders', '[id]', 'page.tsx');
    expect(existsSync(page), 'ما في صفحة لـ/orders/[id]').toBe(true);
  });

  it('and the sweep really sees the three known links, so it cannot pass by looking at nothing', () => {
    const hits = sources().filter((f) => /href=\{`\/orders\/\$\{/.test(f.src));
    const names = hits.map((f) => f.rel.split('/').pop());
    // `PullPanel.tsx` was one of the three: its «افتح الطلب … وسجّل محاولة»
    // opens the order on her own desk now (`/confirmation/mine?open=`), because
    // `/orders/<id>` asks «عرض الطلبات» and the agent may work without it.
    // `OrderLink.tsx` — the one link every order number on a screen uses — stands in its place.
    expect(names).toEqual(
      expect.arrayContaining(['OrderLink.tsx', 'MatchingScreen.tsx', 'WhatsAppInboxScreen.tsx'])
    );
  });

  it('and nothing else links under /orders/ to a page that is not there', () => {
    // Any `/orders/<something>` that is NOT `${id}` would need its own page:
    // `/orders/new`, `/orders/export`… Today there are none. The day one
    // appears this fails, and the person adding it learns the rule.
    const stray = sources()
      .flatMap((f) => [...f.src.matchAll(/["'`]\/orders\/([a-z][\w-]*)/g)].map((m) => `${f.rel}: /orders/${m[1]}`))
      // /orders/[id] is the only dynamic page; `${` never matches `[a-z]`.
      .filter((x) => !x.includes('/api/'));
    expect(stray, 'روابط /orders/… بلا صفحة').toEqual([]);
  });
});

describe('/no-access is a page, and it cannot loop', () => {
  const nobody = () => ({ id: 'u1', role: 'MODERATOR', status: 'PENDING', permissions: [] }) as any;
  const withOrders = () =>
    attachGrants(
      { id: 'u2', role: 'MODERATOR', status: 'ACTIVE', permissions: ['orders.view'] } as any,
      { fullAccess: false, grants: { 'orders.view': { scope: 'ALL_COMPANY' } } }
    );

  it('— the address `landingRoute` hands out has a page behind it', () => {
    expect(landingRoute(nobody(), can)).toBe(NO_ACCESS);
    const page = join(process.cwd(), 'src', 'app', '(system)', NO_ACCESS.slice(1), 'page.tsx');
    expect(existsSync(page), `ما في صفحة لـ${NO_ACCESS}`).toBe(true);
  });

  it('and somebody with nothing to open is shown it', async () => {
    requireActiveUser.mockResolvedValue({ user: nobody() });
    const shown = (await NoAccessPage()) as { type: unknown };
    expect(shown.type).toBe(NoAccessScreen);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('and somebody who HAS something to open is sent on to it, not shown it', async () => {
    // «تحديث» after the manager grants a role must take them in.
    requireActiveUser.mockResolvedValue({ user: withOrders() });
    await expect(NoAccessPage()).rejects.toThrow('REDIRECT:/orders');
  });

  it('and the page can never send somebody back to itself', async () => {
    // The loop is closed on this side: it redirects only when the landing
    // route is NOT itself, so the destination is never this address.
    requireActiveUser.mockResolvedValue({ user: withOrders() });
    await expect(NoAccessPage()).rejects.not.toThrow(`REDIRECT:${NO_ACCESS}`);
  });
});
