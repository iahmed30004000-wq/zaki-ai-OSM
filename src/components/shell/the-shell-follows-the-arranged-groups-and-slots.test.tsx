// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SHELL FOLLOWS THE ARRANGEMENT — THE GROUPS OF THE DRAWER AND THE PHONE'S FOUR (13/11).
 *
 *   «زر رتّب القائمة لترتيب القوائم والخانات الرئيسية» (the owner)
 *
 * The card writes the arrangement; this is the other half — what a person is then SHOWN. The
 * real shell layout (the server component) reads the arrangement and hands the shell the groups,
 * arranged, and the phone's four, as paths; the real shell draws the real sidebar and the real
 * bottom bar from them. Only the neighbours that fetch, poll or register things are stubbed.
 *
 * What is held:
 *   • the drawer's main entries follow the saved order — on a desk (the sidebar) and on a phone
 *     (the sidebar as a drawer, and the sheet behind «المزيد»);
 *   • the bottom bar follows the saved four, in the order saved, and is never shorter than the
 *     screens this person can reach;
 *   • nothing arranged, an arrangement that cannot be read, a role base the person has not
 *     touched: «exactly as today»;
 *   • and arranging ADDS nothing — a forged group or a screen the person may not open is in
 *     neither the drawer nor the bar.
 * ═══════════════════════════════════════════════════════════════════════
 */

const here = vi.hoisted(() => ({ path: '/admin/profile' }));
vi.mock('next/navigation', () => ({
  usePathname: () => here.path,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
const { pass } = vi.hoisted(() => ({ pass: ({ children }: { children?: unknown }) => children }));
vi.mock('@/components/shell/Header', () => ({ Header: () => null }));
vi.mock('@/components/shell/NotificationsProvider', () => ({
  NotificationsProvider: pass,
  useNotifications: () => ({ byRoute: {}, items: [], unreadCount: 0, arriving: [] }),
}));
vi.mock('@/components/shell/NotificationCards', () => ({ NotificationCards: () => null }));
vi.mock('@/components/shell/OfflineWatch', () => ({ OfflineWatch: () => null }));
vi.mock('@/components/shell/Watermark', () => ({ Watermark: () => null }));
vi.mock('@/components/shell/IdleGuard', () => ({ IdleGuard: () => null }));
vi.mock('@/components/shell/CommandPalette', () => ({
  CommandPalette: () => null,
  useCommandPalette: () => ({ open: false, setOpen: () => {} }),
}));
vi.mock('@/components/shell/BulkBar', () => ({ BulkProvider: pass, useBulkActive: () => false }));
vi.mock('@/components/shell/HubTabs', () => ({ HubTabs: () => null }));
vi.mock('@/components/shell/ScreenGuide', () => ({ ScreenGuideProvider: pass }));
vi.mock('@/components/shell/FirstRunTour', () => ({ FirstRunTour: () => null }));
vi.mock('@/context/StoreCurrency', () => ({ StoreCurrencyProvider: pass }));
vi.mock('@/lib/sign-out', () => ({ signOut: () => undefined }));
vi.mock('@/components/ai/AiDock', () => ({ AiDock: () => null }));
vi.mock('@/components/ui/Confirm', () => ({ ConfirmProvider: pass }));
vi.mock('@/components/ui/Toast', () => ({ ToastProvider: pass }));

// The server half of the layout: who is looking, what is arranged, which shops they may switch between.
const server = vi.hoisted(() => ({
  user: null as unknown,
  arrangement: null as unknown,
  unreadable: false,
}));
vi.mock('@/lib/page-guard', () => ({
  requireShellContext: async () => ({
    user: server.user,
    companyId: 'c1',
    store: { name: 'متجر', status: 'ACTIVE', country: { id: 'k1', name: 'الأردن', currencyCode: 'JOD' } },
  }),
}));
vi.mock('@/lib/nav-arrangement-store', () => ({
  readArrangement: async () => {
    if (server.unreadable) throw new Error('the table is gone');
    return server.arrangement;
  },
}));
vi.mock('@/lib/geo-context', () => ({ listAccessibleCountries: async () => [], listAccessibleStores: async () => [] }));
vi.mock('@/lib/auth-switches', () => ({ idleSignOutOn: () => false }));

import ShellLayout from '@/app/(system)/(shell)/layout';
import { Shell } from '@/components/shell/Shell';
import { attachGrants, can } from '@/lib/authorization';
import { mobileNav } from '@/lib/mobile-nav';
import { EMPTY_LAYOUT, type NavLayout } from '@/lib/nav-arrangement';
import { ALL_ROUTES, NAV, findRoute, menuNav, visibleNav } from '@/lib/route-registry';
import { repoFile, stripComments } from '@/lib/guard-source';

const userWith = (keys: string[], role = 'MODERATOR') =>
  attachGrants({ id: 'u1', name: 'س', role, status: 'ACTIVE', companyId: 'c1', permissions: keys } as never, {
    fullAccess: false,
    grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])),
  });
const EVERY_KEY = [...new Set(ALL_ROUTES.flatMap((r) => r.permissions ?? []))];
/** The owner: every screen of the registry that has a door, and the assistant. */
const OWNER = () => userWith([...EVERY_KEY, 'ai.use'], 'SUPER_ADMIN');
/** Salwa: a desk, the preparation, the tracking, her orders — and her profile. */
const SALWA = () => userWith(['orders.view', 'confirmation.work', 'confirmation.pull', 'ops.prepare', 'ops.track']);

const arranged = (layout: Partial<NavLayout>) => ({
  base: null,
  own: null,
  resolved: { ...EMPTY_LAYOUT, ...layout },
});

beforeEach(() => {
  here.path = '/admin/profile';
  server.user = OWNER();
  server.arrangement = arranged({});
  server.unreadable = false;
  localStorage.clear();
});
afterEach(() => cleanup());

/** What the server half hands the shell. */
async function layoutProps() {
  const el = (await ShellLayout({ children: null })) as React.ReactElement<React.ComponentProps<typeof Shell>>;
  expect(el.type, 'الـlayout ما رجّع الـShell').toBe(Shell);
  return el;
}
const keysOf = (groups: { key: string }[]) => groups.map((g) => g.key);
const REGISTRY = NAV.map((g) => g.key);

/** The drawer's lines, in order — a hub is one line named for its group, a loose group is its screens. */
const drawerLines = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('aside nav a')).map((a) => a.textContent!.trim());
/** The phone's bottom bar: its tabs, left out «المزيد». */
const barTabs = (container: HTMLElement) =>
  Array.from(container.querySelector('nav[aria-label="التنقل"]')!.querySelectorAll('a')).map((a) => ({
    text: a.textContent!.trim(),
    href: a.getAttribute('href'),
  }));
const labelOf = (path: string) => findRoute(path)!.label;

// ───────────────────────── the layout, on the server ─────────────────────────

describe('what the layout hands the shell', () => {
  it('— nothing arranged: the groups in the registry’s order, no choice of four', async () => {
    const el = await layoutProps();
    expect(keysOf(el.props.groups)).toEqual(REGISTRY);
    expect(el.props.phoneSlots).toBeUndefined();
  });

  it('and an arranged order: the listed groups first, in that order, the rest after in the registry’s', async () => {
    server.arrangement = arranged({ groups: ['ops', 'admin', 'main'] });
    const el = await layoutProps();
    expect(keysOf(el.props.groups)).toEqual(['ops', 'admin', 'main', ...REGISTRY.filter((k) => !['ops', 'admin', 'main'].includes(k))]);
  });

  it('and the phone’s four are passed down as saved — paths, in order — for the bar to keep what the menu still holds', async () => {
    server.arrangement = arranged({ slots: ['/products', '/ops/tracking', '/orders', '/dashboard'] });
    expect((await layoutProps()).props.phoneSlots).toEqual(['/products', '/ops/tracking', '/orders', '/dashboard']);
  });

  it('and the role’s base reaches a person who arranged nothing — the layout reads the RESOLVED one, so the base is what is drawn', async () => {
    server.arrangement = { base: { ...EMPTY_LAYOUT, groups: ['finance'], slots: ['/finance/wallets'] }, own: null, resolved: { ...EMPTY_LAYOUT, groups: ['finance'], slots: ['/finance/wallets'] } };
    const el = await layoutProps();
    expect(keysOf(el.props.groups)[0]).toBe('finance');
    expect(el.props.phoneSlots).toEqual(['/finance/wallets']);
  });

  it('and an arrangement that cannot be read is no arrangement — the menu is the one thing that must still draw', async () => {
    server.unreadable = true;
    const el = await layoutProps();
    expect(keysOf(el.props.groups)).toEqual(REGISTRY);
    expect(el.props.phoneSlots).toBeUndefined();
  });

  it('and it is still `menuNav` that decides which screens are lines — the assistant and the board folded under the dashboard are not', async () => {
    server.arrangement = arranged({ slots: ['/assistant', '/growth/performance', '/orders'], groups: ['growth'] });
    const el = await layoutProps();
    const lines = el.props.groups.flatMap((g) => g.routes.map((r) => r.path));
    expect(lines).not.toContain('/assistant');
    expect(lines).not.toContain('/growth/performance');
    expect(lines.length).toBe(menuNav(server.user as never, can).flatMap((g) => g.routes).length);
  });

  it('and a person who may open only some groups gets only those, arranged', async () => {
    server.user = SALWA();
    server.arrangement = arranged({ groups: ['admin', 'ops', 'finance', 'main'] });
    const el = await layoutProps();
    // `finance` is not hers: it is not in her menu, so it is not in the order either — and it adds nothing
    expect(keysOf(el.props.groups)).toEqual(['admin', 'ops', 'main', 'confirmation']);
    expect(new Set(keysOf(el.props.groups))).toEqual(new Set(keysOf(visibleNav(server.user as never, can))));
  });
});

// ───────────────────────── the sidebar, on a desk and as a phone's drawer ─────────────────────────

describe('the drawer follows the groups', () => {
  it('— unarranged, the lines are in the registry’s order: fifteen of them', async () => {
    const { container } = render(await layoutProps());
    expect(drawerLines(container)).toHaveLength(15);
    // main's four screens, then the hubs in order — the first hub is «مركز التأكيد», the last the profile’s «الإدارة»
    expect(drawerLines(container).slice(0, 5)).toEqual(['لوحة التحكم', 'الطلبات', 'العملاء', 'المنتجات', 'مركز التأكيد']);
    expect(drawerLines(container).slice(-3)).toEqual(['صفحات الهبوط', 'الإعدادات', 'الإدارة']);
  });

  it('and an arranged order moves the main entries — a hub as one line, a loose group as its screens', async () => {
    server.arrangement = arranged({ groups: ['ops', 'admin', 'main', 'storefront'] });
    const { container } = render(await layoutProps());
    const lines = drawerLines(container);
    expect(lines.slice(0, 2)).toEqual(['الشحن', 'الإدارة']);
    expect(lines.slice(2, 6)).toEqual(['لوحة التحكم', 'الطلبات', 'العملاء', 'المنتجات']);
    expect(lines.slice(6, 8)).toEqual(['المتجر', 'صفحات الهبوط']);
    // the rest, in the registry’s order
    expect(lines.slice(8)).toEqual(['مركز التأكيد', 'المخزون', 'المال', 'الرقابة', 'النمو والذكاء', 'المحادثات', 'الإعدادات']);
    expect(lines).toHaveLength(15);
  });

  it('and the lines inside a group still follow their own order — the two arrangements do not meet', async () => {
    server.arrangement = arranged({ groups: ['main'], order: ['/products', '/customers'], pinned: ['/orders'] });
    const { container } = render(await layoutProps());
    expect(drawerLines(container).slice(0, 4)).toEqual(['الطلبات', 'المنتجات', 'العملاء', 'لوحة التحكم']);
  });

  it('and a group with every screen hidden is not drawn, wherever it was put', async () => {
    server.arrangement = arranged({ groups: ['chats', 'main'], hidden: ['/growth/whatsapp/inbox', '/growth/telegram/orders'] });
    const { container } = render(await layoutProps());
    expect(drawerLines(container)).not.toContain('المحادثات');
    expect(drawerLines(container)[0]).toBe('لوحة التحكم');
  });

  it('and a group key nobody has, or one the person may not see, adds no line and takes no place', async () => {
    server.user = SALWA();
    server.arrangement = arranged({ groups: ['forged', 'finance', 'control', 'ops'] });
    const { container } = render(await layoutProps());
    const lines = drawerLines(container);
    expect(lines[0]).toBe('الشحن');
    expect(lines).not.toContain('المال');
    expect(lines).not.toContain('الرقابة');
    expect(lines.length).toBe(menuNav(server.user as never, can).reduce((n, g) => n + (g.hub === 'loose' ? g.routes.length : 1), 0));
  });
});

// ───────────────────────── the bottom bar ─────────────────────────

describe('the bottom bar follows the four', () => {
  const FOUR = ['/products', '/ops/tracking', '/customers', '/dashboard'];

  it('— unarranged, the bar is the system’s four: the ranking, exactly as it was', async () => {
    here.path = '/ops/tracking';
    const { container } = render(await layoutProps());
    const groups = menuNav(server.user as never, can);
    expect(barTabs(container).map((t) => t.href)).toEqual(mobileNav(groups, here.path).primary.map((r) => r.path));
    // …which, written out, is the desk, the queue, the preparation and the tracking — not `mobileNav` agreeing with itself
    expect(barTabs(container).map((t) => t.href)).toEqual(['/confirmation/mine', '/confirmation/queue', '/ops/preparation', '/ops/tracking']);
  });

  it('and a saved four are the bar, in the order saved — each a link to its screen, with «المزيد» after them', async () => {
    here.path = '/ops/tracking';
    server.arrangement = arranged({ slots: FOUR });
    const { container } = render(await layoutProps());
    expect(barTabs(container)).toEqual(FOUR.map((p) => ({ text: labelOf(p), href: p })));
    const bar = within(container.querySelector('nav[aria-label="التنقل"]') as HTMLElement);
    expect(bar.getByRole('button', { name: 'المزيد' })).toBeTruthy();
  });

  it('and the page you are on is forced into the last slot when it is not one of the four — as it always was', async () => {
    here.path = '/finance/matching';
    server.arrangement = arranged({ slots: FOUR });
    const { container } = render(await layoutProps());
    expect(barTabs(container).map((t) => t.href)).toEqual(['/products', '/ops/tracking', '/customers', '/finance/matching']);
  });

  it('and the sheet behind «المزيد» holds everything the four do not — once, in the groups’ arranged order', async () => {
    here.path = '/ops/tracking';
    server.arrangement = arranged({ slots: FOUR, groups: ['admin', 'main'] });
    const { container } = render(await layoutProps());
    fireEvent.click(screen.getByRole('button', { name: 'المزيد' }));
    const sheet = screen.getByRole('dialog', { name: 'كل الشاشات' });
    const links = within(sheet).getAllByRole('link').map((a) => a.textContent!.trim());
    // the profile’s «الإدارة» first (its group was put first), then main's remaining screens — the three taken by the bar are not there
    expect(links[0]).toBe('الإدارة');
    expect(links[1]).toBe('الطلبات');
    for (const taken of FOUR) expect(links, labelOf(taken)).not.toContain(labelOf(taken));
    // and the bar still holds its four
    expect(barTabs(container).map((t) => t.href)).toEqual(FOUR);
  });

  it('and a screen the person may not open, or one that is not a line of the drawer, is not in the bar however it was saved', async () => {
    server.user = SALWA();
    here.path = '/orders';
    server.arrangement = arranged({ slots: ['/finance/wallets', '/assistant', '/growth/performance', '/orders', '/control/audit', '/ops/tracking'] });
    const { container } = render(await layoutProps());
    const tabs = barTabs(container).map((t) => t.href);
    const menu = menuNav(server.user as never, can).flatMap((g) => g.routes.map((r) => r.path));
    for (const href of tabs) expect(menu, `${href} دخل الشريط من خارج القائمة`).toContain(href);
    expect(tabs).toEqual(['/orders', '/ops/tracking', '/confirmation/mine', '/ops/preparation']);
  });

  it('and fewer reachable screens than slots: the bar has as many tabs as the person has screens', async () => {
    server.user = userWith([]);
    here.path = '/admin/profile';
    server.arrangement = arranged({ slots: ['/admin/profile', '/orders', '/ops/tracking'] });
    const { container } = render(await layoutProps());
    expect(barTabs(container).map((t) => t.href)).toEqual(['/admin/profile']);
  });

  it('and the role’s base gives a person with no choice of their own the owner’s four — filled by the ranking where the owner named fewer', async () => {
    server.user = SALWA();
    here.path = '/ops/tracking';
    server.arrangement = { base: null, own: null, resolved: { ...EMPTY_LAYOUT, slots: ['/ops/tracking', '/orders'] } };
    const { container } = render(await layoutProps());
    expect(barTabs(container).map((t) => t.href)).toEqual(['/ops/tracking', '/orders', '/confirmation/mine', '/ops/preparation']);
  });
});

// ───────────────────────── the wiring ─────────────────────────

describe('and the wiring is the one that keeps it so', () => {
  it('— the layout reads both from the one arrangement and hands both to the shell, and the shell hands the four to the bar', () => {
    const layout = stripComments(repoFile('src/app/(system)/(shell)/layout.tsx'));
    expect(layout).toContain('applyArrangement(menuNav(user, can), nav?.resolved ?? null)');
    expect(layout).toContain('phoneSlots={nav?.resolved.slots}');
    const shell = stripComments(repoFile('src/components/shell/Shell.tsx'));
    expect(shell).toContain('<MobileNav groups={groups} slots={phoneSlots} />');
    const bar = stripComments(repoFile('src/components/shell/MobileNav.tsx'));
    expect(bar).toContain('mobileNav(groups, pathname, slots)');
  });

  it('and the bar still has nothing but real links and buttons of 44px — the new prop added no control', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/shell/MobileNav.tsx'), 'utf8');
    const targets = (src.match(/<Link|<button|<InstallAppLine/g) ?? []).length;
    const tapped = (src.match(/\$\{TAP\}/g) ?? []).length;
    expect(tapped).toBe(targets);
  });
});
