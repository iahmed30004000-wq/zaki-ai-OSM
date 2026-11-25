// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const here = { path: '/admin/staff-rules' };
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
 * Every card that ever left «إعدادات النظام» is stubbed to a marker: THIS file pins WHERE each one stands now, not what it says — each card's own test does
 * that, and those tests are untouched (R15a moves the two staff cards, it does not edit them).
 */
const STAFF = {
  PerformanceSettingsCard: 'سكور الموظفين',
  PenaltyRulesCard: 'قواعد الخصم',
} as const;
/** C1 moved eight to «قواعد مركز التأكيد»; C2 retired two of them (one rule, one card) — the six live ones are there. */
const CONFIRMATION = ['CallProofCard', 'QueuePriorityCard', 'QueueModesCard', 'IntakeFilterCard', 'WinbackV2Card', 'LeadsV2Card'] as const;
/** R13i moved two to «قواعد المال». */
const MONEY = ['PerLineSettlementCard', 'PartnersCard'] as const;

vi.mock('@/components/settings/PerformanceSettingsCard', () => ({ PerformanceSettingsCard: () => <div data-card="PerformanceSettingsCard" /> }));
vi.mock('@/components/settings/PenaltyRulesCard', () => ({ PenaltyRulesCard: () => <div data-card="PenaltyRulesCard" /> }));
vi.mock('@/components/settings/PostOrderOfferCard', () => ({ PostOrderOfferCard: () => <div data-card="PostOrderOfferCard" /> }));
vi.mock('@/components/settings/AuthenticityCodesCard', () => ({ AuthenticityCodesCard: () => <div data-card="AuthenticityCodesCard" /> }));
vi.mock('@/components/settings/PerLineSettlementCard', () => ({ PerLineSettlementCard: () => <div data-card="PerLineSettlementCard" /> }));
vi.mock('@/components/settings/PartnersCard', () => ({ PartnersCard: () => <div data-card="PartnersCard" /> }));
vi.mock('@/components/settings/CallProofCard', () => ({ CallProofCard: () => <div data-card="CallProofCard" /> }));
vi.mock('@/components/settings/QueuePriorityCard', () => ({ QueuePriorityCard: () => <div data-card="QueuePriorityCard" /> }));
vi.mock('@/components/settings/QueueModesCard', () => ({ QueueModesCard: () => <div data-card="QueueModesCard" /> }));
vi.mock('@/components/settings/IntakeFilterCard', () => ({ IntakeFilterCard: () => <div data-card="IntakeFilterCard" /> }));
vi.mock('@/components/settings/WinbackV2Card', () => ({ WinbackV2Card: () => <div data-card="WinbackV2Card" /> }));
vi.mock('@/components/settings/LeadsV2Card', () => ({ LeadsV2Card: () => <div data-card="LeadsV2Card" /> }));

import { StaffRulesScreen } from './StaffRulesScreen';
import { SystemSettingsScreen } from './SystemSettingsScreen';
import { FinanceRulesScreen } from './FinanceRulesScreen';
import { ConfirmationRulesScreen } from './ConfirmationRulesScreen';
import { SettingsHomeScreen } from './SettingsHomeScreen';
import { Sidebar } from '@/components/shell/Sidebar';
import { ICONS } from '@/components/shell/icons';
import { PAGE_WIDTHS } from '@/components/ui/PageShell';
import { ALL_ROUTES, NAV, canAccessRoute, findRoute } from '@/lib/route-registry';
import { GUIDED_PATHS } from '@/lib/route-guide';
import { GUIDE_TEXTS } from '@/lib/route-guide-texts';
import { SETTINGS_CARDS } from '@/lib/settings-home';
import { attachGrants, can } from '@/lib/authorization';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «قواعد الموظفين» — THE SCORE AND THE DEDUCTIONS LIVE BESIDE THE STAFF (R15a, 19/11)
 *
 * DEFINITION OF DONE it pins:
 *  1. `/admin/staff-rules` opens for a holder of `settings.view` and for nobody else — a holder of `team.settings` or `penalties.rules` without it is refused,
 *     exactly as on `/settings/system`; it stands beside «الموظفين» in «الإدارة», and «الإدارة» is the line that lights on it.
 *  2. The two cards are on it, in order, and on no other screen; «إعدادات النظام», rendered, draws exactly the company card and «العرض بعد الطلب».
 *  3. Every card that ever left «إعدادات النظام» is reachable, each proven by a render of its new page.
 *  4. «إعدادات النظام» still loads the company name and saves it with the same body `{ name }`.
 *  5. The settings door has a card for it, its keys did not move; the page has its guide, and the guide of «إعدادات النظام» says what is left.
 *  6. The page is a column as wide as the phone.
 * ═══════════════════════════════════════════════════════════════════════
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const marks = (root: ParentNode) => [...root.querySelectorAll('[data-card]')].map((n) => n.getAttribute('data-card'));

beforeEach(() => {
  here.path = '/admin/staff-rules';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('1 · who opens it, and where it sits', () => {
  const userWith = (keys: string[]) =>
    attachGrants({ id: 'u', role: 'MODERATOR', status: 'ACTIVE', permissions: keys } as never, { fullAccess: false, grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])) });
  const route = () => findRoute('/admin/staff-rules')!;

  it('is registered on exactly `settings.view` — the key of «إعدادات النظام», where the cards came from — with its own name', () => {
    expect(route().permissions).toEqual(['settings.view']);
    expect(route().permissions).toEqual(findRoute('/settings/system')!.permissions);
    expect(route().label).toBe('قواعد الموظفين');
  });

  it('opens for a holder of settings.view even with neither edit key', () => {
    expect(canAccessRoute(userWith(['settings.view']), route(), can)).toBe(true);
  });

  it('NEGATIVE: a holder of the edit keys but not settings.view is refused — as on /settings/system', () => {
    for (const keys of [['team.settings'], ['penalties.rules'], ['team.settings', 'penalties.rules', 'penalties.view'], ['users.view', 'roles.view'], ['settings.manage'], []]) {
      expect(canAccessRoute(userWith(keys), route(), can), keys.join()).toBe(false);
      expect(canAccessRoute(userWith(keys), findRoute('/settings/system')!, can), `/settings/system ${keys.join()}`).toBe(false);
    }
  });

  it('stands right before «الموظفين» in «الإدارة», counted once, with an icon the menu knows', () => {
    const paths = NAV.find((g) => g.key === 'admin')!.routes.map((r) => r.path);
    expect(paths.indexOf('/admin/staff-rules')).toBe(paths.indexOf('/admin/users') - 1);
    expect(ALL_ROUTES.filter((r) => r.path === '/admin/staff-rules')).toHaveLength(1);
    expect(ICONS[route().icon], route().icon).toBeTruthy();
  });

  it('lights «الإدارة» in the menu, and only that line', () => {
    const { container } = render(<Sidebar groups={NAV} />);
    const lit = [...container.querySelectorAll('aside nav a')].filter((a) => a.className.includes('bg-[var(--sys-primary)]'));
    expect(lit.map((a) => a.textContent)).toEqual(['الإدارة']);
  });

  it('has a page that asks the guard for ITS address and draws the screen — and nothing else', () => {
    const page = read('src/app/(system)/(shell)/admin/staff-rules/page.tsx');
    expect(page).toContain("guardRoute('/admin/staff-rules')");
    expect(page).toContain('<StaffRulesScreen />');
    for (const name of Object.keys(STAFF)) expect(page, name).not.toContain(name);
  });

  it('NEGATIVE: the door of «الإعدادات» kept its keys — the move added none and took none', () => {
    expect([...findRoute('/settings')!.permissions!].sort()).toEqual(['apps.view', 'commission.view', 'geo.view', 'settings.view', 'telegram.connect', 'whatsapp.manage']);
  });
});

describe('2 · the two cards, on this page and on no other', () => {
  it('both are drawn, once each, in order — the score first, then the deductions — under the title «قواعد الموظفين»', () => {
    const { container } = render(<StaffRulesScreen />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('قواعد الموظفين');
    expect(marks(container)).toEqual(['PerformanceSettingsCard', 'PenaltyRulesCard']);
  });

  it('each is imported from the settings folder, unchanged, and drawn bare — no prop the old screen did not pass', () => {
    const src = read('src/components/screens/StaffRulesScreen.tsx');
    for (const name of Object.keys(STAFF)) {
      expect(src, name).toContain(`import { ${name} } from '@/components/settings/${name}';`);
      expect(src.match(new RegExp(`<${name}\\b[^>]*>`, 'g')), name).toEqual([`<${name} />`]);
    }
  });

  it('NEGATIVE: «إعدادات النظام», rendered, draws exactly the company card and «العرض بعد الطلب» — neither staff card', async () => {
    here.path = '/settings/system';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ company: { name: 'شركة' } }), { status: 200 })));
    const { container } = render(<SystemSettingsScreen />);
    await waitFor(() => expect(screen.getByDisplayValue('شركة')).toBeTruthy());
    // 19/11 (barcode authenticity): «رموز الأصالة» joined this screen as a card of its own. 25/11 (the owner): it left again, for a page
    // of its own beside «باركود المنتجات» (`the-authenticity-pages-stand-side-by-side.test.tsx`).
    expect(marks(container)).toEqual(['PostOrderOfferCard']);
    // The company card is the one drawn by the screen itself: its title and its one field.
    expect(screen.getByText('بيانات الشركة')).toBeTruthy();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('NEGATIVE: no other source file in src draws or imports either card', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) {
          const rel = full.slice(process.cwd().length + 1).replace(/\\/g, '/');
          if (rel === 'src/components/screens/StaffRulesScreen.tsx') continue;
          if (rel === 'src/components/settings/PerformanceSettingsCard.tsx' || rel === 'src/components/settings/PenaltyRulesCard.tsx') continue;
          const text = readFileSync(full, 'utf8');
          for (const name of Object.keys(STAFF)) if (new RegExp(`<${name}\\b|import \\{[^}]*\\b${name}\\b`).test(text)) offenders.push(`${rel}: ${name}`);
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('3 · every card that ever left «إعدادات النظام» is on a page that draws it', () => {
  it('the confirmation rules on «قواعد مركز التأكيد»', () => {
    here.path = '/confirmation/rules';
    const { container } = render(<ConfirmationRulesScreen lines={['سطر.']} />);
    for (const name of CONFIRMATION) expect(marks(container), name).toContain(name);
  });

  it('the money rules on «قواعد المال»', () => {
    here.path = '/finance/rules';
    const { container } = render(<FinanceRulesScreen />);
    expect(marks(container)).toEqual([...MONEY]);
  });

  it('the staff rules here — and each of the three pages is a real page the registry knows', () => {
    const { container } = render(<StaffRulesScreen />);
    expect(marks(container)).toEqual(Object.keys(STAFF));
    for (const [path, dir] of [['/confirmation/rules', 'confirmation/rules'], ['/finance/rules', 'finance/rules'], ['/admin/staff-rules', 'admin/staff-rules']]) {
      expect(findRoute(path), path).toBeTruthy();
      expect(existsSync(join(process.cwd(), `src/app/(system)/(shell)/${dir}/page.tsx`)), path).toBe(true);
    }
  });
});

describe('4 · «إعدادات النظام» still loads and saves the company name', () => {
  it('reads /api/settings, then PATCHes exactly `{ name }` — trimmed — and says it was saved', async () => {
    here.path = '/settings/system';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (init?.method === 'PATCH') return new Response(JSON.stringify({ company: { name: 'شركة جديدة' } }), { status: 200 });
        return new Response(JSON.stringify({ company: { name: 'شركة' } }), { status: 200 });
      }),
    );
    render(<SystemSettingsScreen />);
    const input = await screen.findByDisplayValue('شركة');
    const save = screen.getByRole('button', { name: /احفظ/ }) as HTMLButtonElement;
    // Nothing changed yet: the button waits.
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  شركة جديدة  ' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText('حُفظ اسم الشركة.');
    expect(calls[0].url).toBe('/api/settings');
    const patch = calls.find((c) => c.init?.method === 'PATCH')!;
    expect(patch.url).toBe('/api/settings');
    expect(JSON.parse(String(patch.init!.body))).toEqual({ name: 'شركة جديدة' });
  });

  it('NEGATIVE: a refused save says the server\'s sentence, not «حُفظ»', async () => {
    here.path = '/settings/system';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? new Response(JSON.stringify({ error: 'الاسم مأخوذ' }), { status: 409 })
          : new Response(JSON.stringify({ company: { name: 'شركة' } }), { status: 200 }),
      ),
    );
    render(<SystemSettingsScreen />);
    fireEvent.change(await screen.findByDisplayValue('شركة'), { target: { value: 'شركة تانية' } });
    fireEvent.click(screen.getByRole('button', { name: /احفظ/ }));
    await screen.findByText('الاسم مأخوذ');
    expect(screen.queryByText('حُفظ اسم الشركة.')).toBeNull();
  });
});

describe('5 · the door, the guide and the sentences', () => {
  it('the settings door has ONE card for it, right before the staff, and the card is drawn with a link to it', () => {
    const cards = SETTINGS_CARDS.filter((c) => c.paths.includes('/admin/staff-rules'));
    expect(cards.map((c) => c.key)).toEqual(['staff-rules']);
    const at = SETTINGS_CARDS.findIndex((c) => c.key === 'staff-rules');
    expect(SETTINGS_CARDS[at + 1].key).toBe('staff');
    here.path = '/settings';
    render(<SettingsHomeScreen />);
    expect(screen.getByRole('link', { name: 'قواعد الموظفين' }).getAttribute('href')).toBe('/admin/staff-rules');
  });

  it('and the system card no longer promises the score or the deductions', () => {
    const system = SETTINGS_CARDS.find((c) => c.key === 'system')!;
    expect(system.why).toContain('اسم الشركة');
    expect(system.why).toContain('العرض بعد الطلب');
    for (const word of ['سكور', 'خصم']) expect(system.why, word).not.toContain(word);
  });

  it('the page has its ⓘ, and its steps name both cards by the titles they print', () => {
    expect(GUIDED_PATHS).toContain('/admin/staff-rules');
    const g = GUIDE_TEXTS['/admin/staff-rules'];
    expect(g).toBeDefined();
    const all = [...g.steps, ...(g.watch ? [g.watch] : [])].join('\n');
    for (const title of Object.values(STAFF)) expect(all, title).toContain(`«${title}»`);
    for (const [name, title] of Object.entries(STAFF)) expect(read(`src/components/settings/${name}.tsx`), name).toContain(`title="${title}"`);
  });

  it('the guide of «إعدادات النظام» says what is left — the name, «احفظ», «العرض بعد الطلب» — and sends the staff cards to their page', () => {
    const g = GUIDE_TEXTS['/settings/system'];
    const all = [...g.steps, ...(g.watch ? [g.watch] : [])].join('\n');
    for (const q of ['«اسم الشركة»', '«احفظ»', '«العرض بعد الطلب»', '«قواعد الموظفين»']) expect(all, q).toContain(q);
    for (const title of Object.values(STAFF)) expect(all, title).not.toContain(`«${title}»`);
    // The message templates are not on this screen (they live on «الذكاء الاصطناعي والنصوص»): the old line about them is gone.
    expect(all).not.toContain('قوالب');
  });

  it('the guide of «التطبيقات المثبتة» no longer names a «تحديث» button the screen does not have', () => {
    const g = GUIDE_TEXTS['/apps/installed'];
    expect([...g.steps, ...(g.watch ? [g.watch] : [])].join('\n')).not.toContain('«تحديث»');
    expect(read('src/components/screens/InstalledAppsScreen.tsx')).toContain('useLiveRefresh(');
  });
});

describe('6 · the phone: 375 px has nothing to scroll sideways', () => {
  const code = read('src/components/screens/StaffRulesScreen.tsx').replace(/\/\*[\s\S]*?\*\//g, '');

  it('the page is one column with the narrow cap and no fixed width', () => {
    const { container } = render(<StaffRulesScreen />);
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
    const { container } = render(<StaffRulesScreen />);
    expect(container.textContent).not.toMatch(/\d/);
  });
});
