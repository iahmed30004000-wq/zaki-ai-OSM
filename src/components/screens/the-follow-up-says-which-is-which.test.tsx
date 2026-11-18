// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';
import { attachGrants } from '@/lib/authorization';
import { linkFor } from '@/lib/notification';
import { ALL_ROUTES, findRoute } from '@/lib/route-registry';

/**
 * «المتابعة» — TWO KINDS OF «CALL THEM AGAIN LATER», AND IT MUST BE OBVIOUS WHICH IS WHICH.
 *
 * The owner, 24/10, asked to join «الطلبات المؤجلة» and «استرجاع الملغى» on one
 * condition: «لازم يفهم بس انو هاد مؤجل وهاد كان ملغي من قبل». So the tabs are named for
 * what the orders ARE — «مؤجلة» and «ملغاة سابقاً» — and each tab is the SAME list that
 * stood alone before, drawn inside a page that owns the one title.
 *
 *   · the supervisor opens «المتابعة» on «مؤجلة», and `?tab=winback` (the old win-back
 *     address redirects there) opens the other;
 *   · neither list draws its own heading under the page's (`embedded`);
 *   · an AGENT is not offered «ملغاة سابقاً» — it is a discount, which is money — and her
 *     postponed orders are a tab of «طلباتي», so the menu does not show her this page;
 *   · the two old addresses redirect for good, and a «postponed order came due» notice
 *     reaches each person at the screen that is theirs.
 */

const { params, user } = vi.hoisted(() => ({
  params: { current: new URLSearchParams() },
  user: { current: { id: 'u1', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.supervise'], status: 'ACTIVE' } as Record<string, unknown> },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => params.current,
  usePathname: () => '/confirmation/follow-up',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: user.current, t: {}, locale: 'ar' }),
}));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({
  ConfirmationPostponedScreen: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="postponed-list" data-embedded={String(!!embedded)} />
  ),
}));
vi.mock('@/components/screens/WinbackScreen', () => ({
  WinbackScreen: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="winback-list" data-embedded={String(!!embedded)} />
  ),
}));

// 18/11 (R10c): the lane is a stand-in here — this file asks WHERE it is drawn, the lane's own test asks what it draws.
vi.mock('@/components/screens/LeadsLane', () => ({
  LeadsLane: () => <div data-testid="leads-lane" />,
}));

import { ConfirmationFollowUpScreen } from './ConfirmationFollowUpScreen';

beforeEach(() => {
  params.current = new URLSearchParams();
  user.current = { id: 'u1', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.supervise'], status: 'ACTIVE' };
});
afterEach(cleanup);

describe('«المتابعة» — the screen', () => {
  it('opens on «مؤجلة», with both tabs named for what the orders are, under ONE title', () => {
    render(<ConfirmationFollowUpScreen />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['مؤجلة', 'ملغاة سابقاً']);
    expect(screen.getByRole('tab', { name: 'مؤجلة' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('postponed-list').getAttribute('data-embedded')).toBe('true');
    expect(screen.queryByTestId('winback-list')).toBeNull();
  });

  it('pressing «ملغاة سابقاً» shows the win-back list, drawn without a title of its own', () => {
    render(<ConfirmationFollowUpScreen />);
    fireEvent.click(screen.getByRole('tab', { name: 'ملغاة سابقاً' }));
    expect(screen.getByTestId('winback-list').getAttribute('data-embedded')).toBe('true');
    expect(screen.queryByTestId('postponed-list')).toBeNull();
  });

  it('`?tab=winback` — where the old «استرجاع الملغى» address lands — opens the second tab', () => {
    params.current = new URLSearchParams('tab=winback');
    render(<ConfirmationFollowUpScreen />);
    expect(screen.getByTestId('winback-list')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'ملغاة سابقاً' }).getAttribute('aria-selected')).toBe('true');
  });

  it('NEGATIVE: without `confirmation.supervise` there is no «ملغاة سابقاً» tab, even from the link', () => {
    user.current = { ...user.current, permissions: ['confirmation.work'] };
    params.current = new URLSearchParams('tab=winback');
    render(<ConfirmationFollowUpScreen />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['مؤجلة']);
    expect(screen.getByTestId('postponed-list')).toBeTruthy();
    expect(screen.queryByTestId('winback-list')).toBeNull();
  });
});

/*
 * 18/11 (R10c): «ليدز الصفحات» stood above these tabs. It is now the third tab of «زبائن ما كمّلوا» (`/abandoned-carts`), so the
 * line above the tabs points there — for whoever may open that screen (`orders.view`). A supervisor who may not keeps the lane
 * right here, so nobody loses the leads. Both branches are below.
 */
describe('«ليدز الصفحات» — moved, and nobody loses it', () => {
  it('a supervisor who may open «زبائن ما كمّلوا» gets ONE line pointing at its leads tab, and no lane here', () => {
    user.current = { ...user.current, permissions: ['confirmation.supervise', 'orders.view'] };
    render(<ConfirmationFollowUpScreen />);
    const link = screen.getByRole('link', { name: /ليدز الصفحات صارت/ });
    expect(link.getAttribute('href')).toBe('/abandoned-carts?tab=leads');
    expect(link.textContent).toContain(`«${findRoute('/abandoned-carts')!.label}»`);
    expect(findRoute('/abandoned-carts')!.label).toBe('زبائن ما كمّلوا');
    expect(screen.queryByTestId('leads-lane')).toBeNull();
  });

  it('NEGATIVE: a supervisor WITHOUT `orders.view` keeps the lane here, and is not sent to a screen that would refuse him', () => {
    render(<ConfirmationFollowUpScreen />);
    expect(screen.getByTestId('leads-lane')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /ليدز الصفحات صارت/ })).toBeNull();
  });
});

describe('the addresses', () => {
  const ROOT = process.cwd();

  it('«الطلبات المؤجلة» and «استرجاع الملغى» are no longer screens — and redirect for good', () => {
    const config = stripComments(readFileSync(join(ROOT, 'next.config.ts'), 'utf8'));
    expect(config).toMatch(
      /source:\s*'\/confirmation\/postponed'\s*,\s*destination:\s*'\/confirmation\/follow-up'\s*,\s*permanent:\s*true/
    );
    expect(config).toMatch(
      /source:\s*'\/confirmation\/winback'\s*,\s*destination:\s*'\/confirmation\/follow-up\?tab=winback'\s*,\s*permanent:\s*true/
    );
    for (const dir of ['postponed', 'winback']) {
      expect(existsSync(join(ROOT, 'src/app/(system)/(shell)/confirmation', dir, 'page.tsx')), dir).toBe(false);
    }
    expect(ALL_ROUTES.map((r) => r.path)).not.toContain('/confirmation/postponed');
    expect(ALL_ROUTES.map((r) => r.path)).not.toContain('/confirmation/winback');
  });

  it('an agent who arrives with an old bookmark is sent to HER tab, not to a refusal', () => {
    const page = stripComments(
      readFileSync(join(ROOT, 'src/app/(system)/(shell)/confirmation/follow-up/page.tsx'), 'utf8')
    );
    expect(page).toContain("redirect('/confirmation/mine?tab=postponed')");
    // …and the page still asks the registry's own guard for everyone it does show.
    expect(page).toContain("guardRoute('/confirmation/follow-up')");
  });

  it('«حان موعد طلب مؤجَّل» reaches the supervisor at «المتابعة» and the agent at her tab', () => {
    const mk = (keys: string[]) =>
      attachGrants({ id: 'u', role: 'CONFIRMATION_AGENT', status: 'ACTIVE', permissions: keys } as any, {
        fullAccess: false,
        grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])),
      });
    const links = ['/confirmation/follow-up', '/confirmation/mine?tab=postponed'];
    expect(linkFor(mk(['confirmation.supervise']), links)).toBe('/confirmation/follow-up');
    expect(linkFor(mk(['confirmation.work', 'confirmation.pull']), links)).toBe('/confirmation/mine?tab=postponed');
    expect(findRoute('/confirmation/follow-up')?.label).toBe('المتابعة');
  });
});
