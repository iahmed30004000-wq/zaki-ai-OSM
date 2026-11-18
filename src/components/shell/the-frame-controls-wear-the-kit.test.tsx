// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * THE MENU, THE HEADER AND THE PHONE BAR ON THE KIT (18/11, R17d).
 *
 * The header's three icon presses (the menu, the phone's search, the way out) and the «كل الشاشات» sheet's ✕ are the
 * kit's `IconButton`: the same name, the same press, 44px on a phone. Captions are 13px (`text-note`), not 12.
 *
 * What stays a hand-written press, and why (R19's allowed list):
 *   - the header's desk search: it is drawn as a search FIELD — words at the start, the Ctrl K key at the end — and
 *     the kit Button centres its children in one inline span, so it cannot draw that;
 *   - every press of the side menu: the menu paints only from its own `sidebar-*` tokens (R4), and the kit's hover
 *     is the PAGE's surface, which comes later in the sheet than the menu's hover and so wins (measured in the build);
 *     the group headings and «اعرض كل القوائم» are also list rows;
 *   - the sheet's «تسجيل الخروج» and the bar's «المزيد»: list rows / a tab, drawn like the links beside them.
 *
 * And the trap R17c found: the kit Button's `inline-flex` comes AFTER `hidden` in the sheet, so a button that must
 * be hidden on a phone is wrapped — `hidden` on the button itself would draw it anyway.
 */

const DIR = 'src/components/shell';
const src = (name: string) => stripComments(readFileSync(join(process.cwd(), DIR, `${name}.tsx`), 'utf8'));
const cls = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/);

// Built from pieces: a whole class written in a test is a rule in the first-load sheet.
const HIDDEN = 'hidden';
const AT_DESK_FLEX = ['md', 'flex'].join(':');
const AT_DESK_HIDDEN = ['md', 'hidden'].join(':');
const PHONE_SQUARE = ['h-11', 'w-11'];
const CAPTION = ['text', 'note'].join('-');
const SMALL = ['text', 'xs'].join('-');

const signOut = vi.fn(async () => undefined);
vi.mock('@/lib/sign-out', () => ({ signOut: (...a: unknown[]) => signOut(...(a as [])) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/orders' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/shell/NotificationBell', () => ({ NotificationBell: () => <span data-chip="bell" /> }));
vi.mock('./MyWork', () => ({ MyWork: () => <span /> }));
vi.mock('./InstallApp', () => ({ InstallAppButton: () => <span />, InstallAppLine: () => null }));
vi.mock('@/components/attendance/ShiftChip', () => ({ ShiftChip: () => <span /> }));
vi.mock('./BulkBar', () => ({ useBulkActive: () => false }));
vi.mock('@/lib/mobile-nav', () => ({
  mobileNav: () => ({
    primary: [{ path: '/orders', label: 'الطلبات', icon: 'orders' }],
    rest: [{ key: 'g1', label: 'المال', routes: [{ path: '/finance', label: 'المالية', icon: 'finance' }] }],
  }),
}));

import { Header } from './Header';
import { MobileNav } from './MobileNav';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function drawHeader() {
  const onMenuClick = vi.fn();
  const onSearchClick = vi.fn();
  render(
    <Header
      onMenuClick={onMenuClick}
      onSearchClick={onSearchClick}
      userName="تجربة"
      userRole="SUPER_ADMIN"
      context={{ storeName: 'متجر', storePaused: false, countryName: 'بلد', currencyCode: 'XXX', canSwitch: true }}
    />
  );
  return { onMenuClick, onSearchClick };
}

describe('the header', () => {
  it('— «القائمة» is a kit square, phone only, and opens the drawer once per press', () => {
    const { onMenuClick } = drawHeader();
    const menu = screen.getByRole('button', { name: 'القائمة' });
    expect(menu.getAttribute('title')).toBe('القائمة');
    for (const c of PHONE_SQUARE) expect(cls(menu), 'ليس مربّع العدّة').toContain(c);
    expect(cls(menu), 'ظهر زر القائمة على المكتب').toContain(AT_DESK_HIDDEN);
    fireEvent.click(menu);
    expect(onMenuClick).toHaveBeenCalledTimes(1);
  });

  it('and the phone’s search is a kit square that opens the palette', () => {
    const { onSearchClick } = drawHeader();
    const doors = screen.getAllByRole('button', { name: 'ابحث، انتقل، أو نفّذ' });
    expect(doors, 'باب البحث على الهاتف راح').toHaveLength(1);
    const phone = doors[0];
    for (const c of PHONE_SQUARE) expect(cls(phone)).toContain(c);
    expect(cls(phone)).toContain(AT_DESK_HIDDEN);
    fireEvent.click(phone);
    expect(onSearchClick).toHaveBeenCalledTimes(1);
  });

  it('and the desk’s search field keeps its tour anchor, its words and its key, and opens the same palette', () => {
    const { onSearchClick } = drawHeader();
    const desk = document.querySelector('[data-tour="search"]') as HTMLElement;
    expect(desk, 'مرساة الجولة للبحث راحت').toBeTruthy();
    expect(desk.textContent).toContain('ابحث، انتقل، أو نفّذ');
    const key = desk.querySelector('kbd');
    expect(key?.textContent).toContain('Ctrl K');
    expect(cls(key), 'المفتاح رجع ١٢ بكسل').toContain(CAPTION);
    fireEvent.click(desk);
    expect(onSearchClick).toHaveBeenCalledTimes(1);
  });

  it('and the way out is a kit square hidden on a phone by its WRAPPER, and signs out as «manual»', () => {
    drawHeader();
    const out = screen.getByRole('button', { name: 'تسجيل الخروج' });
    for (const c of PHONE_SQUARE) expect(cls(out)).toContain(c);
    // The trap: `hidden` on the kit button loses to its own `inline-flex` in the sheet.
    expect(cls(out), 'الإخفاء على زر العدّة نفسه — بيخسر قدّام inline-flex').not.toContain(HIDDEN);
    expect(cls(out.parentElement), 'الخروج ظهر بالترويسة على الهاتف').toContain(HIDDEN);
    expect(cls(out.parentElement), 'الخروج اختفى عن المكتب').toContain(AT_DESK_FLEX);
    fireEvent.click(out);
    expect(signOut).toHaveBeenCalledWith('manual');
    // Exactly as before the kit: the press is not held busy, so it is never swallowed.
    expect(out.hasAttribute('disabled'), 'زر الخروج صار ينقفل').toBe(false);
  });

  it('and every press in the bar says it is a button, so none can ever submit a form', () => {
    drawHeader();
    const bar = document.querySelector('header') as HTMLElement;
    for (const b of within(bar).getAllByRole('button')) {
      expect(b.getAttribute('type'), b.getAttribute('aria-label') ?? b.textContent ?? '').toBe('button');
    }
  });

  it('and the bar still has a minimum height and no fixed one', () => {
    drawHeader();
    const c = cls(document.querySelector('header'));
    expect(c).toContain(['min', 'h', '[72px]'].join('-'));
    expect(c.filter((x) => /^(?:[a-z0-9]+:)*h-/.test(x))).toEqual([]);
  });
});

describe('the phone’s «كل الشاشات» sheet and bar', () => {
  it('— ✕ is a kit square that closes the sheet', () => {
    render(<MobileNav groups={[] as never} />);
    fireEvent.click(screen.getByRole('button', { name: 'المزيد' }));
    const sheet = screen.getByRole('dialog', { name: 'كل الشاشات' });
    const close = within(sheet).getByRole('button', { name: 'إغلاق' });
    for (const c of PHONE_SQUARE) expect(cls(close), 'الإغلاق أصغر من ٤٤ على الهاتف').toContain(c);
    fireEvent.click(close);
    expect(screen.queryByRole('dialog', { name: 'كل الشاشات' }), 'الإغلاق ما بيسكّر').toBeNull();
  });

  it('and the tabs’ words are 13px captions, still truncated, still one line', () => {
    render(<MobileNav groups={[] as never} />);
    const nav = screen.getByRole('navigation', { name: 'التنقل' });
    const words = [within(nav).getByText('الطلبات'), within(nav).getByText('المزيد')];
    for (const w of words) {
      expect(cls(w), 'كلمة التبويب رجعت ١٢ بكسل').toContain(CAPTION);
      expect(cls(w)).toContain('leading-tight');
    }
    expect(cls(words[0]), 'الكلمة الطويلة بطّلت تنقص').toContain('truncate');
  });
});

describe('the side menu', () => {
  it('— keeps every press hand-written and imports no kit press: the kit’s hover is a page colour', () => {
    const menu = src('Sidebar');
    expect(menu, 'القائمة استوردت زر العدّة — تمريرو لون صفحة').not.toMatch(/from '@\/components\/ui\/(Icon)?Button'/);
    // Its four presses, each still hovering in the menu's own colour.
    // Each press's own class list (its first `className="…"` after the tag opens).
    const presses = menu
      .split('<button')
      .slice(1)
      .map((s) => /className="([^"]*)"/.exec(s)?.[1] ?? '');
    expect(presses).toHaveLength(4);
    for (const p of presses) expect(p).toMatch(/hover:(bg-\[var\(--sys-sidebar-hover\)\]|text-\[var\(--sys-sidebar-heading\)\])/);
  });

  it('and its count chips are 13px captions on the lit row’s own pair', () => {
    const menu = src('Sidebar');
    const chips = menu.match(/className="min-w-5 rounded-full[^"]*"/g) ?? [];
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip).toContain(` ${CAPTION} `);
      expect(chip).not.toContain(SMALL);
      expect(chip).toContain('text-[var(--sys-primary-foreground)]');
    }
  });
});

describe('the four files', () => {
  it('— 12px is left only on the wordmark’s brand line (pinned by system-themes)', () => {
    for (const name of ['Header', 'MobileNav', 'HubTabs']) {
      expect(src(name).split(SMALL).length - 1, `${name}: رجع خط ١٢`).toBe(0);
    }
    expect(src('Sidebar').split(SMALL).length - 1, 'Sidebar: خط ١٢ غير سطر العلامة').toBe(1);
  });

  it('and nothing in them is wider than a 375px phone', () => {
    for (const name of ['Header', 'Sidebar', 'MobileNav', 'HubTabs']) {
      for (const m of src(name).matchAll(/\b(?:min-)?w-\[(\d+)px\]/g)) {
        expect(Number(m[1]), `${name}: ${m[0]}`).toBeLessThanOrEqual(375);
      }
    }
  });

  it('and R4’s pins are where they were', () => {
    const menu = src('Sidebar');
    for (const pin of ['hubHref(group)', 'hubLabel(group)', 'open.has(group.key)', "md:w-[var(--shell-nav)]", "data-tour='sidebar'"]) {
      expect(menu, pin).toContain(pin);
    }
    expect(src('HubTabs')).toContain('hubAt(groups, pathname)');
    const header = src('Header');
    expect(header).toContain('data-tour="search"');
    expect(header).toContain("'data-tour': 'context'");
  });
});
