// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ONE PAGE HEADER (18/11, R3 — «رأس صفحة واحد»).
 *
 * Two headers drew the top of a screen: `PageHeader`, which is handed its
 * title, and the older `ScreenTitle`, which read the address and printed the
 * registry's name for the longest menu path matching it. Twenty-six files
 * drew the older one. They draw `PageHeader` now, and `ScreenTitle` is gone.
 *
 * The reason the older one existed stays true: the name is READ from the
 * registry (`routeLabel('<path>')`), never typed, so the menu and the heading
 * cannot disagree. And the words do not change: at the address each screen
 * is drawn at, the new heading prints exactly what the old one printed there.
 *
 * The table below is each file, the address its page draws it at, and how
 * many headers it draws (the matching screen has two returns, both titled).
 * ═══════════════════════════════════════════════════════════════════════
 */

const here = { path: '/confirmation/mine' };
vi.mock('next/navigation', () => ({ usePathname: () => here.path }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { ScreenGuideProvider } from '@/components/shell/ScreenGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { activePath } from './active-route';
import { ALL_ROUTES, findRoute, routeLabel } from './route-registry';
import { repoFile, stripComments } from './guard-source';

afterEach(() => cleanup());

/** [file, the address it is titled by, how many headers it draws, the page file that draws it there (null: a tab, drawn embedded)] */
const TABLE: [string, string, number, string | null][] = [
  ['src/app/(system)/(shell)/settings/tracking/page.tsx', '/settings/tracking', 1, 'src/app/(system)/(shell)/settings/tracking/page.tsx'],
  ['src/components/screens/BenchScreen.tsx', '/growth/bench', 1, 'src/app/(system)/(shell)/growth/bench/page.tsx'],
  ['src/components/screens/BlacklistScreen.tsx', '/control/blacklist', 1, 'src/app/(system)/(shell)/control/blacklist/page.tsx'],
  ['src/components/screens/ChangeRequestsScreen.tsx', '/control/change-requests', 1, 'src/app/(system)/(shell)/control/change-requests/page.tsx'],
  ['src/components/screens/CommissionSettingsScreen.tsx', '/settings/commission', 1, 'src/app/(system)/(shell)/settings/commission/page.tsx'],
  ['src/components/screens/ConfirmationFollowUpScreen.tsx', '/confirmation/follow-up', 1, 'src/app/(system)/(shell)/confirmation/follow-up/page.tsx'],
  ['src/components/screens/ConfirmationIssuesScreen.tsx', '/confirmation/issues', 1, 'src/app/(system)/(shell)/confirmation/issues/page.tsx'],
  ['src/components/screens/ConfirmationMineScreen.tsx', '/confirmation/mine', 1, 'src/app/(system)/(shell)/confirmation/mine/page.tsx'],
  // Drawn only `embedded` (a tab of «المتابعة» and of «طلباتي»), where it draws no title; its old address redirects to «المتابعة».
  ['src/components/screens/ConfirmationPostponedScreen.tsx', '/confirmation/follow-up', 1, null],
  ['src/components/screens/ConfirmationQueueScreen.tsx', '/confirmation/queue', 1, 'src/app/(system)/(shell)/confirmation/queue/page.tsx'],
  ['src/components/screens/CouriersScreen.tsx', '/settings/couriers', 1, 'src/app/(system)/(shell)/settings/couriers/page.tsx'],
  ['src/components/screens/DiscountAlertsScreen.tsx', '/control/discount-alerts', 1, 'src/app/(system)/(shell)/control/discount-alerts/page.tsx'],
  ['src/components/screens/IntelligenceScreen.tsx', '/growth/intelligence', 1, 'src/app/(system)/(shell)/growth/intelligence/page.tsx'],
  ['src/components/screens/InventoryMovementsScreen.tsx', '/inventory/movements', 1, 'src/app/(system)/(shell)/inventory/movements/page.tsx'],
  ['src/components/screens/JobsScreen.tsx', '/admin/jobs', 1, 'src/app/(system)/(shell)/admin/jobs/page.tsx'],
  ['src/components/screens/LinksSettingsScreen.tsx', '/settings/links', 1, 'src/app/(system)/(shell)/settings/links/page.tsx'],
  ['src/components/screens/PreparationScreen.tsx', '/ops/preparation', 1, 'src/app/(system)/(shell)/ops/preparation/page.tsx'],
  ['src/components/screens/ReturnsScreen.tsx', '/ops/returns', 1, 'src/app/(system)/(shell)/ops/returns/page.tsx'],
  ['src/components/screens/ShipmentsNewScreen.tsx', '/ops/shipments/new', 1, 'src/app/(system)/(shell)/ops/shipments/new/page.tsx'],
  // 18/11 (R11c): «دفعات الشحن» typed its title («دفعات الشحن») and was not in this table; it reads it from the registry now.
  ['src/components/screens/ShippingBatchesScreen.tsx', '/ops/batches', 1, 'src/app/(system)/(shell)/ops/batches/page.tsx'],
  ['src/components/screens/TrackingScreen.tsx', '/ops/tracking', 1, 'src/app/(system)/(shell)/ops/tracking/page.tsx'],
  // A tab of «المتابعة», drawn `embedded` there (no title); its old address redirects to «المتابعة».
  ['src/components/screens/WinbackScreen.tsx', '/confirmation/follow-up', 1, null],
  ['src/components/screens/finance/ClosingScreen.tsx', '/finance/closing', 1, 'src/app/(system)/(shell)/finance/closing/page.tsx'],
  ['src/components/screens/finance/CollectionScreen.tsx', '/finance/collection', 1, 'src/app/(system)/(shell)/finance/collection/page.tsx'],
  ['src/components/screens/finance/MatchingScreen.tsx', '/finance/matching', 2, 'src/app/(system)/(shell)/finance/matching/page.tsx'],
  ['src/components/screens/finance/TransfersScreen.tsx', '/finance/transfers', 1, 'src/app/(system)/(shell)/finance/transfers/page.tsx'],
  ['src/components/screens/finance/WalletsScreen.tsx', '/finance/wallets', 1, 'src/app/(system)/(shell)/finance/wallets/page.tsx'],
];

/** What the deleted `ScreenTitle` printed at an address: the label of the longest registry path matching it, or nothing. */
const whatTheOldHeaderPrinted = (address: string): string | null => {
  const lit = activePath(address, ALL_ROUTES.map((r) => r.path));
  return ALL_ROUTES.find((r) => r.path === lit)?.label ?? null;
};

const exportedName = (file: string) => file.split('/').pop()!.replace(/\.tsx$/, '');

describe('one page header', () => {
  it('— the older header is deleted, and nothing in src names it outside a comment', () => {
    expect(existsSync(join(process.cwd(), 'src/components/shell/ScreenTitle.tsx')), 'رجع ScreenTitle').toBe(false);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) {
          if (/ScreenTitle/.test(stripComments(readFileSync(full, 'utf8')))) offenders.push(full);
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders, 'ملفات لسّا بترسم ScreenTitle').toEqual([]);
  });

  /*
   * 18/11 (R8g, «الإشكالات» on the kit): this test said «draws PageHeader» and read only `<PageHeader`. A screen that moves onto
   * the frame draws `<PageShell title=…>`, and the frame draws exactly that `PageHeader` with exactly that title (PageShell.tsx) —
   * so the frame counts as the header here. Every other check is unchanged: one import, the title read through `routeLabel`,
   * never typed, and the count per file. A file that drew BOTH would count two and fail.
   */
  it.each(TABLE)('%s draws PageHeader (itself or through PageShell) with the registry name of %s, read, never typed', (file, path, count) => {
    const src = stripComments(repoFile(file));
    expect(src, 'ما بيستورد PageHeader ولا PageShell').toMatch(
      /import \{ PageHeader \} from '@\/components\/ui\/PageHeader';|import \{ PageShell \} from '@\/components\/ui\/PageShell';/
    );
    expect(src, 'ما بيستورد routeLabel').toMatch(/import \{ routeLabel \} from '@\/lib\/route-registry';/);
    const headers = src.match(/<(?:PageHeader|PageShell)\b/g) ?? [];
    expect(headers, 'عدد الرؤوس').toHaveLength(count);
    const titled = src.match(new RegExp(`<(?:PageHeader|PageShell)\\s+title=\\{routeLabel\\('${path.replace(/\//g, '\\/')}'\\)\\}`, 'g')) ?? [];
    expect(titled, `العنوان مش routeLabel('${path}')`).toHaveLength(count);
    expect(src, 'عنوان مكتوب باليد').not.toMatch(/<(?:PageHeader|PageShell)\s+title="/);
  });

  it('— and PageShell is a PageHeader with the same title, so a screen on the frame still prints the registry name once', () => {
    const shell = stripComments(repoFile('src/components/ui/PageShell.tsx'));
    expect(shell).toMatch(/<PageHeader title=\{title\}/);
    expect(shell.match(/<PageHeader\b/g) ?? []).toHaveLength(1);
  });

  it.each(TABLE.filter((r) => r[3] !== null))('%s is drawn by the page at %s', (file, path, _count, page) => {
    const pageSrc = stripComments(repoFile(page!));
    if (page !== file) expect(pageSrc, `${page} ما بيرسم ${exportedName(file)}`).toMatch(new RegExp(`<${exportedName(file)}\\b`));
    // the page file sits at the address it is titled by
    expect(page).toBe(`src/app/(system)/(shell)${path}/page.tsx`);
  });

  it.each(TABLE)('%s: the name at %s is in the registry, so routeLabel never prints a raw address', (_file, path) => {
    expect(findRoute(path), `${path} مش بالقائمة`).toBeDefined();
    expect(routeLabel(path)).not.toBe(path);
  });

  it.each(TABLE)('%s at %s: one h1, and it says exactly what the old header said there', (_file, path) => {
    render(<PageHeader title={routeLabel(path)} />);
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(whatTheOldHeaderPrinted(path));
  });

  it('and the old header’s answer is a real name for every address of the table — the comparison above is not null against null', () => {
    for (const [, path] of TABLE) expect(whatTheOldHeaderPrinted(path), path).toBeTruthy();
  });
});

describe('the ⓘ on three sample screens', () => {
  it.each(['/confirmation/mine', '/finance/matching', '/settings/tracking'])('%s: opens the guide inside the shell’s provider', async (path) => {
    here.path = path;
    render(
      <ScreenGuideProvider>
        <PageHeader title={routeLabel(path)} />
      </ScreenGuideProvider>
    );
    const button = screen.getByRole('button', { name: 'اشرح لي هذه الشاشة' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
});
