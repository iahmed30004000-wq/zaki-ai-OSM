// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * «المسحوبات» — «المجموع بالدولار» AND THE RATE OF EACH DRAW (23/11, F8). jsdom: nothing behind the login opens in a browser here.
 *
 *   · each currency keeps its own total (never summed across); «المجموع بالدولار» adds ONLY the stored equivalents (the server's sum);
 *   · a currency with draws of no equivalent carries «بلا سعر — لا تدخل بالمجموع», and those draws are in no sum;
 *   · a draw filled at today's rate shows the rate, «تلقائي» or «يدوي», the source and the date; a typed one shows no rate.
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

import { WithdrawalsSection, UNVALUED_LINE } from './WithdrawalsSection';
import { equivalentSumLabel, equivalentSums } from '@/lib/partner-withdrawals-core';

const movement = (over: Record<string, unknown>) => ({
  id: 'm1', walletId: 'wj', direction: 'OUT', amount: 100, currencyCode: 'JOD', party: 'شريك أ', category: 'PARTNER_DRAW', note: '',
  partnerId: 'p1', valueInStoreCurrency: 141.04, createdAt: '2026-11-23T10:00:00.000Z', realDate: '2026-11-23T10:00:00.000Z',
  registeredOnAnotherDay: false, createdByName: 'سارة', isReversal: false, wasReversed: false, reversalOf: null, reversedBy: null,
  reversalReason: null, reversalOfId: null, referenceType: 'PARTNER_DRAW', referenceId: 'p1', partnerName: 'شريك أ', walletName: 'دينار',
  minorUnit: 3, storeName: 'المتجر الأول', storeCurrency: 'USD', storeMinor: 2,
  equivalentRate: null, equivalentRateKind: null, equivalentRateSource: null, equivalentRateAt: null, ...over,
});
const total = (over: Record<string, unknown>) => ({
  storeId: 's1', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', total: 0, count: 0, minorUnit: 2,
  valueTotal: 0, valueCount: 0, unvaluedTotal: 0, unvaluedCount: 0, ...over,
});
const TOTALS = [
  total({ currencyCode: 'USD', total: 250, count: 1, valueTotal: 250, valueCount: 1 }),
  total({ currencyCode: 'JOD', total: 100, count: 1, minorUnit: 3, valueTotal: 141.04, valueCount: 1 }),
  total({ currencyCode: 'SYP', total: 1300000, count: 1, unvaluedTotal: 1300000, unvaluedCount: 1 }),
  total({ partnerId: 'p2', partnerName: 'شريك ب', currencyCode: 'USDT', total: 500, count: 1, valueTotal: 499, valueCount: 1 }),
];
const BOOK = {
  storeId: 's1',
  storeCurrency: { code: 'USD', minorUnit: 2 },
  partners: [
    { id: 'p1', name: 'شريك أ', isActive: true },
    { id: 'p2', name: 'شريك ب', isActive: true },
  ],
  currencies: [],
  rows: [
    movement({ equivalentRate: 1.41043724, equivalentRateKind: 'AUTO', equivalentRateSource: 'open.er-api.com', equivalentRateAt: '2026-11-23T00:02:32.000Z' }),
    movement({ id: 'm2', amount: 1300000, currencyCode: 'SYP', minorUnit: 2, valueInStoreCurrency: null, walletName: 'ليرة' }),
    movement({ id: 'm3', valueInStoreCurrency: 140, walletName: 'دينار مكتوب' }),
  ],
  totals: TOTALS,
  // The server's sums, made by the same function the book calls (`partner-withdrawals.ts`).
  equivalentSums: equivalentSums(TOTALS, 2),
  equivalentSumLabel: equivalentSumLabel('USD'),
  byStore: [],
  legacyTotals: [],
  legacy: [],
};

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue(BOOK);
});
afterEach(() => cleanup());

describe('the sums', () => {
  it('the function: 250 + 141.04 for one partner, 499 for the other, 890.04 in all — the pound draw with no equivalent in none', () => {
    expect(equivalentSums(TOTALS, 2)).toEqual({
      byPartner: [
        { partnerId: 'p1', value: 391.04, count: 2 },
        { partnerId: 'p2', value: 499, count: 1 },
      ],
      store: { value: 890.04, count: 3 },
    });
    expect(equivalentSumLabel('USD')).toBe('المجموع بالدولار');
    expect(equivalentSumLabel('JOD')).toBe('المجموع بعملة المتجر (JOD)');
  });

  it('NEGATIVE: nothing with an equivalent → zero in all, and no partner line', () => {
    expect(equivalentSums([total({ currencyCode: 'SYP', total: 5, count: 1, unvaluedTotal: 5, unvaluedCount: 1 })], 2)).toEqual({ byPartner: [], store: { value: 0, count: 0 } });
  });

  it('the screen: «المجموع بالدولار» per partner and in all; each currency still on its own line; the pound line says «بلا سعر»', async () => {
    const { container } = render(<WithdrawalsSection />);
    await screen.findByText('مجموع المسحوبات بهالمتجر');
    const text = container.textContent ?? '';
    expect(text).toContain('شريك أ — المجموع بالدولار');
    expect(text).toContain('شريك ب — المجموع بالدولار');
    expect(container.querySelector('[data-sum="store"]')!.textContent).toContain('890.04');
    expect(UNVALUED_LINE).toBe('بلا سعر — لا تدخل بالمجموع');
    expect(text).toContain(UNVALUED_LINE);
    // The pound total is printed in pounds, beside the others — never folded into the dollar sum.
    expect(text).toContain('1,300,000');
  });
});

describe('the rate of each draw', () => {
  it('a filled draw shows its rate, «تلقائي», the source and the date; a typed one shows no rate; one with none says «بلا سعر»', async () => {
    const { container } = render(<WithdrawalsSection />);
    await screen.findByText('مجموع المسحوبات بهالمتجر');
    const text = container.textContent ?? '';
    expect(text).toContain('بسعر 1.41044 · تلقائي · open.er-api.com · 2026/11/23');
    // Only the filled draw carries a rate (the list may draw a row twice — table and card — so count against that draw's own line).
    const rates = text.match(/بسعر \d/g)!.length;
    expect(rates).toBeGreaterThan(0);
    expect(rates).toBe(text.split('بسعر 1.41044 · تلقائي').length - 1);
  });
});
