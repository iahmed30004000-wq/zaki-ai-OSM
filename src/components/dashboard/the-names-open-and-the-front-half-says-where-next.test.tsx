// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { stripComments, repoFile } from '@/lib/guard-source';
import { findRoute } from '@/lib/route-registry';
import { openBalancesStep, openPreparationStep } from '@/lib/next-step';

/**
 * 2ج — THE DASHBOARD'S NAMES OPEN WHAT THEY NAME, AND THE FRONT HALF OF THE ROAD SAYS WHERE NEXT.
 *
 * The two numbered roads (shipping, the courier's money) already carry «الخطوة الجاية». The
 * moments BEFORE them did not: the last order confirmed on a desk, a production run added.
 * Both now carry the hop on the toast that already follows them — for whoever may open the
 * screen it points at, and for nobody else.
 *
 * The dashboard's ranking and leaderboard names were text; they are links to the record
 * (not to a filtered list — a list's length would be all-time while the card's number is
 * the period's, and a link must never land on a number other than the one it was pressed on).
 */

const { may } = vi.hoisted(() => ({ may: { yes: ((_p: string) => true) as (p: string) => boolean } }));
vi.mock('@/hooks/useMayOpen', () => ({
  useMayOpen: () => (target: string | { path: string }) => may.yes(typeof target === 'string' ? target : target.path),
}));

import { PersonNameLink, ProductNameLink } from './NameLinks';

afterEach(() => {
  cleanup();
  may.yes = () => true;
});

describe('the names', () => {
  it('a product ranking name opens the product, a team name opens the person', () => {
    render(
      <>
        <ProductNameLink id="p1" name="كريم الشعر" />
        <PersonNameLink id="u1" name="سامر" />
      </>
    );
    expect(screen.getByRole('link', { name: 'كريم الشعر' }).getAttribute('href')).toBe('/products/p1');
    expect(screen.getByRole('link', { name: 'سامر' }).getAttribute('href')).toBe('/admin/users/u1');
  });

  it('NEGATIVE: for somebody who may not open the screen it is the text it always was', () => {
    may.yes = (p) => p !== '/products' && p !== '/admin/users';
    render(
      <>
        <ProductNameLink id="p1" name="كريم الشعر" />
        <PersonNameLink id="u1" name="سامر" />
      </>
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('كريم الشعر')).toBeTruthy();
    expect(screen.getByText('سامر')).toBeTruthy();
  });

  it('NEGATIVE: and with no id there is nothing to open — a link to nowhere is not drawn', () => {
    render(
      <>
        <ProductNameLink name="بلا معرّف" />
        <PersonNameLink id={null} name="مجهول" />
      </>
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  // 18/11 (R9): was «the dashboard draws them» over DashboardScreen's ranking card and leaderboard. «اليوم» kept three figures, one
  // list and one chart; the leaderboard MOVED to the performance board, and the ranking card was that board's four headlines a
  // second time — so the links went onto the headlines (`Rank`) instead. «الأكثر رفضاً» (ranked by RATE — rejected ÷ total, `analytics.ts`) is not a headline there; its
  // two inputs per product are the board's «الطلبات» and «مرفوض على الهاتف» columns.
  it('the performance board draws them — each headline hands over its product’s id, and the team rows the person’s', () => {
    const src = stripComments(repoFile('src/components/screens/PerformanceScreen.tsx'));
    expect(src).toContain('<ProductNameLink id={id} name={name} />');
    expect(src).toContain('<PersonNameLink id={mod.id} name={mod.name} />');
    for (const k of ['mostRequested', 'mostProfitable', 'mostDelivered']) {
      expect(src, k).toContain(`id={analytics?.rankings?.${k}?.id}`);
    }
    expect(src).toContain('id={topReturned?.productId}');
    // NEGATIVE: «اليوم» no longer draws a ranking at all.
    expect(stripComments(repoFile('src/components/screens/DashboardScreen.tsx'))).not.toContain('ProductNameLink');
  });
});

describe('the front half of the road', () => {
  it('the last order confirmed points at the preparation desk — for whoever may open it', () => {
    expect(openPreparationStep(() => true)).toEqual({ label: 'افتح التجهيز', href: '/ops/preparation' });
  });

  it('NEGATIVE: an agent who confirms and nothing else is told nothing', () => {
    expect(openPreparationStep(() => false)).toBeUndefined();
    expect(openBalancesStep(() => false)).toBeUndefined();
  });

  it('a production run added points at the balances', () => {
    expect(openBalancesStep(() => true)).toEqual({ label: 'افتح الأرصدة', href: '/inventory/balances' });
  });

  it('both are real screens, so a rename cannot leave the step dead', () => {
    expect(findRoute('/ops/preparation')).toBeDefined();
    expect(findRoute('/inventory/balances')).toBeDefined();
  });

  it('and they ask about the SCREEN they point at, nothing else', () => {
    const asked: string[] = [];
    openPreparationStep((p) => (asked.push(p), true));
    openBalancesStep((p) => (asked.push(p), true));
    expect(asked).toEqual(['/ops/preparation', '/inventory/balances']);
  });

  it('the desk offers it ONLY when the desk is empty — never while there is still work on it', () => {
    const src = stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));
    expect(src).toContain('deskIsEmpty(fresh) ? openPreparationStep(mayOpen) : undefined');
  });

  it('the production screen says it worked (it used to close in silence) and carries the way to the balances', () => {
    const src = stripComments(repoFile('src/components/screens/ManufacturingScreen.tsx'));
    expect(src).toContain('toast.done(`أُضيفت التشغيلة ${batchNumber}`');
    expect(src).toContain('openBalancesStep(mayOpen)');
    // …after the server said yes, never about a refusal
    expect(src.indexOf('if (!res.ok) throw new Error(data.error);')).toBeLessThan(src.indexOf('openBalancesStep(mayOpen)'));
  });
});
