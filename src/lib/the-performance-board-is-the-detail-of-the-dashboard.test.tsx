// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';
import { attachGrants, can } from './authorization';
import { ALL_ROUTES, canAccessRoute, findRoute, menuNav, visibleNav } from './route-registry';

/**
 * «لوحة الأداء» IS THE DETAIL OF THE DASHBOARD — A LINK THERE, NOT A SECOND MENU LINE.
 *
 * The two read the same `/api/analytics` and drew the same rates, profit and tables,
 * each with its own period picker (owner, 24/10: make the board the DETAIL of the
 * dashboard). What had to stay true, because folding a menu line must never take a
 * screen away from anybody:
 *
 *   · whoever can open the dashboard loses the line and gains «التفاصيل» beside the
 *     period buttons; the board is still at its own address, with its own guard;
 *   · whoever can open the board but NOT the dashboard (a bookkeeper with
 *     `reports.view`) keeps it as a menu line;
 *   · the links are drawn only to whoever may open the other end.
 */

const { may } = vi.hoisted(() => ({ may: { yes: ((_p: string) => true) as (p: string) => boolean } }));
vi.mock('@/hooks/useMayOpen', () => ({
  useMayOpen: () => (target: string | { path: string }) => may.yes(typeof target === 'string' ? target : target.path),
}));

import { BackToDashboardLink, DetailsLink } from '@/components/dashboard/DetailsLinks';

const userWith = (keys: string[], role = 'MODERATOR') =>
  attachGrants({ id: 'u1', role, status: 'ACTIVE', permissions: keys } as any, {
    fullAccess: false,
    grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])),
  });

const pathsOf = (groups: ReturnType<typeof menuNav>) => groups.flatMap((g) => g.routes.map((r) => r.path));

afterEach(() => {
  cleanup();
  may.yes = () => true;
});

describe('the menu', () => {
  it('leaves the board out for somebody who can open the dashboard — and the board is still theirs to open', () => {
    // was: ['dashboard.view', 'reports.view'] — the campaigns line opens on «campaigns.view» since PR-11
    const user = userWith(['dashboard.view', 'reports.view', 'campaigns.view']);
    expect(pathsOf(menuNav(user, can))).not.toContain('/growth/performance');
    // folding is for the menu, never for access
    expect(pathsOf(visibleNav(user, can))).toContain('/growth/performance');
    expect(canAccessRoute(user, findRoute('/growth/performance')!, can)).toBe(true);
    // the rest of the group is untouched
    expect(pathsOf(menuNav(user, can))).toContain('/growth/campaigns');
  });

  it('NEGATIVE: keeps the board as a line for somebody who can open it but not the dashboard', () => {
    const bookkeeper = userWith(['reports.view']);
    expect(pathsOf(menuNav(bookkeeper, can))).toContain('/growth/performance');
    // NEGATIVE (29/10): the retired «عرض التحليلات» opens nothing any more — the migration gave its holders reports.view.
    const retired = userWith(['analytics.view']);
    expect(pathsOf(menuNav(retired, can))).not.toContain('/growth/performance');
    expect(canAccessRoute(retired, findRoute('/growth/performance')!, can)).toBe(false);
  });

  it('and offers it to nobody who may not open it, with or without the dashboard', () => {
    expect(pathsOf(menuNav(userWith(['dashboard.view']), can))).not.toContain('/growth/performance');
  });

  it('drops a group only when folding was all that was in it', () => {
    // «النمو والذكاء» holds more than the board, so it stays; nothing is left empty
    for (const g of menuNav(userWith(['dashboard.view', 'reports.view', 'growth.intelligence']), can)) {
      expect(g.routes.length, g.key).toBeGreaterThan(0);
    }
  });

  it('folds exactly one screen, and only under a screen that exists', () => {
    const folded = ALL_ROUTES.filter((r) => r.foldedUnder);
    expect(folded.map((r) => r.path)).toEqual(['/growth/performance']);
    expect(findRoute(folded[0].foldedUnder!), 'مطوية تحت شاشة غير موجودة').toBeDefined();
  });

  it('is what the shell is handed, while the arrangement door still validates against everything openable', () => {
    const layout = stripComments(readFileSync(join(process.cwd(), 'src/app/(system)/(shell)/layout.tsx'), 'utf8'));
    expect(layout).toContain('menuNav(user, can)');
    const arrangement = stripComments(readFileSync(join(process.cwd(), 'src/app/api/nav/arrangement/route.ts'), 'utf8'));
    expect(arrangement).toContain('visibleNav(user, can)');
    expect(arrangement).not.toContain('menuNav');
  });
});

describe('the links', () => {
  it('«التفاصيل» on the dashboard goes to the board, for somebody who may open it', () => {
    render(<DetailsLink />);
    const link = screen.getByRole('link', { name: 'التفاصيل' });
    expect(link.getAttribute('href')).toBe('/growth/performance');
  });

  it('NEGATIVE: and is not drawn for somebody who may not — a link that ends in a refusal is worse than none', () => {
    may.yes = (p) => p !== '/growth/performance';
    render(<DetailsLink />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('«لوحة التحكم» on the board goes back, only for whoever may open the dashboard', () => {
    render(<BackToDashboardLink />);
    expect(screen.getByRole('link', { name: 'لوحة التحكم' }).getAttribute('href')).toBe('/dashboard');
    cleanup();
    may.yes = (p) => p !== '/dashboard';
    render(<BackToDashboardLink />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('both screens carry their link', () => {
    const read = (f: string) => stripComments(readFileSync(join(process.cwd(), f), 'utf8'));
    expect(read('src/components/screens/DashboardScreen.tsx')).toContain('<DetailsLink />');
    expect(read('src/components/screens/PerformanceScreen.tsx')).toContain('<BackToDashboardLink />');
  });
});
