// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * THE DRAWS BEFORE THE PROFIT'S START ARE ON THE SCREEN, MARKED (25/11, F13). jsdom: nothing behind the login opens in a browser here.
 *
 *   · «الشركاء»: the row carries «قبل بداية الأرباح — ما بتنحسب», and a line says how many were not counted;
 *   · «المسحوبات»: the row carries the same words, and the early ones have a block of their own beside the counted totals.
 * Every figure is the server's; the screen adds nothing. A store with no epoch shows none of it.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/finance/profit', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { cancel: 'تراجع' }, locale: 'ar', isRtl: true, currentUser: { role: 'SUPER_ADMIN', permissions: [] } }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => unknown) => {
    React.useEffect(() => {
      void load();
    }, [load]);
  },
}));

import { PartnersSection } from './PartnersSection';
import { WithdrawalsSection } from './WithdrawalsSection';

const MARK = 'قبل بداية الأرباح — ما بتنحسب';

const drawRow = (over: Record<string, unknown>) => ({
  id: 'd1', walletId: 'w1', walletName: 'الصندوق', partnerId: 'pa', partnerName: 'شريك أ', amount: 900, currencyCode: 'USD',
  valueInStoreCurrency: 900, note: '', createdAt: '2026-09-01T10:00:00.000Z', createdByName: 'المالك', reversed: false, ...over,
});
const STATEMENT = {
  state: 'OK', sharesTotal: 100,
  lines: [
    { id: 'pa', name: 'شريك أ', sharePercent: 50, isActive: true, entitlement: 500, draws: 100, balance: 400, broken: 0 },
    { id: 'pb', name: 'شريك ب', sharePercent: 50, isActive: true, entitlement: 500, draws: 0, balance: 500, broken: 0 },
  ],
  totals: { entitlement: 1000, draws: 100, broken: 0 },
  currency: 'USD', minorUnit: 2, netProfit: 1000,
  trust: { level: 'STATED', present: 1, population: 1, share: 100, ar: 'تمام' },
  uncounted: 0,
  since: '2026-10-27T21:00:00.000Z', sinceDay: '2026-10-28', beforeProfitCount: 1,
  draws: [drawRow({ id: 'd2', amount: 100, valueInStoreCurrency: 100, createdAt: '2026-11-05T10:00:00.000Z' }), drawRow({ beforeProfit: true })],
};

const movement = (over: Record<string, unknown>) => ({
  id: 'm1', walletId: 'wu', direction: 'OUT', amount: 20, currencyCode: 'USD', party: 'شريك أ', category: 'PARTNER_DRAW', note: '',
  partnerId: 'pa', valueInStoreCurrency: 20, createdAt: '2026-11-05T10:00:00.000Z', realDate: '2026-11-05T10:00:00.000Z',
  registeredOnAnotherDay: false, createdByName: 'المالك', isReversal: false, wasReversed: false, reversalOf: null, reversedBy: null,
  reversalReason: null, reversalOfId: null, referenceType: null, referenceId: null, partnerName: 'شريك أ', walletName: 'الصندوق',
  minorUnit: 2, storeName: 'المتجر الأول', storeCurrency: 'USD', storeMinor: 2,
  equivalentRate: null, equivalentRateKind: null, equivalentRateSource: null, equivalentRateAt: null, ...over,
});
const total = (over: Record<string, unknown>) => ({
  storeId: 's1', storeName: 'المتجر الأول', partnerId: 'pa', partnerName: 'شريك أ', currencyCode: 'USD', total: 0, count: 0, minorUnit: 2,
  valueTotal: 0, valueCount: 0, unvaluedTotal: 0, unvaluedCount: 0, storeCurrency: 'USD', storeMinor: 2, ...over,
});
const COUNTED = [total({ total: 20, count: 1, valueTotal: 20, valueCount: 1 })];
const EARLY = [total({ total: 10, count: 1, valueTotal: 10, valueCount: 1 }), total({ currencyCode: 'SYP', minorUnit: 0, total: 150000, count: 1, valueTotal: 10, valueCount: 1 })];
const BOOK = {
  storeId: 's1', storeCurrency: { code: 'USD', minorUnit: 2 },
  partners: [{ id: 'pa', name: 'شريك أ', isActive: true }], currencies: [],
  rows: [movement({}), movement({ id: 'm2', amount: 10, valueInStoreCurrency: 10, realDate: '2026-10-01T10:00:00.000Z', createdAt: '2026-10-01T10:00:00.000Z', beforeProfit: true })],
  totals: COUNTED,
  equivalentSums: { byPartner: [{ partnerId: 'pa', value: 20, count: 1 }], store: { value: 20, count: 1 } },
  equivalentSumLabel: 'المجموع بالدولار',
  byStore: COUNTED,
  beforeProfit: { label: MARK, sinceDay: '2026-10-28', totals: EARLY, byStore: EARLY },
  legacyTotals: [], legacy: [], mayBackfill: false,
};

let answer: Record<string, unknown> = {};
beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (url: string) => {
    if (url === '/api/finance/partners/statement') return answer.statement;
    if (url.startsWith('/api/finance/partners/withdrawals')) return answer.book;
    throw new Error('unexpected ' + url);
  });
  answer = { statement: STATEMENT, book: BOOK };
});
afterEach(cleanup);

describe('«الشركاء»', () => {
  it('the early draw is listed, marked in Arabic, and the card says one was not counted', async () => {
    render(<PartnersSection />);
    const tables = await screen.findAllByRole('table');
    const draws = tables[1];
    const rows = within(draws).getAllByRole('row');
    const early = rows.find((r) => r.textContent?.includes('900'));
    expect(early?.textContent).toContain(MARK);
    expect(rows.filter((r) => r.textContent?.includes(MARK))).toHaveLength(1);
    expect(screen.getByText((t) => t.includes('في 1 سحب قبل بداية الأرباح'))).toBeTruthy();
  });

  it('NEGATIVE: with no epoch nothing is marked and no line is said', async () => {
    const rest: Record<string, unknown> = { ...STATEMENT };
    for (const k of ['since', 'sinceDay', 'beforeProfitCount']) delete rest[k];
    answer.statement = { ...rest, draws: [drawRow({})] };
    render(<PartnersSection />);
    await screen.findAllByRole('table');
    expect(screen.queryByText((t) => t.includes(MARK))).toBeNull();
    expect(screen.queryByText((t) => t.includes('قبل بداية الأرباح'))).toBeNull();
  });
});

describe('«المسحوبات»', () => {
  it('the early row is marked; the early totals are a block of their own, each currency on its own line', async () => {
    const { container } = render(<WithdrawalsSection />);
    await screen.findAllByText(MARK);
    const block = container.querySelector('[data-before-profit]') as HTMLElement;
    expect(block).toBeTruthy();
    expect(block.textContent).toContain(MARK);
    expect(block.textContent).toContain('الأرباح من 2026-10-28');
    const lines = within(block).getAllByRole('listitem').slice(1);
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain('USD');
    expect(lines[1].textContent).toContain('SYP');
    expect(lines[1].textContent).not.toContain('USD 150');
    // The row of the draw itself.
    const rows = screen.getAllByRole('row').filter((r) => r.textContent?.includes(MARK));
    expect(rows).toHaveLength(1);
  });

  it('NEGATIVE: a book with no «beforeProfit» shows no mark and no block', async () => {
    const rest: Record<string, unknown> = { ...BOOK };
    delete rest.beforeProfit;
    answer.book = { ...rest, rows: [movement({})] };
    const { container } = render(<WithdrawalsSection />);
    await screen.findAllByText('شريك أ');
    expect(container.querySelector('[data-before-profit]')).toBeNull();
    expect(screen.queryByText((t) => t.includes(MARK))).toBeNull();
  });
});
