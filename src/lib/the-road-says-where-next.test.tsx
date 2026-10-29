// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ROAD IS NUMBERED IN THE MENU; THESE ARE THE NUMBERS' JOB.
 *
 * The owner, 21/10: «الخطوة يتودي للثانية». A parcel's five stops and the
 * courier's money's four are numbered in the sidebar (the registry's
 * `step`), and until now that was all they did: a person on stop 2 was
 * told nothing about stop 3 and had to go back to the menu to find it.
 *
 * Every screen that is a stop now says where it stands — «3. دفعات الشحن»,
 * one pill among five — and offers the next one, derived from the registry,
 * so a stop added or moved changes nine screens without anyone touching one
 * of them.
 *
 * ── 21/10, LATER: THE ROAD MOVED INTO THE PILLS ──
 *
 * It used to be a line of its own above the screen: «الشحن · الخطوة 2 من 5»
 * and a link. The menu then folded each group into ONE line (`NavGroup.hub`)
 * and the group's screens became a strip of pills above whichever is open —
 * and a strip that already shows all five stops, numbered, with the one you
 * are on lit, made the extra line say the same thing twice. So the pills
 * carry the numbers and the «التالي», and the one-line strip is gone.
 * ═══════════════════════════════════════════════════════════════════════
 */

const here = { path: '/ops/preparation' };

vi.mock('next/navigation', () => ({ usePathname: () => here.path }));

import { HubTabs } from '@/components/shell/HubTabs';
import { roadPosition } from './next-stop';
import { ALL_ROUTES, NAV, findRoute } from './route-registry';
import { dashboardFiles, repoFile, stripComments } from './guard-source';

const everything = () => true;
const nothing = () => false;
const only = (...paths: string[]) => (r: { path: string }) => paths.includes(r.path);

/**
 * The menu a person holding exactly these permissions would be handed: every
 * group, stripped of the screens they may not open, empty groups dropped —
 * which is what `visibleNav` does, written out here so the test does not
 * import the server's permission machinery.
 */
const menuFor = (...permissions: string[]) =>
  NAV.map((g) => ({
    ...g,
    routes: g.routes.filter((r) => r.permissions === null || r.permissions.some((p) => permissions.includes(p))),
  })).filter((g) => g.routes.length > 0);

const SHIPPING = ['ops.prepare', 'ops.ship', 'ops.track', 'ops.returns'];

beforeEach(() => {
  here.path = '/ops/preparation';
});
afterEach(() => cleanup());

describe('where you are on a road', () => {
  it('— the first stop of five, and the second is the next', () => {
    const at = roadPosition('/ops/preparation', everything)!;
    expect(at.road).toBe('الشحن');
    expect(at.here.step).toBe(1);
    expect(at.of).toBe(5);
    expect(at.next?.path).toBe('/ops/shipments/new');
  });

  it('and the courier’s money is a road of four, ending at the close', () => {
    const first = roadPosition('/finance/agents', everything)!;
    expect(first.road).toBe('المال');
    expect(first.of).toBe(4);
    expect(first.next?.path).toBe('/finance/collection');
    const last = roadPosition('/finance/closing', everything)!;
    expect(last.here.step).toBe(4);
    expect(last.next, 'آخر محطّة بلا «التالي»').toBeNull();
  });

  it('and the last stop of the shipping road has nothing after it', () => {
    expect(roadPosition('/ops/returns', everything)!.next).toBeNull();
  });

  it('and a screen that is not a stop is on no road at all', () => {
    for (const path of ['/orders', '/dashboard', '/finance/wallets', '/finance/profit', '/settings/geo']) {
      expect(roadPosition(path, everything), path).toBeNull();
    }
  });

  it('and an address underneath a stop is still that stop', () => {
    // The same longest-match rule the menu lights an item by.
    expect(roadPosition('/ops/tracking/anything', everything)!.here.path).toBe('/ops/tracking');
  });

  it('and it walks the whole road, one stop at a time, in order', () => {
    const walked: string[] = [];
    let at = roadPosition('/ops/preparation', everything);
    while (at) {
      walked.push(at.here.path);
      at = at.next ? roadPosition(at.next.path, everything) : null;
    }
    expect(walked).toEqual([
      '/ops/preparation', '/ops/shipments/new', '/ops/batches', '/ops/tracking', '/ops/returns',
    ]);
  });
});

describe('the next stop is the IMMEDIATE one, or nothing', () => {
  it('— a person who may open stop 1 and stop 5 is not told stop 5 comes next', () => {
    /*
     * THE CLAIM THAT RULES OUT «THE NEXT STOP YOU MAY OPEN».
     *
     * A warehouse keeper holds the first stop and the last. If «next» were
     * the next stop they can open, packing would end with «التالي:
     * المرتجعات» — a parcel from the shelf straight to returns. Stops 2 to 4
     * are somebody else's job, and saying nothing is the true answer.
     */
    const at = roadPosition('/ops/preparation', only('/ops/preparation', '/ops/returns'))!;
    expect(at.next).toBeNull();
    // …and it still says which stop this is.
    expect(at.here.step).toBe(1);
    expect(at.of).toBe(5);
  });

  it('and nobody is offered a stop they may not open', () => {
    expect(roadPosition('/ops/preparation', nothing)!.next).toBeNull();
  });
});

describe('what the screen draws', () => {
  it('— the shipping road as five numbered pills, the one you are on lit, and a link to the next', () => {
    render(<HubTabs groups={menuFor(...SHIPPING)} />);
    const nav = screen.getByRole('navigation', { name: 'أقسام الشحن' });
    for (const label of ['1. التجهيز', '2. إنشاء شحنة', '3. دفعات الشحن', '4. متابعة الشحن', '5. المرتجعات']) {
      expect(nav.textContent, label).toContain(label);
    }
    const lit = nav.querySelector('[aria-current="page"]');
    expect(lit?.textContent).toBe('1. التجهيز');
    const next = screen.getByRole('link', { name: /التالي: إنشاء شحنة/ });
    expect(next.getAttribute('href')).toBe('/ops/shipments/new');
  });

  it('and on the last stop it says where you are and offers nothing after it', () => {
    here.path = '/ops/returns';
    render(<HubTabs groups={menuFor(...SHIPPING)} />);
    const nav = screen.getByRole('navigation', { name: 'أقسام الشحن' });
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('5. المرتجعات');
    expect(screen.queryByRole('link', { name: /التالي/ })).toBeNull();
  });

  it('and a person who may open stop 1 and stop 5 is shown two pills and no «next» — the next stop is the immediate one', () => {
    render(<HubTabs groups={menuFor('ops.prepare', 'ops.returns')} />);
    const nav = screen.getByRole('navigation', { name: 'أقسام الشحن' });
    expect(nav.textContent).toContain('1. التجهيز');
    expect(nav.textContent).toContain('5. المرتجعات');
    expect(nav.textContent).not.toContain('إنشاء شحنة');
    expect(screen.queryByRole('link', { name: /التالي/ }), 'رابط لشاشة ما يفتحها').toBeNull();
  });

  it('and one screen left to this person is not a strip at all — there is nobody to navigate to', () => {
    const { container } = render(<HubTabs groups={menuFor('ops.prepare')} />);
    expect(container.innerHTML).toBe('');
  });

  it('and the courier’s money is the same shape: four numbered pills, then the ones that are not steps', () => {
    here.path = '/finance/matching';
    render(
      <HubTabs
        groups={menuFor('settlement.view', 'settlement.review', 'settlement.upload', 'finance.cashbox_view', 'finance.cashbox', 'finance.view')}
      />
    );
    const nav = screen.getByRole('navigation', { name: 'أقسام المال' });
    expect(nav.textContent).toContain('3. المطابقة');
    // Wallets, transfers and profit are where the money ends up — not stops, so no number.
    expect(nav.textContent).toContain('المحافظ والحركات');
    expect(nav.textContent).not.toMatch(/\d\. المحافظ/);
    expect(screen.getByRole('link', { name: /التالي: الإغلاق اليومي/ })).toBeTruthy();
  });

  it('and a screen that is not in a hub gets no strip', () => {
    here.path = '/orders';
    const { container } = render(<HubTabs groups={menuFor('orders.view', ...SHIPPING)} />);
    expect(container.innerHTML).toBe('');
  });

  it('and «next» points the way the rest of the product points', () => {
    /*
     * Every directional glyph here is drawn in its LTR sense and turned by
     * `icon-mirror`. The arrow that LOOKS left on this screen is therefore
     * the RIGHT one, flipped — and the left one, flipped, points backwards.
     * `icons.test.ts` insists on the class; this insists on which arrow,
     * which that test cannot know. «Back» to a hub's front door is the
     * opposite arrow, for the same reason.
     */
    const src = stripComments(repoFile('src/components/shell/HubTabs.tsx'));
    expect(src).toMatch(/RiArrowRightLine[^>]*icon-mirror/);
    expect(src).toMatch(/RiArrowLeftLine[^>]*icon-mirror/);
  });
});

describe('and it is wired once, in the shell, not nine times', () => {
  it('— the shell draws it above every screen', () => {
    const shell = stripComments(repoFile('src/components/shell/Shell.tsx'));
    const at = shell.indexOf('<HubTabs');
    expect(at, 'الشريط غير موصول بالإطار').toBeGreaterThan(-1);
    // Above the screen, inside <main>.
    expect(at).toBeGreaterThan(shell.indexOf('<main'));
    expect(at).toBeLessThan(shell.indexOf('{children}'));
  });

  it('and no screen draws its own copy — one place in the whole codebase renders it', () => {
    /*
     * Swept over EVERY dashboard file rather than a hand-picked four: the
     * rule is «derived from the registry, not placed per screen», and a
     * list of screens somebody remembered to check is the thing that rule
     * exists to avoid. Nine stops, one component, one caller.
     */
    const drawn = dashboardFiles('.tsx')
      .filter((f) => /<HubTabs\b/.test(stripComments(f.src)))
      .map((f) => f.rel);
    expect(drawn).toEqual(['/src/components/shell/Shell.tsx']);
  });

  it('and the one-line road strip it replaced is gone, not left to say the same thing twice', () => {
    expect(() => repoFile('src/components/shell/RoadStrip.tsx')).toThrow();
  });

  it('and there ARE nine stops for that one place to cover', () => {
    // Pinned so the claim above is not satisfied by a road that vanished.
    expect(ALL_ROUTES.filter((r) => r.step !== undefined)).toHaveLength(9);
  });

  it('and every group that has numbered stops is a hub of tabs — or its road would be drawn nowhere', () => {
    for (const g of NAV) {
      const stops = g.routes.filter((r) => r.step !== undefined);
      if (stops.length > 0) expect(g.hub, `${g.key} فيه محطّات بلا شريط`).toBe('tabs');
    }
  });

  it('and the strip’s steps are the registry’s, so it can never disagree with the menu', () => {
    // Every numbered route has a road position; every other has none.
    for (const route of ALL_ROUTES) {
      const at = roadPosition(route.path, everything);
      if (route.step === undefined) expect(at, route.path).toBeNull();
      else expect(at?.here.step, route.path).toBe(route.step);
    }
    expect(NAV.find((g) => g.key === 'ops')!.routes.every((r) => findRoute(r.path)?.step)).toBe(true);
  });
});
