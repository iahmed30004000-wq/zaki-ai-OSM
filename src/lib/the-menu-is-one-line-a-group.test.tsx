// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * FIFTY-FOUR LINES BECAME FIFTEEN, AND NOT ONE SCREEN MOVED.
 *
 * The owner, 21/10, twice: «الموقع كثييييييييييييييير معجوق» and «دمج القوائم
 * بذكاء». The sidebar spent a line on every screen — fifty-four, under ten
 * headings that folded — and he had said the same of the store a week before,
 * which then went from ten entries to two.
 *
 * Here a group is ONE line, and its screens are the pills above whichever of
 * them is open (`HubTabs`). The settings, twelve of them, are one line that
 * opens a page of eight cards. What this file holds is the shape, and every
 * way it could quietly come undone:
 *
 *   • fifteen lines, and the arithmetic that says so;
 *   • one line lit for every address, never two and never none;
 *   • a pill only for a screen the person may open, in the order they put it;
 *   • the settings door: every settings screen on exactly one card, and a
 *     card nobody may open is not drawn;
 *   • and the sentence an ad platform's return is answered with — the page
 *     it redirects to did not exist before this.
 *
 * NOTHING HERE MOVES A ROUTE. The registry still holds every address, with
 * its own permissions, title, guide and notification link — the page guard,
 * the palette and the phone bar read the same screens they always did. That
 * is the whole reason this is a change of how the menu is DRAWN and not of
 * what the product CONTAINS.
 * ═══════════════════════════════════════════════════════════════════════
 */

const here = { path: '/orders', search: new URLSearchParams() };
const may = { allow: (_path: string) => true };
const unread: { byRoute: Record<string, number> } = { byRoute: {} };

vi.mock('next/navigation', () => ({
  usePathname: () => here.path,
  useSearchParams: () => here.search,
}));
vi.mock('@/hooks/useMayOpen', () => ({
  useMayOpen: () => (target: string | { path: string }) => may.allow(typeof target === 'string' ? target : target.path),
}));
vi.mock('@/components/shell/NotificationsProvider', () => ({
  useNotifications: () => ({ byRoute: unread.byRoute, items: [], unreadCount: 0, arriving: [] }),
}));
vi.mock('@/components/shell/BulkBar', () => ({ useBulkActive: () => false }));
vi.mock('@/lib/sign-out', () => ({ signOut: () => undefined }));

import { Sidebar } from '@/components/shell/Sidebar';
import { MobileNav } from '@/components/shell/MobileNav';
import { HubTabs } from '@/components/shell/HubTabs';
import { SettingsHomeScreen } from '@/components/screens/SettingsHomeScreen';
import { iconFor } from '@/components/shell/icons';
import { ALL_ROUTES, NAV, findRoute, type NavGroup } from './route-registry';
import { applyArrangement } from './nav-arrangement';
import { setRailed } from './sidebar-rail';
import { hubAt, hubHref, hubLabel, isHub } from './hub';
import { SETTINGS_CARDS } from './settings-home';
import { connectNotice } from './ad-connect-outcome';
import { repoFile, stripComments } from './guard-source';

beforeEach(() => {
  here.path = '/orders';
  here.search = new URLSearchParams();
  may.allow = () => true;
  unread.byRoute = {};
  localStorage.clear();
});
afterEach(() => cleanup());

/** What a person holding exactly these permissions is handed — `visibleNav` written out, minus the server. */
const menuFor = (...permissions: string[]): NavGroup[] =>
  NAV.map((g) => ({
    ...g,
    routes: g.routes.filter((r) => r.permissions === null || r.permissions.some((p) => permissions.includes(p))),
  })).filter((g) => g.routes.length > 0);

const everyPermission = [...new Set(ALL_ROUTES.flatMap((r) => r.permissions ?? []))];
const lines = (groups: readonly NavGroup[]) => groups.reduce((n, g) => n + (g.hub === 'loose' ? g.routes.length : 1), 0);

/** The links inside the menu proper — not the logo, not «رتّب القائمة». */
const menuLinks = (container: HTMLElement) =>
  [...container.querySelectorAll('aside nav a')] as HTMLAnchorElement[];

const LIT = 'bg-[var(--sys-primary)]';

// ───────────────────────── the arithmetic ─────────────────────────

describe('the menu is fifteen lines', () => {
  it('— fifty-two screens in the registry, fifteen lines in the menu', () => {
    expect(ALL_ROUTES).toHaveLength(52);
    expect(lines(NAV), 'عدد أسطر القائمة').toBe(15);
  });

  it('and every group says how it is drawn — none is left to fold as a heading', () => {
    for (const g of NAV) expect(isHub(g) || g.hub === 'loose', `${g.key}: بلا hub`).toBe(true);
    expect(NAV.filter((g) => g.hub === 'loose').map((g) => g.key)).toEqual(['main', 'storefront']);
    expect(NAV.filter((g) => g.hub === 'cards').map((g) => g.key)).toEqual(['settings']);
    expect(NAV.filter((g) => g.hub === 'tabs').map((g) => g.key)).toEqual([
      'confirmation', 'ops', 'inventory', 'finance', 'control', 'growth', 'chats', 'admin',
    ]);
  });

  it('and a hub has a glyph of its own, one the icon table really knows', () => {
    const nothing = iconFor('__no-such-icon__');
    for (const g of NAV.filter(isHub)) {
      expect(g.icon, `${g.key}: بلا أيقونة`).toBeTruthy();
      expect(iconFor(g.icon!), `${g.key}: أيقونة غير معروفة`).not.toBe(nothing);
    }
  });

  it('and the store’s two entries stay two lines, untouched — that group is the other agent’s', () => {
    expect(NAV.find((g) => g.key === 'storefront')!.routes.map((r) => r.path)).toEqual(['/store', '/store/landing-pages']);
  });
});

// ───────────────────────── what the sidebar draws ─────────────────────────

describe('the sidebar', () => {
  it('draws one line per hub and one per loose screen — fifteen, with no heading to fold', () => {
    const { container } = render(<Sidebar groups={NAV} />);
    const links = menuLinks(container);
    expect(links).toHaveLength(15);
    // No heading that folds: the buttons of an accordion carry `aria-expanded`.
    expect(container.querySelectorAll('aside nav [aria-expanded]')).toHaveLength(0);
    const text = links.map((a) => a.textContent);
    for (const hub of ['مركز التأكيد', 'الشحن', 'المخزون', 'المال', 'الرقابة', 'النمو والذكاء', 'المحادثات', 'الإعدادات', 'الإدارة']) {
      expect(text, hub).toContain(hub);
    }
    // And what folded into them is not a line of its own any more.
    for (const folded of ['الطلبات الجديدة', 'التجهيز', 'أرصدة المخزون', 'المطابقة', 'لوحة الأداء', 'صندوق الواتساب']) {
      expect(text, folded).not.toContain(folded);
    }
  });

  it('and every address lights exactly one line — never two, never none', () => {
    for (const route of ALL_ROUTES) {
      here.path = route.path;
      const { container, unmount } = render(<Sidebar groups={NAV} />);
      const lit = menuLinks(container).filter((a) => a.className.includes(LIT));
      expect(lit.length, `${route.path}: ${lit.length} أسطر مضاءة`).toBe(1);
      unmount();
    }
  });

  it('and it is the right one: a screen inside a hub lights the hub, a loose screen lights itself', () => {
    const litFor = (path: string) => {
      here.path = path;
      const { container, unmount } = render(<Sidebar groups={NAV} />);
      const lit = menuLinks(container).find((a) => a.className.includes(LIT))!.textContent;
      unmount();
      return lit;
    };
    expect(litFor('/ops/tracking')).toBe('الشحن');
    expect(litFor('/finance/matching')).toBe('المال');
    expect(litFor('/settings/geo')).toBe('الإعدادات');
    expect(litFor('/settings')).toBe('الإعدادات');
    expect(litFor('/orders')).toBe('الطلبات');
    expect(litFor('/store/landing-pages')).toBe('صفحات الهبوط');
    expect(litFor('/admin/profile')).toBe('الإدارة');
  });

  it('and a hub leads to the first screen this person may open in it', () => {
    const href = (groups: NavGroup[], label: string) => {
      const { container, unmount } = render(<Sidebar groups={groups} />);
      const a = menuLinks(container).find((l) => l.textContent === label)!;
      const h = a.getAttribute('href');
      unmount();
      return h;
    };
    expect(href(NAV, 'الشحن')).toBe('/ops/preparation');
    // A tracking clerk has no «التجهيز»: the line opens the first stop they do have.
    expect(href(menuFor('ops.batches', 'ops.track', 'ops.returns'), 'الشحن')).toBe('/ops/batches');
    // …and the tracking key alone no longer reaches the batches page (PR-8): the line opens «متابعة الشحن».
    expect(href(menuFor('ops.track', 'ops.returns'), 'الشحن')).toBe('/ops/tracking');
    expect(href(NAV, 'الإعدادات')).toBe('/settings');
  });

  it('and a hub line carries every unread number of the screens inside it, added up', () => {
    unread.byRoute = { '/confirmation/mine': 2, '/confirmation/issues': 3, '/orders': 4 };
    const { container } = render(<Sidebar groups={NAV} />);
    const line = menuLinks(container).find((a) => a.textContent?.startsWith('مركز التأكيد'))!;
    expect(within(line).getByLabelText('5 إشعار غير مقروء')).toBeTruthy();
    const orders = menuLinks(container).find((a) => a.textContent?.startsWith('الطلبات'))!;
    expect(within(orders).getByLabelText('4 إشعار غير مقروء')).toBeTruthy();
  });

  it('and folded to a rail of icons, a hub line still has its name for a screen reader and its number for the eye', () => {
    setRailed(true);
    try {
      unread.byRoute = { '/confirmation/mine': 2, '/confirmation/issues': 1 };
      const { container } = render(<Sidebar groups={NAV} />);
      const line = menuLinks(container).find((a) => a.getAttribute('aria-label') === 'مركز التأكيد');
      expect(line, 'السطر المطوي بلا اسم').toBeTruthy();
      expect(line!.getAttribute('title')).toBe('مركز التأكيد');
      // The number is the only thing a folded menu can say, and it is the sum.
      expect(within(line!).getByLabelText('3 إشعار غير مقروء')).toBeTruthy();
    } finally {
      setRailed(false);
    }
  });

  it('and a group of one screen takes that screen’s own name — a warehouse hand’s «الإدارة» is only their profile', () => {
    const only = menuFor('ops.prepare');
    const { container } = render(<Sidebar groups={only} />);
    const text = menuLinks(container).map((a) => a.textContent);
    expect(text).toContain('الملف الشخصي');
    expect(text).not.toContain('الإدارة');
    // Labels are decided in one place.
    const admin = only.find((g) => g.key === 'admin')!;
    expect(hubLabel(admin)).toBe('الملف الشخصي');
  });

  it('and «show everything» is offered only when something folds — with every group a line it would do nothing', () => {
    const { container } = render(<Sidebar groups={NAV} />);
    expect(within(container).queryByText('اعرض كل القوائم')).toBeNull();
    cleanup();

    const folding: NavGroup[] = [
      { key: 'a', label: 'مجموعة', routes: [{ path: '/orders', label: 'الطلبات', icon: 'ShoppingCart', permissions: null }] },
    ];
    const again = render(<Sidebar groups={folding} />);
    expect(within(again.container).getByText('اعرض كل القوائم')).toBeTruthy();
  });
});

// ───────────────────────── the phone's «المزيد» ─────────────────────────

describe('the phone’s «المزيد»', () => {
  const LIT_ON_A_PHONE = 'bg-[var(--sys-primary-soft)]';

  /** Opens the sheet over a phone holding this menu, and hands back the sheet. */
  const openSheet = (groups: NavGroup[]) => {
    render(<MobileNav groups={groups} />);
    fireEvent.click(screen.getByRole('button', { name: 'المزيد' }));
    return screen.getByRole('dialog', { name: 'كل الشاشات' });
  };
  const linksOf = (sheet: HTMLElement) => within(sheet).getAllByRole('link') as HTMLAnchorElement[];

  it('— draws a hub as ONE line, not fifty screens under ten headings', () => {
    const sheet = openSheet(NAV);
    const text = linksOf(sheet).map((a) => a.textContent);
    // Fifteen lines in the menu, less «الطلبات», which the bar already holds on this page.
    expect(text).toHaveLength(14);
    for (const hub of ['مركز التأكيد', 'الشحن', 'المخزون', 'المال', 'الرقابة', 'النمو والذكاء', 'المحادثات', 'الإعدادات', 'الإدارة']) {
      expect(text, hub).toContain(hub);
    }
    for (const folded of ['التجهيز', 'أرصدة المخزون', 'المطابقة', 'لوحة الأداء', 'صندوق الواتساب', 'البلدان والمتاجر والمحافظات']) {
      expect(text, `${folded} صار شريطاً لا سطراً`).not.toContain(folded);
    }
    // No heading is left to read past: a hub names itself.
    expect(within(sheet).queryAllByRole('heading')).toHaveLength(0);
  });

  it('and a hub leads to the first screen this person may open in it — even when the bar already holds that screen', () => {
    const sheet = openSheet(NAV);
    const hrefOf = (label: string) => linksOf(sheet).find((a) => a.textContent === label)!.getAttribute('href');
    expect(hrefOf('الشحن')).toBe(hubHref(NAV.find((g) => g.key === 'ops')!));
    expect(hrefOf('مركز التأكيد')).toBe(hubHref(NAV.find((g) => g.key === 'confirmation')!));
    expect(hrefOf('الإعدادات')).toBe('/settings');
  });

  it('and the loose screens stay lines of their own, with no heading — the store’s two and the main ones', () => {
    const text = linksOf(openSheet(NAV)).map((a) => a.textContent);
    for (const loose of ['لوحة التحكم', 'العملاء', 'المنتجات', 'المتجر', 'صفحات الهبوط']) expect(text, loose).toContain(loose);
  });

  it('and one line is lit for a page inside a hub — and none for a page the bar already shows', () => {
    here.path = '/finance/matching';
    const lit = (sheet: HTMLElement) => linksOf(sheet).filter((a) => a.className.includes(LIT_ON_A_PHONE));
    const sheet = openSheet(NAV);
    expect(lit(sheet).map((a) => a.textContent)).toEqual(['المال']);
    cleanup();

    here.path = '/orders';
    expect(lit(openSheet(NAV))).toHaveLength(0);
  });

  it('and a group of one screen takes that screen’s name, as in the sidebar', () => {
    const text = linksOf(openSheet(menuFor('ops.prepare', 'orders.view', 'customers.view', 'products.view'))).map((a) => a.textContent);
    expect(text).not.toContain('الإدارة');
    expect(text).toContain('الملف الشخصي');
  });

  it('and a group wholly in the bar has no line in the sheet — it is already one tap away', () => {
    here.path = '/ops/preparation';
    const sheet = openSheet(menuFor('ops.prepare'));
    // Nothing is left for the sheet to draw, so there may be no links in it at all.
    expect(within(sheet).queryAllByRole('link').map((a) => a.getAttribute('href'))).not.toContain('/ops/preparation');
  });

  it('and a group that folds — one with no `hub` — still draws its heading and its screens', () => {
    const folding: NavGroup[] = [{ key: 'old', label: 'مجموعة قديمة', routes: ALL_ROUTES.slice(0, 6) }];
    const sheet = openSheet(folding);
    expect(within(sheet).getByRole('heading', { name: 'مجموعة قديمة' })).toBeTruthy();
    expect(linksOf(sheet).length).toBeGreaterThanOrEqual(2);
  });

  it('and the way out is still at the bottom of it — a phone must be able to sign out', () => {
    const sheet = openSheet(NAV);
    expect(within(sheet).getByRole('button', { name: 'تسجيل الخروج' })).toBeTruthy();
  });
});

// ───────────────────────── the helpers ─────────────────────────

describe('which hub a page is in', () => {
  it('— the longest match: standing on /settings/geo is not standing on the front door', () => {
    expect(hubAt(NAV, '/settings/geo')!.here.path).toBe('/settings/geo');
    expect(hubAt(NAV, '/settings')!.here.path).toBe('/settings');
    expect(hubAt(NAV, '/ops/tracking/anything')!.here.path).toBe('/ops/tracking');
  });

  it('and a page in a loose group, or in none, is in no hub', () => {
    expect(hubAt(NAV, '/orders')).toBeNull();
    expect(hubAt(NAV, '/store')).toBeNull();
    expect(hubAt(NAV, '/no/such/page')).toBeNull();
  });

  it('and the line leads where the person’s own arrangement puts the first screen', () => {
    const arranged = applyArrangement(NAV, { order: ['/confirmation/issues'], hidden: ['/confirmation/queue'], pinned: [] });
    const confirmation = arranged.find((g) => g.key === 'confirmation')!;
    expect(hubHref(confirmation)).toBe('/confirmation/issues');
    expect(confirmation.routes.map((r) => r.path)).not.toContain('/confirmation/queue');
  });
});

// ───────────────────────── the pills ─────────────────────────

describe('the pills above a screen', () => {
  it('— are the siblings the person may open, in the order they arranged them', () => {
    here.path = '/confirmation/mine';
    const arranged = applyArrangement(menuFor('confirmation.work', 'confirmation.issues', 'confirmation.supervise'), {
      order: ['/confirmation/issues'],
      hidden: ['/confirmation/follow-up'],
      pinned: [],
    });
    render(<HubTabs groups={arranged} />);
    const nav = screen.getByRole('navigation', { name: 'أقسام مركز التأكيد' });
    const pills = within(nav).getAllByRole('link').map((a) => a.textContent);
    // Hidden by the person: not there. First by the person: first.
    expect(pills[0]).toBe('الإشكالات');
    expect(pills).not.toContain('المتابعة');
    expect(pills).toContain('طلباتي');
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('طلباتي');
  });

  it('and a screen the person may not open is not a greyed pill — it is not there', () => {
    here.path = '/confirmation/mine';
    // An agent with the issues door: her desk and the issues list. The supervisor's two
    // screens («الطلبات الجديدة» — she pulls from the top of her own desk — and «المتابعة»)
    // are not theirs to see, so they are not there at all.
    render(<HubTabs groups={menuFor('confirmation.work', 'confirmation.pull', 'confirmation.issues')} />);
    const nav = screen.getByRole('navigation', { name: 'أقسام مركز التأكيد' });
    const pills = within(nav).getAllByRole('link').map((a) => a.textContent);
    expect(pills).toContain('طلباتي');
    expect(pills).not.toContain('الطلبات الجديدة');
    expect(pills).not.toContain('المتابعة');
  });

  it('and each pill carries its own unread number', () => {
    here.path = '/confirmation/mine';
    unread.byRoute = { '/confirmation/issues': 7 };
    render(<HubTabs groups={menuFor('confirmation.work', 'confirmation.issues')} />);
    const nav = screen.getByRole('navigation', { name: 'أقسام مركز التأكيد' });
    expect(within(nav).getByText('الإشكالات').textContent).toContain('7');
  });

  it('and the strip opens on the pill you are standing on — the fourth of five must not be out of sight on a phone', () => {
    const scrolled = vi.fn();
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      here.path = '/ops/tracking';
      render(<HubTabs groups={NAV} />);
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled).toHaveBeenCalledWith({ block: 'nearest', inline: 'center' });
      // …on the lit pill, not on whichever came first.
      const target = scrolled.mock.contexts[0] as HTMLElement;
      expect(target.getAttribute('aria-current')).toBe('page');
      expect(target.textContent).toContain('متابعة الشحن');
    } finally {
      Element.prototype.scrollIntoView = real;
    }
  });

  it('and «التالي» wraps under the pills when it does not fit beside them, instead of squeezing them', () => {
    here.path = '/ops/tracking';
    render(<HubTabs groups={NAV} />);
    const nav = screen.getByRole('navigation', { name: 'أقسام الشحن' });
    expect(nav.className).toContain('flex-wrap');
  });

  it('and a page of cards is not a strip — its screens carry one link back to the front door', () => {
    here.path = '/settings/geo';
    const { container } = render(<HubTabs groups={NAV} />);
    const back = within(container).getByRole('link', { name: 'الإعدادات' });
    expect(back.getAttribute('href')).toBe('/settings');
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it('and the front door itself carries no link to itself', () => {
    here.path = '/settings';
    const { container } = render(<HubTabs groups={NAV} />);
    expect(container.innerHTML).toBe('');
  });
});

// ───────────────────────── the settings door ─────────────────────────

describe('the settings front door', () => {
  const settingsScreens = () =>
    NAV.find((g) => g.key === 'settings')!.routes.map((r) => r.path).filter((p) => p !== '/settings');

  it('— every settings screen is on exactly one card, so none is lost now the menu does not list it', () => {
    const onCards = SETTINGS_CARDS.flatMap((c) => c.paths);
    expect(new Set(onCards).size, 'شاشة على بطاقتين').toBe(onCards.length);
    expect([...onCards].sort()).toEqual([...settingsScreens()].sort());
  });

  it('and every card names real screens, in the registry, in the settings group', () => {
    for (const card of SETTINGS_CARDS) {
      expect(card.paths.length, card.key).toBeGreaterThan(0);
      expect(card.why.length, `${card.key}: بلا جملة`).toBeGreaterThan(10);
      for (const path of card.paths) expect(findRoute(path), path).toBeTruthy();
    }
    expect(SETTINGS_CARDS).toHaveLength(8);
  });

  it('and the door opens for whoever may open any one of the screens behind it, and nobody else', () => {
    const behind = settingsScreens().flatMap((p) => findRoute(p)!.permissions ?? []);
    expect([...new Set(findRoute('/settings')!.permissions)].sort()).toEqual([...new Set(behind)].sort());
  });

  it('and the page draws a card, with a link for each screen the person may open', () => {
    render(<SettingsHomeScreen />);
    expect(screen.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(8);
    const link = screen.getByRole('link', { name: 'البلدان والمتاجر' });
    expect(link.getAttribute('href')).toBe('/settings/geo');
    // A card's links are the screens' own names, as the menu used to say them.
    expect(screen.getByRole('link', { name: 'بكسل الإعلانات' }).getAttribute('href')).toBe('/settings/tracking');
    expect(screen.getByRole('link', { name: 'المهام المجدولة' }).getAttribute('href')).toBe('/admin/jobs');
  });

  it('and a card with nothing the person may open is not drawn at all', () => {
    may.allow = (path) => path === '/settings/geo' || path === '/settings/commission';
    render(<SettingsHomeScreen />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['البلدان والمتاجر', 'العمولات']);
    expect(screen.queryByRole('link', { name: 'شركات الشحن وأجورها' })).toBeNull();
  });

  it('and a card holding two screens shows only the one that may be opened', () => {
    may.allow = (path) => path === '/settings/channels';
    render(<SettingsHomeScreen />);
    expect(screen.getByRole('link', { name: 'قنوات الطلبات' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'بكسل الإعلانات' })).toBeNull();
  });
});

// ───────────────────────── where an ad platform sends somebody back ─────────────────────────

describe('the return from an ad platform', () => {
  it('— success says so, with the platform and how many accounts, and links to where they are', () => {
    here.search = new URLSearchParams('connect=connected&platform=META&count=2');
    render(<SettingsHomeScreen />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('تمّ الربط مع ميتا — 2 حساب إعلاني.');
    expect(within(status).getByRole('link', { name: 'بكسل الإعلانات' }).getAttribute('href')).toBe('/settings/tracking');
  });

  it('and the sentence offers its link only to somebody who may open where it leads', () => {
    here.search = new URLSearchParams('connect=connected&platform=META&count=2');
    may.allow = (path) => path !== '/settings/tracking';
    render(<SettingsHomeScreen />);
    const status = screen.getByRole('status');
    // They still hear how it went; they are just not handed a door they cannot open.
    expect(status.textContent).toContain('تمّ الربط مع ميتا');
    expect(within(status).queryByRole('link')).toBeNull();
  });

  it('and a refusal says so in plain words, never in a code', () => {
    here.search = new URLSearchParams('connect=declined&platform=TIKTOK');
    render(<SettingsHomeScreen />);
    expect(screen.getByRole('status').textContent).toContain('رفضتَ الربط عند تيك توك، فلم يُربط شيء.');
  });

  it('and no return, no sentence', () => {
    render(<SettingsHomeScreen />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('and every outcome the callback can send has a sentence of its own', () => {
    const callback = stripComments(repoFile('src/app/api/settings/ad-accounts/oauth/[platform]/callback/route.ts'));
    const sent = [...callback.matchAll(/back\('([a-z-]+)'/g)].map((m) => m[1]);
    expect(sent.length).toBeGreaterThan(6);
    const generic = connectNotice('something-new')!.text;
    for (const outcome of new Set(sent)) {
      const notice = connectNotice(outcome, 'META', '1');
      expect(notice, outcome).toBeTruthy();
      expect(notice!.text, `${outcome}: يقع على الجملة العامّة`).not.toBe(generic);
    }
  });

  it('and success is the only good news — and a count that is not a number is not printed', () => {
    expect(connectNotice('connected', 'SNAPCHAT', '3')).toEqual({ tone: 'good', text: 'تمّ الربط مع سناب شات — 3 حساب إعلاني.' });
    expect(connectNotice('connected', 'META', 'abc<script>')!.text).toBe('تمّ الربط مع ميتا.');
    // Digits only, and no more than three: a count is a number of accounts, not whatever the address carries —
    // `Number()` would turn each of these into a figure the sentence would then print.
    for (const odd of ['99999', '1e3', '-5', '0x10', '2 ', '']) {
      expect(connectNotice('connected', 'META', odd)!.text, `«${odd}»`).toBe('تمّ الربط مع ميتا.');
    }
    for (const bad of ['declined', 'platform-refused', 'bad-state', 'no-code', 'exchange-failed', 'list-failed', 'no-accounts', 'unsupported']) {
      expect(connectNotice(bad)!.tone, bad).toBe('bad');
    }
    expect(connectNotice(null)).toBeNull();
  });

  it('and the page the callback has always redirected to is a page now', () => {
    const callback = repoFile('src/app/api/settings/ad-accounts/oauth/[platform]/callback/route.ts');
    expect(callback).toContain('/settings?');
    expect(findRoute('/settings')).toBeTruthy();
    expect(() => repoFile('src/app/(system)/(shell)/settings/page.tsx')).not.toThrow();
  });
});

// ───────────────────────── the sidebar source ─────────────────────────

describe('how it is wired', () => {
  it('— the sidebar asks the hub helper, not its own copy, what a line is called and where it leads', () => {
    const bar = stripComments(repoFile('src/components/shell/Sidebar.tsx'));
    expect(bar).toContain('hubHref(group)');
    expect(bar).toContain('hubLabel(group)');
  });

  it('and the pills and the sidebar read the SAME menu — the one the shell hands down — not the registry', () => {
    const tabs = stripComments(repoFile('src/components/shell/HubTabs.tsx'));
    expect(tabs, 'الشريط يقرأ السجلّ لا القائمة الممنوحة').not.toMatch(/from '@\/lib\/route-registry'[^;]*\bNAV\b/);
    expect(tabs).toContain('hubAt(groups, pathname)');
  });
});
