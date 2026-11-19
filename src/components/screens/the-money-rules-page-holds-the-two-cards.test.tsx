// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const here = { path: '/finance/rules' };
vi.mock('next/navigation', () => ({ usePathname: () => here.path, useSearchParams: () => new URLSearchParams() }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/NotificationsProvider', () => ({
  useNotifications: () => ({ byRoute: {}, items: [], unreadCount: 0, arriving: [] }),
}));
vi.mock('@/components/shell/BulkBar', () => ({ useBulkActive: () => false }));
vi.mock('@/lib/sign-out', () => ({ signOut: () => undefined }));
vi.mock('@/lib/db', () => ({ db: {} }));
// The title is the kit's `PageShell` (its own test holds it); only the ⓘ button, which reads the shell's context, is stood in for.
vi.mock('@/components/shell/ScreenGuide', () => ({ GuideButton: () => null }));

/*
 * The two cards are stubbed to a marker each: THIS file pins WHERE they stand (the new page, and not the old one), not what each says — each card's own test
 * does that (`the-per-line-card-says-what-the-switch-changes.test.tsx`, `the-partners-card-saves-only-a-whole-list.test.tsx`), and those tests are untouched:
 * R13i moves the cards, it does not edit them. The three cards that stay on «إعدادات النظام» are stubbed too, so that screen renders without their doors.
 */
const CARDS = {
  PerLineSettlementCard: 'تسوية السطور النظيفة عند الاعتماد (تجريبي)',
  PartnersCard: 'الشركاء والنسب',
} as const;
vi.mock('@/components/settings/PerLineSettlementCard', () => ({ PerLineSettlementCard: () => <div data-card="PerLineSettlementCard" /> }));
vi.mock('@/components/settings/PartnersCard', () => ({ PartnersCard: () => <div data-card="PartnersCard" /> }));
vi.mock('@/components/settings/PerformanceSettingsCard', () => ({ PerformanceSettingsCard: () => <div data-card="PerformanceSettingsCard" /> }));
vi.mock('@/components/settings/PenaltyRulesCard', () => ({ PenaltyRulesCard: () => <div data-card="PenaltyRulesCard" /> }));
vi.mock('@/components/settings/PostOrderOfferCard', () => ({ PostOrderOfferCard: () => <div data-card="PostOrderOfferCard" /> }));
vi.mock('@/components/settings/AuthenticityCodesCard', () => ({ AuthenticityCodesCard: () => <div data-card="AuthenticityCodesCard" /> }));

import { FinanceRulesScreen } from './FinanceRulesScreen';
import { SystemSettingsScreen } from './SystemSettingsScreen';
import { Sidebar } from '@/components/shell/Sidebar';
import { ICONS } from '@/components/shell/icons';
import { PAGE_WIDTHS } from '@/components/ui/PageShell';
import { ALL_ROUTES, NAV, canAccessRoute, findRoute } from '@/lib/route-registry';
import { GUIDED_PATHS } from '@/lib/route-guide';
import { GUIDE_TEXTS } from '@/lib/route-guide-texts';
import { attachGrants, can } from '@/lib/authorization';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «قواعد المال» — THE TWO MONEY CARDS LIVE IN «المال» (R13i, 19/11)
 *
 * DEFINITION OF DONE it pins:
 *  1. `/finance/rules` opens for a holder of `settings.view` and for nobody else — a holder of every `finance.*` key without it is refused, exactly as on
 *     `/settings/system`; it is the LAST tab of «المال», and «المال» is the line that lights on it.
 *  2. The two cards are on it, in order, and on no other screen; «إعدادات النظام» draws neither (rendered, not only read).
 *  3. Every sentence that sent the reader to «إعدادات النظام» for the partners sends them to «قواعد المال» now, and the link goes there.
 *  4. The page has its guide (the ⓘ), naming the two cards; the door of «الإعدادات» kept its keys.
 *  5. The page is a column as wide as the phone: no fixed width, no horizontal overflow, no `nowrap`.
 * ═══════════════════════════════════════════════════════════════════════
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const marks = (root: ParentNode) => [...root.querySelectorAll('[data-card]')].map((n) => n.getAttribute('data-card'));

beforeEach(() => {
  here.path = '/finance/rules';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('1 · who opens it, and where it sits', () => {
  const userWith = (keys: string[]) =>
    attachGrants({ id: 'u', role: 'MODERATOR', status: 'ACTIVE', permissions: keys } as never, { fullAccess: false, grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])) });
  const route = () => findRoute('/finance/rules')!;
  const FINANCE_KEYS = ['finance.view', 'finance.create', 'finance.update', 'finance.cashbox', 'finance.cashbox_view', 'finance.partners', 'finance.wallets_manage'];

  it('is registered on exactly `settings.view` — the key of «إعدادات النظام», where the cards came from — with its own name', () => {
    expect(route().permissions).toEqual(['settings.view']);
    expect(route().permissions).toEqual(findRoute('/settings/system')!.permissions);
    expect(route().label).toBe('قواعد المال');
  });

  it('opens for a holder of settings.view even with no money key', () => {
    expect(canAccessRoute(userWith(['settings.view']), route(), can)).toBe(true);
  });

  it('NEGATIVE: a holder of every finance key but not settings.view is refused — as on /settings/system', () => {
    for (const keys of [FINANCE_KEYS, ['finance.partners', 'finance.view'], ['settlement.review', 'settlement.approve'], ['settings.manage'], ['commission.view'], []]) {
      expect(canAccessRoute(userWith(keys), route(), can), keys.join()).toBe(false);
      expect(canAccessRoute(userWith(keys), findRoute('/settings/system')!, can), `/settings/system ${keys.join()}`).toBe(false);
    }
  });

  it('is the last tab of «المال», counted once, with an icon the menu knows', () => {
    const group = NAV.find((g) => g.key === 'finance')!;
    expect(group.routes.at(-1)!.path).toBe('/finance/rules');
    expect(ALL_ROUTES.filter((r) => r.path === '/finance/rules')).toHaveLength(1);
    expect(ICONS[route().icon], route().icon).toBeTruthy();
  });

  it('lights «المال» in the menu, and only that line', () => {
    const { container } = render(<Sidebar groups={NAV} />);
    const lit = [...container.querySelectorAll('aside nav a')].filter((a) => a.className.includes('bg-[var(--sys-primary)]'));
    expect(lit.map((a) => a.textContent)).toEqual(['المال']);
  });

  it('has a page that asks the guard for ITS address and draws the screen — and nothing else', () => {
    const page = read('src/app/(system)/(shell)/finance/rules/page.tsx');
    expect(page).toContain("guardRoute('/finance/rules')");
    expect(page).toContain('<FinanceRulesScreen />');
    for (const name of Object.keys(CARDS)) expect(page, name).not.toContain(name);
  });

  it('NEGATIVE: the door of «الإعدادات» kept its keys — the move added none and took none', () => {
    expect([...findRoute('/settings')!.permissions!].sort()).toEqual(['apps.view', 'commission.view', 'geo.view', 'settings.view', 'telegram.connect', 'whatsapp.manage']);
  });
});

describe('2 · the two cards, on this page and on no other', () => {
  it('both are drawn, once each, in order — the settlement first, then the partners — under the title «قواعد المال»', () => {
    const { container } = render(<FinanceRulesScreen />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('قواعد المال');
    expect(marks(container)).toEqual(['PerLineSettlementCard', 'PartnersCard']);
  });

  it('each is imported from the settings folder, unchanged, and drawn bare — no prop the old screen did not pass', () => {
    const src = read('src/components/screens/FinanceRulesScreen.tsx');
    for (const name of Object.keys(CARDS)) {
      expect(src, name).toContain(`import { ${name} } from '@/components/settings/${name}';`);
      expect(src.match(new RegExp(`<${name}\\b[^>]*>`, 'g')), name).toEqual([`<${name} />`]);
    }
  });

  it('NEGATIVE: «إعدادات النظام», rendered, draws neither card — and still draws its own three', async () => {
    here.path = '/settings/system';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ company: { name: 'شركة' } }), { status: 200 })));
    const { container } = render(<SystemSettingsScreen />);
    await waitFor(() => expect(screen.getByDisplayValue('شركة')).toBeTruthy());
    const drawn = marks(container);
    for (const name of Object.keys(CARDS)) expect(drawn, name).not.toContain(name);
    // 19/11 (R15a): was ['PerformanceSettingsCard', 'PenaltyRulesCard', 'PostOrderOfferCard'] — the score and the deductions moved, unchanged, to «قواعد الموظفين»
    // (/admin/staff-rules); `the-staff-rules-page-holds-the-two-cards.test.tsx` pins them there. Only the offer after the order stays beside the name.
    // 19/11 (barcode authenticity): «رموز الأصالة» joined this screen as a card of its own (not a page: a registry line rides in every staff screen's first load).
    expect(drawn).toEqual(['PostOrderOfferCard', 'AuthenticityCodesCard']);
  });

  it('NEGATIVE: no other source file in src draws or imports either card', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) {
          const rel = full.slice(process.cwd().length + 1).replace(/\\/g, '/');
          if (rel === 'src/components/screens/FinanceRulesScreen.tsx') continue;
          if (rel === 'src/components/settings/PerLineSettlementCard.tsx' || rel === 'src/components/settings/PartnersCard.tsx') continue;
          const text = readFileSync(full, 'utf8');
          for (const name of Object.keys(CARDS)) if (new RegExp(`<${name}\\b|import \\{[^}]*\\b${name}\\b`).test(text)) offenders.push(`${rel}: ${name}`);
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('3 · the sentences follow the move', () => {
  it('the partners section of «الأرباح» and the partner draw of «حركة جديدة» send the reader to «قواعد المال», never to «إعدادات النظام»', () => {
    const partners = read('src/components/screens/finance/PartnersSection.tsx');
    expect(partners).toContain("action={{ label: 'افتح قواعد المال', href: '/finance/rules' }}");
    expect(partners).toContain('سجّل الشركاء ونسبهم من «قواعد المال»');
    expect(partners).toContain('عدّلها من «قواعد المال».');
    expect(read('src/components/screens/finance/WalletsScreen.tsx')).toContain('ما في شركاء فعّالين — سجّلهم من «قواعد المال».');
    for (const file of ['src/components/screens/finance/PartnersSection.tsx', 'src/components/screens/finance/WalletsScreen.tsx']) {
      expect(read(file), file).not.toContain('إعدادات النظام');
      expect(read(file), file).not.toContain('/settings/system');
    }
  });

  it('and the guide of «إعدادات النظام» does not send anyone there for either card', () => {
    const g = GUIDE_TEXTS['/settings/system'];
    const all = [...g.steps, ...(g.watch ? [g.watch] : [])].join('\n');
    for (const title of Object.values(CARDS)) expect(all, title).not.toContain(title);
  });
});

describe('4 · the guide', () => {
  it('the page has its ⓘ, and its steps name both cards by the titles they print', () => {
    expect(GUIDED_PATHS).toContain('/finance/rules');
    const g = GUIDE_TEXTS['/finance/rules'];
    expect(g).toBeDefined();
    const all = [...g.steps, ...(g.watch ? [g.watch] : [])].join('\n');
    for (const title of Object.values(CARDS)) expect(all, title).toContain(`«${title}»`);
    for (const [name, title] of Object.entries(CARDS)) expect(read(`src/components/settings/${name}.tsx`), name).toContain(`title="${title}"`);
  });
});

describe('5 · the phone: 375 px has nothing to scroll sideways', () => {
  const code = read('src/components/screens/FinanceRulesScreen.tsx').replace(/\/\*[\s\S]*?\*\//g, '');

  it('the page is one column with the narrow cap and no fixed width', () => {
    const { container } = render(<FinanceRulesScreen />);
    const root = container.firstElementChild as HTMLElement;
    for (const c of PAGE_WIDTHS.narrow.split(' ')) expect(root.className.split(' ')).toContain(c);
    const body = root.querySelector('[dir="rtl"]') as HTMLElement;
    expect(body.className).toMatch(/\bspace-y-4\b/);
  });

  it('no class that makes a row wider than its parent', () => {
    for (const bad of [/\bw-\[/, /\bmin-w-/, /\bw-screen\b/, /\boverflow-x-/, /\bwhitespace-nowrap\b/, /\bflex-nowrap\b/, /\bw-\d{3,}\b/]) {
      expect(code, String(bad)).not.toMatch(bad);
    }
  });

  it('NEGATIVE: the screen fetches nothing and types no number — the cards ask their own doors', () => {
    expect(code).not.toMatch(/\bfetch\(|apiJson\(|apiFetch\(/);
    const { container } = render(<FinanceRulesScreen />);
    expect(container.textContent).not.toMatch(/\d/);
  });
});

it('the page file exists at the address the registry names', () => {
  expect(existsSync(join(process.cwd(), 'src/app/(system)/(shell)/finance/rules/page.tsx'))).toBe(true);
});
