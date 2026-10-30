// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PRODUCTS LIST SAYS ITS NUMBERS — «بطاقات ذكية في المنتجات زي احصائيات» · «المبيعات في جدول المنتجات فش ارقام؟».
 *
 * The «المبيعات» column read a counter that is only moved when a delivery draws its units from a production batch: 14 products
 * held 17,664 delivered units and 13 of them showed 0. It now prints what `GET /api/products/stats` counted — and what is held
 * here is that it prints THAT, in three honest states (on its way, unreadable, read), and never the old counter as a fallback:
 * a number that is wrong is worse than a dash.
 *
 * The cards above the table are the same answer. Each carries the sentence that says what it counts, nothing is drawn until the
 * answer is in (so there is no card of zeros to be read meanwhile), and the value of the stock is a card only when the server
 * sent it — it is what the goods cost, and a caller who may not see that is not shown a zero in its place.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { push, viewer } = vi.hoisted(() => ({ push: vi.fn(), viewer: { current: { id: 'u1', role: 'CUSTOM', status: 'ACTIVE', permissions: ['products.view', 'insights.view'] } } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { products: 'المنتجات', loading: 'جارٍ التحميل…' }, locale: 'ar', currentUser: viewer.current }) }));
vi.mock('@/context/StoreCurrency', () => ({ useStoreCurrency: () => ({ code: 'JOD', minorUnit: 3 }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/products/CategoryPicker', () => ({ CategoryPicker: () => <div data-testid="category-picker" /> }));

import { ProductsScreen } from './ProductsScreen';

// The old counter, set to figures that are wrong on purpose: if either reaches the screen, a claim below fails loudly.
const TRAP_A = 999;
const TRAP_B = 555;
const list = [
  { id: 'p1', name: 'طاقية إنبات الشعر', nameEn: 'Cap', sku: 'LEG-23', basePrice: 25, status: 'ACTIVE', categoryId: 'cat', category: { id: 'cat', name: 'عناية' }, images: [], offers: [], analytics: { totalRemaining: 9, totalSold: TRAP_A } },
  { id: 'p2', name: 'كريم الفطريات', nameEn: 'Cream', sku: 'LEG-24', basePrice: 14, status: 'ACTIVE', categoryId: null, category: null, images: [], offers: [], analytics: { totalRemaining: 0, totalSold: TRAP_B } },
  { id: 'p3', name: 'ساعة ذكية', nameEn: 'Watch', sku: 'LEG-25', basePrice: 80, status: 'INACTIVE', categoryId: 'cat', category: { id: 'cat', name: 'عناية' }, images: [], offers: [], analytics: { totalRemaining: 4, totalSold: 0 } },
];

const STATS = {
  unitsSold: { p1: 17664, p3: 7 },
  totals: { products: 3, active: 2, unfiled: 1, outOfStock: 1, unitsOnHand: 13, unitsSold: 17671, stockValue: 1234.5 },
  top: { id: 'p1', units: 17664 },
};
const withoutValue = () => {
  const { stockValue: _hidden, ...totals } = STATS.totals;
  return { ...STATS, totals };
};

type StatsAnswer = { kind: 'ok'; body: unknown } | { kind: 'status'; status: number } | { kind: 'pending' };
let answer: StatsAnswer;
let asked: string[];

beforeEach(() => {
  viewer.current = { id: 'u1', role: 'CUSTOM', status: 'ACTIVE', permissions: ['products.view', 'insights.view'] };
  asked = [];
  answer = { kind: 'ok', body: STATS };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      if (url.startsWith('/api/products/stats')) {
        if (answer.kind === 'pending') return new Promise(() => undefined);
        if (answer.kind === 'status') return { ok: false, status: answer.status, json: async () => ({ error: 'تعذّر' }) } as any;
        return { ok: true, status: 200, json: async () => answer.kind === 'ok' && answer.body } as any;
      }
      if (url.startsWith('/api/products/grades')) {
        return {
          ok: true,
          json: async () => ({
            window: { start: null, end: null, days: null },
            minSample: 5,
            salesVisible: false,
            costVisible: false,
            grades: [],
            readiness: { total: 0, graded: 0, thinSample: 0, neverConfirmed: 0, neverOrdered: 0, salesHidden: 0, notSellable: 0, incomplete: 0, gaps: [], why: '' },
          }),
        } as any;
      }
      return { ok: true, json: async () => ({ products: list, uncategorised: 1 }) } as any;
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The row (table or card) of one product, read by the name it shows. */
const rowsOf = (name: string) => screen.getAllByText(name).map((el) => (el.closest('tr') ?? el.closest('li') ?? el.closest('div')) as HTMLElement);
const soldFor = (name: string) => {
  const cells = screen.getAllByText(name).map((el) => (el.closest('tr') as HTMLElement | null)).filter(Boolean) as HTMLElement[];
  expect(cells.length, `ما لقيت صفَّ «${name}» بالجدول`).toBeGreaterThan(0);
  // The sales cell is the one in the column headed «المبيعات (قطعة)».
  const table = cells[0].closest('table') as HTMLTableElement;
  const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
  const at = headers.indexOf('المبيعات (قطعة)');
  expect(at, 'ما في عمود «المبيعات (قطعة)»').toBeGreaterThan(-1);
  return cells[0].querySelectorAll('td')[at - (headers.length - cells[0].querySelectorAll('td').length)]?.textContent?.trim();
};
const ready = async () => {
  render(<ProductsScreen />);
  await waitFor(() => expect(screen.getAllByText('طاقية إنبات الشعر').length).toBeGreaterThan(0));
};

describe('PR-10: the cards and the grade are the smart-card key’s; the column is the catalogue’s', () => {
  it('without insights.view: the column still prints the units, there are no cards, and the grades door is never asked', async () => {
    viewer.current = { id: 'u2', role: 'CUSTOM', status: 'ACTIVE', permissions: ['products.view'] };
    // what the door answers such a caller: the units per product and nothing else
    answer = { kind: 'ok', body: { unitsSold: STATS.unitsSold } };
    await ready();
    await waitFor(() => expect(soldFor('طاقية إنبات الشعر')).toBe('17,664'));
    expect(screen.queryByText('القطع المباعة')).toBeNull();
    expect(screen.queryByText('القطع في المستودع')).toBeNull();
    expect(asked.some((u) => u.startsWith('/api/products/grades')), 'سُئل باب التقدير بلا مفتاحه').toBe(false);
    expect(screen.queryByText('التقدير')).toBeNull();
  });

  it('NEGATIVE (the test of the test): with the key the cards, the grade column and the grades call are all there', async () => {
    await ready();
    await waitFor(() => expect(screen.getByText('القطع المباعة')).toBeTruthy());
    await waitFor(() => expect(asked.some((u) => u.startsWith('/api/products/grades'))).toBe(true));
    expect(screen.getAllByText('التقدير').length).toBeGreaterThan(0);
  });
});

describe('the «المبيعات» column prints what the stats door counted', () => {
  it('— the units delivered to customers, per product, in Latin digits with thousands separated', async () => {
    await ready();
    await waitFor(() => expect(soldFor('طاقية إنبات الشعر')).toBe('17,664'));
    expect(soldFor('ساعة ذكية')).toBe('7');
  });

  it('and a product nobody received says 0 once the answer is in — a real zero, read from an answer', async () => {
    await ready();
    await waitFor(() => expect(soldFor('كريم الفطريات')).toBe('0'));
  });

  it('and the old batch counter is never on the screen — not even as a figure beside the right one', async () => {
    await ready();
    await waitFor(() => expect(soldFor('طاقية إنبات الشعر')).toBe('17,664'));
    const text = document.body.textContent ?? '';
    expect(text, 'عدّاد الدفعات القديم ظهر').not.toContain(String(TRAP_A));
    expect(text, 'عدّاد الدفعات القديم ظهر').not.toContain(String(TRAP_B));
  });

  it('and while the answer is on its way the column says «…» — never a zero, and no card of zeros', async () => {
    answer = { kind: 'pending' };
    await ready();
    expect(soldFor('طاقية إنبات الشعر')).toBe('…');
    expect(soldFor('كريم الفطريات')).toBe('…');
    expect(screen.queryByText('القطع المباعة')).toBeNull();
    expect(screen.queryByText('المنتجات', { selector: 'span' })).toBeNull();
  });

  it('and when the door refuses or fails, the column says «—» and shows no card — and the old counter is NOT the fallback', async () => {
    answer = { kind: 'status', status: 500 };
    await ready();
    await waitFor(() => expect(soldFor('طاقية إنبات الشعر')).toBe('—'));
    expect(soldFor('كريم الفطريات')).toBe('—');
    expect(screen.queryByText('القطع المباعة')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain(String(TRAP_A));
  });

  it('and an answer that is not the answer’s shape is no answer — the same dash, and no crash', async () => {
    answer = { kind: 'ok', body: { products: [] } };
    await ready();
    await waitFor(() => expect(soldFor('طاقية إنبات الشعر')).toBe('—'));
  });

  it('and the stats are asked for once, when the list is', async () => {
    await ready();
    await waitFor(() => expect(soldFor('طاقية إنبات الشعر')).toBe('17,664'));
    expect(asked.filter((u) => u.startsWith('/api/products/stats'))).toHaveLength(1);
  });
});

describe('the cards above the table', () => {
  const card = (title: string) => screen.getByText(title, { selector: 'span' }).closest('div.rounded-lg') as HTMLElement;

  it('— four figures when the server sent the value of the stock, each with its title and its number', async () => {
    await ready();
    await screen.findByText('القطع المباعة');
    expect(within(card('المنتجات')).getByText('3')).toBeTruthy();
    expect(within(card('القطع المباعة')).getByText('17,671')).toBeTruthy();
    expect(within(card('القطع في المستودع')).getByText('13')).toBeTruthy();
    expect(card('قيمة المخزون')).toBeTruthy();
    expect(within(card('قيمة المخزون')).getByText(/1,234\.500/)).toBeTruthy();
  });

  it('and each says in a line what it adds up (the products: how many are active and how many are unfiled)', async () => {
    await ready();
    await screen.findByText('القطع المباعة');
    expect(within(card('المنتجات')).getByText('2 نشط · 1 بلا تصنيف')).toBeTruthy();
    expect(within(card('القطع المباعة')).getByText('الأكثر: طاقية إنبات الشعر (17,664)')).toBeTruthy();
    expect(within(card('القطع في المستودع')).getByText('1 منتج نافد من المستودع')).toBeTruthy();
  });

  it('and each carries the sentence that says what it counts — a figure nobody can check is a figure nobody trusts', async () => {
    await ready();
    await screen.findByText('القطع المباعة');
    for (const title of ['المنتجات', 'القطع المباعة', 'القطع في المستودع', 'قيمة المخزون']) {
      const c = card(title);
      expect(within(c).getByText('قاعدة الاحتساب'), title).toBeTruthy();
      expect(c.querySelector('details p')?.textContent?.length ?? 0, title).toBeGreaterThan(30);
    }
  });

  it('and the sold-units card says the same thing the column does, and says it counts what the customer kept', async () => {
    await ready();
    await screen.findByText('القطع المباعة');
    const rule = card('القطع المباعة').querySelector('details p')?.textContent ?? '';
    expect(rule).toContain('الموصَّلة');
    expect(rule).toContain('«المبيعات»');
  });

  it('and the VALUE of the stock is not a card — not a card of zero — when the server did not send it', async () => {
    answer = { kind: 'ok', body: withoutValue() };
    await ready();
    await screen.findByText('القطع المباعة');
    expect(screen.queryByText('قيمة المخزون')).toBeNull();
    expect(screen.getByText('القطع في المستودع')).toBeTruthy();
  });

  it('and the top seller is the one the server named — found in the list by id, not the first row', async () => {
    answer = { kind: 'ok', body: { ...STATS, top: { id: 'p3', units: 7 } } };
    await ready();
    await screen.findByText('القطع المباعة');
    expect(within(card('القطع المباعة')).getByText('الأكثر: ساعة ذكية (7)')).toBeTruthy();
  });

  it('and when nothing was delivered there is no top seller line — the card says nothing rather than a name with no units', async () => {
    answer = { kind: 'ok', body: { unitsSold: {}, totals: { ...STATS.totals, unitsSold: 0 }, top: null } };
    await ready();
    await screen.findByText('القطع المباعة');
    expect(screen.queryByText(/^الأكثر:/)).toBeNull();
    await waitFor(() => expect(soldFor('طاقية إنبات الشعر')).toBe('0'));
  });

  it('and a top seller the list does not hold is not named — the number is not left hanging beside a name nobody can see', async () => {
    answer = { kind: 'ok', body: { ...STATS, top: { id: 'elsewhere', units: 5 } } };
    await ready();
    await screen.findByText('القطع المباعة');
    expect(screen.queryByText(/^الأكثر:/)).toBeNull();
  });
});

describe('how it is built', () => {
  const src = () => stripComments(readFileSync(join(process.cwd(), 'src/components/screens/ProductsScreen.tsx'), 'utf8'));

  it('— the column no longer reads the batch counter, and says its unit', () => {
    expect(src(), 'عاد العدّاد القديم').not.toContain('totalSold');
    expect(src()).toContain("label: 'المبيعات (قطعة)'");
  });

  it('and the answer is asked through the one client — not a new bare fetch', () => {
    expect(src()).toContain("apiJson<ProductStats>('/api/products/stats')");
    expect(src()).not.toMatch(/fetch\(['"`]\/api\/products\/stats/);
  });

  it('and the screen adds up nothing about sales or stock — every figure arrives from the door', () => {
    const s = src();
    expect(s).not.toMatch(/stats[^;\n]*\.reduce\(/);
    expect(s).not.toMatch(/unitsSold\[[^\]]+\]\s*[-+*/]/);
  });

  it('and an older answer never replaces a newer one', () => {
    const s = src();
    expect(s).toContain('const mine = ++statsSeq.current;');
    expect(s).toContain('if (mine === statsSeq.current) setStats(answer);');
  });
});
