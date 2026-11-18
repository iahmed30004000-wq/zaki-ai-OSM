// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>قواعد مركز التأكيد</h1> }));

/*
 * The eight cards are stubbed to a marker each: THIS file pins WHERE they stand (the page, the order, the old group), not what each says — each card's own test does that, and
 * those tests are untouched (C1 moves the cards, it does not edit them).
 */
const CARDS = {
  CallProofCard: 'إثبات المكالمات وجدول المحاولات',
  QueuePriorityCard: 'أولوية الطابور',
  QueueModesCard: 'ساعات وضعَي الطابور',
  IntakeFilterCard: 'فلتر الاستقبال',
  WinbackV2Card: 'الاسترجاع اليومي',
  LeadsV2Card: 'ليدز الصفحات',
  NoAnswerRoundsCard: 'نظام الجولات',
  NoAnswerReturnsCard: 'الطلب يرجع للطابور فوراً',
} as const;
vi.mock('@/components/settings/CallProofCard', () => ({ CallProofCard: () => <div data-card="CallProofCard" /> }));
vi.mock('@/components/settings/QueuePriorityCard', () => ({ QueuePriorityCard: () => <div data-card="QueuePriorityCard" /> }));
vi.mock('@/components/settings/QueueModesCard', () => ({ QueueModesCard: () => <div data-card="QueueModesCard" /> }));
vi.mock('@/components/settings/IntakeFilterCard', () => ({ IntakeFilterCard: () => <div data-card="IntakeFilterCard" /> }));
vi.mock('@/components/settings/WinbackV2Card', () => ({ WinbackV2Card: () => <div data-card="WinbackV2Card" /> }));
vi.mock('@/components/settings/LeadsV2Card', () => ({ LeadsV2Card: () => <div data-card="LeadsV2Card" /> }));
vi.mock('@/components/settings/NoAnswerRoundsCard', () => ({ NoAnswerRoundsCard: () => <div data-card="NoAnswerRoundsCard" /> }));
vi.mock('@/components/settings/NoAnswerReturnsCard', () => ({ NoAnswerReturnsCard: () => <div data-card="NoAnswerReturnsCard" /> }));

import { ConfirmationRulesScreen } from './ConfirmationRulesScreen';
import { ALL_ROUTES, NAV, canAccessRoute, findRoute } from '@/lib/route-registry';
import { GUIDED_PATHS } from '@/lib/route-guide';
import { attachGrants, can } from '@/lib/authorization';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «قواعد مركز التأكيد» — THE EIGHT CARDS LIVE ON ONE PAGE (C1, 18/11)
 *
 * DEFINITION OF DONE it pins:
 *  1. `/confirmation/rules` opens for a holder of `settings.view` and for nobody else; it is the LAST tab of the confirmation hub.
 *  2. The eight cards are on it — six in the body, the two OLD ones (rounds, returns) together at the bottom under «قواعد قديمة — بتنشال بالتحديث الجاي» — and on no other page.
 *  3. «إعدادات النظام» keeps the company's own cards and none of the eight; the address still exists (an old bookmark opens it).
 *  4. The box «القاعدة بالمختصر» is the first thing under the title and prints what the server sent, line by line.
 *  5. The page is a column that can only be as wide as the phone: no fixed width, no horizontal overflow, no `nowrap`.
 * ═══════════════════════════════════════════════════════════════════════
 */
afterEach(cleanup);
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const LINES = ['السطر الأول من القاعدة.', 'السطر التاني من القاعدة.'];

describe('1 · who opens it', () => {
  const userWith = (keys: string[]) => attachGrants({ id: 'u', role: 'MODERATOR', status: 'ACTIVE', permissions: keys } as never, { fullAccess: false, grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])) });
  const route = () => findRoute('/confirmation/rules')!;

  it('is registered on exactly `settings.view`, with its own name', () => {
    expect(route().permissions).toEqual(['settings.view']);
    expect(route().label).toBe('قواعد مركز التأكيد');
  });

  it('opens for a holder of settings.view even with no confirmation key — and for nobody who lacks it', () => {
    expect(canAccessRoute(userWith(['settings.view']), route(), can)).toBe(true);
    for (const keys of [['confirmation.work', 'confirmation.pull'], ['confirmation.supervise', 'confirmation.issues'], ['settings.manage'], ['orders.view'], []]) {
      expect(canAccessRoute(userWith(keys), route(), can), keys.join()).toBe(false);
    }
  });

  it('is the last tab of the confirmation hub, and is counted once among the screens', () => {
    const group = NAV.find((g) => g.key === 'confirmation')!;
    expect(group.routes.at(-1)!.path).toBe('/confirmation/rules');
    expect(ALL_ROUTES.filter((r) => r.path === '/confirmation/rules')).toHaveLength(1);
  });

  it('has its guide (the ⓘ) and a page that asks the guard for ITS address — and nothing else on it', () => {
    expect(GUIDED_PATHS).toContain('/confirmation/rules');
    const page = read('src/app/(system)/(shell)/confirmation/rules/page.tsx');
    expect(page).toContain("guardRoute('/confirmation/rules')");
    for (const name of Object.keys(CARDS)) expect(page, name).not.toContain(name);
  });
});

describe('2 · the eight cards, in their places', () => {
  const stands = () => {
    const { container } = render(<ConfirmationRulesScreen lines={LINES} />);
    return container;
  };
  const marks = (root: ParentNode) => [...root.querySelectorAll('[data-card]')].map((n) => n.getAttribute('data-card'));

  it('all eight are drawn, once each', () => {
    const all = marks(stands());
    expect([...all].sort()).toEqual(Object.keys(CARDS).sort());
    expect(new Set(all).size).toBe(8);
  });

  it('the six live cards come first; the two old ones are TOGETHER at the bottom, inside the group that says what they are', () => {
    const root = stands();
    const all = marks(root);
    expect(all.slice(0, 6).sort()).toEqual(['CallProofCard', 'IntakeFilterCard', 'LeadsV2Card', 'QueueModesCard', 'QueuePriorityCard', 'WinbackV2Card']);
    expect(all.slice(6)).toEqual(['NoAnswerRoundsCard', 'NoAnswerReturnsCard']);
    const group = screen.getByRole('region', { name: 'قواعد قديمة — بتنشال بالتحديث الجاي' });
    expect(marks(group)).toEqual(['NoAnswerRoundsCard', 'NoAnswerReturnsCard']);
    expect(within(group).getByText(/القاعدة الوحدة اللي فوق هي اللي بتحكم/)).toBeTruthy();
    expect(within(group).getByText(/«إثبات المكالمات وجدول المحاولات» يكون شغّال/)).toBeTruthy();
  });

  it('the six live cards are NOT inside the old group', () => {
    stands();
    const group = screen.getByRole('region', { name: 'قواعد قديمة — بتنشال بالتحديث الجاي' });
    for (const live of ['CallProofCard', 'QueuePriorityCard', 'QueueModesCard', 'IntakeFilterCard', 'WinbackV2Card', 'LeadsV2Card']) {
      expect(group.querySelector(`[data-card="${live}"]`), live).toBeNull();
    }
  });

  it('every card of the page is a card that is imported from the settings folder, once, and is on no OTHER screen', () => {
    const rules = read('src/components/screens/ConfirmationRulesScreen.tsx');
    for (const name of Object.keys(CARDS)) {
      expect(rules, name).toContain(`from '@/components/settings/${name}'`);
      expect(rules.match(new RegExp(`<${name} />`, 'g')), name).toHaveLength(1);
    }
    const others = ['src/components/screens/SystemSettingsScreen.tsx', 'src/components/screens/SettingsHomeScreen.tsx'];
    for (const file of others) {
      if (!existsSync(join(process.cwd(), file))) continue;
      const text = read(file);
      for (const name of Object.keys(CARDS)) expect(text, `${file}: ${name}`).not.toContain(name);
    }
  });
});

describe('3 · «إعدادات النظام» keeps its own cards and none of the eight', () => {
  const system = read('src/components/screens/SystemSettingsScreen.tsx');

  it('no import, no element of any of the eight', () => {
    for (const name of Object.keys(CARDS)) expect(system, name).not.toContain(name);
  });

  it('and still draws the company\'s own: the name, the score, the deductions, the offer after the order, the clean-line settlement and the partners', () => {
    for (const keep of ['PerformanceSettingsCard', 'PenaltyRulesCard', 'PostOrderOfferCard', 'PerLineSettlementCard', 'PartnersCard']) {
      expect(system, keep).toContain(`<${keep} />`);
    }
    expect(system).toContain('اسم الشركة');
  });

  it('an old bookmark of «إعدادات النظام» still lands somewhere: the address, its guard and its page are all still there', () => {
    expect(findRoute('/settings/system')).toBeDefined();
    expect(existsSync(join(process.cwd(), 'src/app/(system)/(shell)/settings/system/page.tsx'))).toBe(true);
  });

  it('and no screen tells the person to look for one of the eight in «إعدادات النظام»', () => {
    const cardText = Object.values(CARDS);
    const guide = read('src/lib/route-guide-texts.ts');
    const at = guide.indexOf("'/settings/system': {");
    const block = guide.slice(at, guide.indexOf("'/admin/jobs'", at));
    for (const title of cardText) expect(block, title).not.toContain(title);
  });
});

describe('4 · the box', () => {
  it('is titled «القاعدة بالمختصر», first under the title, one list item per line the server sent', () => {
    const { container } = render(<ConfirmationRulesScreen lines={LINES} />);
    const children = [...container.firstElementChild!.children];
    expect(children[0].textContent).toBe('قواعد مركز التأكيد');
    expect(children[1].textContent).toContain('القاعدة بالمختصر');
    const items = [...container.querySelectorAll('[data-rule-summary] li')].map((n) => n.textContent);
    expect(items).toEqual(LINES);
  });

  it('types no number of its own: nothing drawn by the screen itself carries a digit (the lines are the server’s)', () => {
    const { container } = render(<ConfirmationRulesScreen lines={[]} />);
    expect(container.textContent).not.toMatch(/\d/);
  });
});

describe('5 · the phone: 375 px has nothing to scroll sideways', () => {
  const code = read('src/components/screens/ConfirmationRulesScreen.tsx').replace(/\/\*[\s\S]*?\*\//g, '');

  it('the page is one column with a maximum width and no fixed one', () => {
    const { container } = render(<ConfirmationRulesScreen lines={LINES} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/\bmax-w-3xl\b/);
    expect(root.className).toMatch(/\bspace-y-4\b/);
    expect(root.getAttribute('dir')).toBe('rtl');
  });

  it('no class that makes a row wider than its parent', () => {
    for (const bad of [/\bw-\[/, /\bmin-w-/, /\bw-screen\b/, /\boverflow-x-/, /\bwhitespace-nowrap\b/, /\bflex-nowrap\b/, /\bw-\d{3,}\b/]) {
      expect(code, String(bad)).not.toMatch(bad);
    }
  });

  it('the box\'s list breaks its lines (a sentence is a block, not a nowrap row)', () => {
    const { container } = render(<ConfirmationRulesScreen lines={LINES} />);
    const list = container.querySelector('[data-rule-summary]') as HTMLElement;
    expect(list.className).toMatch(/leading-relaxed/);
    expect(list.className).not.toMatch(/nowrap|truncate/);
  });
});
