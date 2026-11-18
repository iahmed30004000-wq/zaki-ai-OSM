// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SHELL FITS A 375px PHONE ON FIVE SCREENS — AND THE MENU IS NARROWER ON A DESK (18/11, R4).
 *
 * R4 made the menu 240px instead of 280px, and the shell's own words (menu headings, the
 * menu's footer, the hub pills, the header chips, the «المزيد» sheet's headings) 14px instead
 * of 12px. Bigger words in a bar are how a bar stops fitting; so this renders the REAL shell —
 * the real sidebar, header, pills and bottom bar — on five screens and asks the rendered tree.
 *
 * ⚠️ THIS IS JSDOM, NOT A BROWSER. Nothing behind the login can be opened in a browser here (every
 * account has a second factor only the owner completes), and jsdom does no layout: it cannot
 * measure a scroll width. What it CAN hold is the cause of every sideways scroll this product has
 * had — a fixed width wider than the phone, a closed drawer still taking room, a bar with a
 * fixed height — read off the classes the real components rendered, on each screen.
 * ═══════════════════════════════════════════════════════════════════════
 */

const here = vi.hoisted(() => ({ path: '/dashboard' }));
vi.mock('next/navigation', () => ({
  usePathname: () => here.path,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
const { pass } = vi.hoisted(() => ({ pass: ({ children }: { children?: unknown }) => children }));
// Only the neighbours that fetch, poll or register things. The sidebar, header, pills and bar are real.
vi.mock('@/components/shell/NotificationsProvider', () => ({
  NotificationsProvider: pass,
  useNotifications: () => ({ byRoute: { '/orders': 3 }, items: [], unreadCount: 0, arriving: [] }),
}));
vi.mock('@/components/shell/NotificationCards', () => ({ NotificationCards: () => null }));
vi.mock('@/components/shell/NotificationBell', () => ({ NotificationBell: () => <button aria-label="الإشعارات" /> }));
vi.mock('@/components/shell/MyWork', () => ({ MyWork: () => <span data-testid="my-work" /> }));
vi.mock('@/components/attendance/ShiftChip', () => ({ ShiftChip: () => <span data-testid="shift" /> }));
vi.mock('@/components/shell/OfflineWatch', () => ({ OfflineWatch: () => null }));
vi.mock('@/components/shell/Watermark', () => ({ Watermark: () => null }));
vi.mock('@/components/shell/IdleGuard', () => ({ IdleGuard: () => null }));
vi.mock('@/components/shell/CommandPalette', () => ({
  CommandPalette: () => null,
  useCommandPalette: () => ({ open: false, setOpen: () => {} }),
}));
vi.mock('@/components/shell/BulkBar', () => ({ BulkProvider: pass, useBulkActive: () => false }));
vi.mock('@/components/shell/ScreenGuide', () => ({ ScreenGuideProvider: pass }));
vi.mock('@/components/shell/FirstRunTour', () => ({ FirstRunTour: () => null }));
vi.mock('@/context/StoreCurrency', () => ({ StoreCurrencyProvider: pass }));
vi.mock('@/lib/sign-out', () => ({ signOut: () => undefined }));
vi.mock('@/hooks/useNewCartsCount', () => ({ useNewCartsCount: () => 0 }));

import { Shell } from '@/components/shell/Shell';
import { attachGrants, can } from '@/lib/authorization';
import { ALL_ROUTES, menuNav, type NavGroup } from '@/lib/route-registry';

const EVERY_KEY = [...new Set(ALL_ROUTES.flatMap((r) => r.permissions ?? []))];
const OWNER = () =>
  attachGrants({ id: 'u1', name: 'س', role: 'SUPER_ADMIN', status: 'ACTIVE', companyId: 'c1', permissions: [...EVERY_KEY, 'ai.use'] } as never, {
    fullAccess: false,
    grants: Object.fromEntries([...EVERY_KEY, 'ai.use'].map((k) => [k, { scope: 'ALL_COMPANY' }])),
  });

const PHONE = 375;
const FIVE = ['/dashboard', '/orders', '/confirmation/mine', '/finance/matching', '/settings'];

const draw = (shape: (g: NavGroup[]) => NavGroup[] = (g) => g) =>
  render(
    <Shell
      groups={shape(menuNav(OWNER() as never, can))}
      userName="س"
      userRole="SUPER_ADMIN"
      viewer={{ name: 'س', id: 'u1' }}
      context={{ storeName: 'متجر باسم طويل جداً ليجرّب القصّ', storePaused: false, countryName: 'الأردن', currencyCode: 'JOD', canSwitch: true }}
    >
      <p>الشاشة</p>
    </Shell>
  );

/** Every fixed pixel width an element was rendered with: a width or minimum-width class in px, or an inline width. */
function fixedWidths(container: HTMLElement): { px: number; where: string }[] {
  const out: { px: number; where: string }[] = [];
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? '';
    // Only the phone's classes: a `md:` / `lg:` width is not applied at 375.
    for (const token of cls.split(/\s+/)) {
      const m = token.match(/^(?:min-)?w-\[(\d+)px\]$/);
      if (m) out.push({ px: Number(m[1]), where: `${el.tagName.toLowerCase()} ${token}` });
    }
    const inline = el.style.width || el.style.minWidth;
    const px = inline.match(/^(\d+)px$/);
    if (px) out.push({ px: Number(px[1]), where: `${el.tagName.toLowerCase()} style ${inline}` });
  }
  return out;
}

const classOf = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => cleanup());

describe('the shell at 375px, on five screens (jsdom — classes, not a measured scroll)', () => {
  for (const path of FIVE) {
    it(`${path}: nothing in the shell is wider than the phone, the closed drawer takes no room, the bar can grow`, () => {
      here.path = path;
      const { container } = draw();

      const wide = fixedWidths(container).filter((w) => w.px > PHONE);
      expect(wide, 'عرض ثابت أعرض من الهاتف').toEqual([]);

      // The drawer, closed, is `hidden` below 768 — display:none takes up no width anywhere.
      const aside = container.querySelector('aside[data-tour="sidebar"]');
      expect(classOf(aside), 'القائمة المغلقة تأخذ مكاناً على الهاتف').toContain('hidden');
      expect(classOf(aside)).toContain('md:w-[var(--shell-nav)]');
      expect(classOf(aside)).toContain('md:flex');

      // The page column gives way (min-w-0) and moves clear of the menu only from 768 up.
      const column = aside!.nextElementSibling;
      expect(classOf(column)).toEqual(expect.arrayContaining(['min-w-0', 'md:mr-[var(--shell-nav)]']));
      expect(classOf(column).some((c) => /^mr-/.test(c)), 'هامش القائمة على الهاتف').toBe(false);

      // The header: a minimum, never a fixed height; its group wraps.
      const header = container.querySelector('header')!;
      expect(classOf(header)).toContain('min-h-[72px]');
      expect(classOf(header).some((c) => /^h-\[/.test(c)), 'ارتفاع ثابت للشريط').toBe(false);
      expect(header.querySelector('.flex-wrap'), 'مجموعة الشريط لا تلتف').not.toBeNull();

      // Everything the header showed is still there.
      expect(screen.getByLabelText(/المتجر الحالي/)).toBeTruthy();
      expect(screen.getAllByLabelText('ابحث، انتقل، أو نفّذ').length).toBeGreaterThan(0);
      expect(screen.getByTestId('shift')).toBeTruthy();
      expect(screen.getByTestId('my-work')).toBeTruthy();
      expect(screen.getByLabelText('الإشعارات')).toBeTruthy();
      expect(screen.getByLabelText('تسجيل الخروج')).toBeTruthy();

      // The bottom bar is there, phone-only, and its «المزيد» opens the sheet.
      const bar = container.querySelector('nav[aria-label="التنقل"]')!;
      expect(classOf(bar)).toContain('md:hidden');
    });
  }

  it('the drawer opens from the header and closes from its veil', () => {
    here.path = '/orders';
    const { container } = draw();
    const aside = () => container.querySelector('aside[data-tour="sidebar"]');
    fireEvent.click(screen.getByLabelText('القائمة'));
    expect(classOf(aside())).toContain('flex');
    expect(classOf(aside())).not.toContain('hidden');
    // Open, it is 280px wide on a phone: inside 375.
    expect(classOf(aside())).toContain('w-[280px]');
    const veil = container.querySelector('div.fixed.inset-0.z-40.md\\:hidden') as HTMLElement;
    fireEvent.click(veil);
    expect(classOf(aside())).toContain('hidden');
  });

  it('the «المزيد» sheet opens, with its group headings at 14px', () => {
    here.path = '/dashboard';
    // The real menu is all hubs today, which have no heading; a group that folds (as one added without a hub would) has one.
    draw((groups) => groups.map((g, i) => (i === groups.length - 1 ? { ...g, hub: undefined } : g)));
    fireEvent.click(screen.getByText('المزيد'));
    const sheet = screen.getByRole('dialog', { name: 'كل الشاشات' });
    expect(sheet).toBeTruthy();
    const headings = Array.from(sheet.querySelectorAll('h3'));
    expect(headings.length, 'لا عنوان مجموعة في الشيت').toBeGreaterThan(0);
    for (const h of headings) {
      expect(classOf(h)).toContain('text-sm');
    }
  });
});

describe('the shell’s own words are 14px, and the menu is 240px on a desk', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'app', '(system)', 'system.css'), 'utf8');

  it('the menu is 240px and the rail stays 76px', () => {
    expect(css).toMatch(/:root\s*\{\s*--shell-nav:\s*240px;/);
    expect(css).toMatch(/\[data-rail='1'\]\s*\{\s*--shell-nav:\s*76px;/);
  });

  it('the menu’s group headings and its footer read at 14px, and fold away on the rail', () => {
    here.path = '/orders';
    // One group made to fold (the real menu is all hubs today), so a heading and the tree toggle are drawn.
    const { container } = draw((groups) => groups.map((g, i) => (i === groups.length - 1 ? { ...g, hub: undefined } : g)));
    const footer = screen.getByText('رتّب القائمة').closest('a');
    expect(classOf(footer)).toEqual(expect.arrayContaining(['text-sm', 'rail-hide']));
    expect(classOf(footer)).not.toContain('text-xs');
    const toggle = screen.getByText('اعرض كل القوائم').closest('button');
    expect(classOf(toggle)).toEqual(expect.arrayContaining(['text-sm', 'rail-hide']));
    const headings = Array.from(container.querySelectorAll('aside nav button[aria-expanded]'));
    expect(headings.length, 'لا عنوان مجموعة في القائمة').toBeGreaterThan(0);
    for (const b of headings) {
      expect(classOf(b)).toEqual(expect.arrayContaining(['text-sm', 'rail-hide']));
      expect(classOf(b)).not.toContain('text-xs');
    }
  });

  it('the header’s chips read at 14px', () => {
    here.path = '/orders';
    draw();
    const chip = screen.getByLabelText(/المتجر الحالي/);
    for (const p of Array.from(chip.querySelectorAll('p'))) expect(classOf(p)).toContain('text-sm');
    // And the name and the role beside the bell.
    const who = Array.from(screen.getByText('س', { selector: 'header p' }).parentElement!.querySelectorAll('p'));
    expect(who).toHaveLength(2);
    for (const p of who) {
      expect(classOf(p)).toContain('text-sm');
      expect(classOf(p)).not.toContain('text-xs');
    }
  });

  it('the «التالي» link of a road reads at 14px', () => {
    const found: Element[] = [];
    for (const path of ['/finance/matching', '/finance/settlements', '/ops/batches', '/ops/prepare', '/ops/tracking']) {
      here.path = path;
      const { container } = draw();
      found.push(...Array.from(container.querySelectorAll('main nav > a')).filter((a) => a.textContent?.startsWith('التالي')));
      cleanup();
    }
    expect(found.length, 'لا رابط «التالي» على أي طريق').toBeGreaterThan(0);
    for (const a of found) {
      expect(classOf(a)).toContain('text-sm');
      expect(classOf(a)).not.toContain('text-xs');
    }
  });

  it('the hub pills read at 14px', () => {
    here.path = '/finance/matching';
    const { container } = draw();
    const pills = Array.from(container.querySelectorAll('main nav ul a'));
    expect(pills.length, 'لا حبوب على شاشة المطابقة').toBeGreaterThan(1);
    for (const a of pills) {
      expect(classOf(a)).toContain('text-sm');
      expect(classOf(a)).not.toContain('text-xs');
    }
  });
});
