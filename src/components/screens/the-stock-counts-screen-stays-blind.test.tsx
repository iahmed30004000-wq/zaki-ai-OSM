// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «الجرد» (warehouse plan W5b) — the screen of W5a's five doors and of «كشف عهدة الأمين».
 *
 * DEFINITION OF DONE it pins:
 *  1. BLIND: the keeper counting an open sheet is shown no book figure — the screen prints only what the answer carries, draws
 *     the combination boxes from the sheet's own words (no shelf hint), and never works a figure out (a server difference
 *     that does not equal counted − expected is printed as sent).
 *  2. The count: one box per line, one per combination; «احفظ العدّ» sends the typed lines (combinations as typed, zeros
 *     included); «سلّم الجرد» saves then submits.
 *  3. The approval view (expected · counted · difference — and the value at cost only when sent), the press for a second
 *     hand only: whoever had a hand in the count (`youCounted`) gets a sentence instead.
 *  4. A viewer sees what was counted, no press. Void asks a reason.
 *  5. «كشف عهدة الأمين» only for the approver's key; it prints the server's rows, and its value column only for a cost holder.
 *  6. Every refusal is the door's Arabic sentence, printed as it came. The page is registered, guided and on the menu.
 */

const { api, user } = vi.hoisted(() => ({
  api: vi.fn(),
  user: { current: { id: 'u-me', name: 'سارة', role: 'CUSTOM', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar', currentUser: user.current }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/inventory/counts', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenGuide', () => ({ GuideButton: () => null }));
vi.mock('@/hooks/useLiveRefresh', async () => {
  const R = await import('react');
  return { useLiveRefresh: (load: () => unknown) => R.useEffect(() => void load(), [load]) };
});
vi.mock('@/hooks/useProducts', () => ({
  useProducts: () => ({
    loading: false,
    products: [
      { id: 'p1', name: 'كريم اليدين', sku: 'K-1' },
      { id: 'p2', name: 'قميص', sku: 'S-2' },
    ],
  }),
}));

import { BLIND_AR, STATEMENT_CLAIM_AR, StockCountsScreen } from './StockCountsScreen';
import { findRoute, NAV } from '@/lib/route-registry';
import { GUIDE_TEXTS } from '@/lib/route-guide-texts';
import { GUIDED_PATHS } from '@/lib/route-guide';

type T = Record<string, unknown>;
const W = [{ id: 'wA', name: 'مخزن الشمال' }];

const item = (over: T = {}): T => ({
  id: 'k1',
  warehouseId: 'wA',
  warehouseName: 'مخزن الشمال',
  status: 'OPEN',
  statusAr: 'عم ينعدّ',
  scope: 'ALL',
  note: null,
  openedById: 'u-other',
  openedByName: 'رنا',
  openedAt: '2026-11-21T08:00:00.000Z',
  submittedByName: null,
  submittedAt: null,
  decidedByName: null,
  decidedAt: null,
  voidReason: null,
  lineCount: 2,
  ...over,
});

/** A sheet as the door answers the KEEPER: no book field anywhere. */
const blindSheet = (over: T = {}): T => ({
  id: 'k1',
  warehouseId: 'wA',
  warehouseName: 'مخزن الشمال',
  status: 'OPEN',
  statusAr: 'عم ينعدّ',
  scope: 'ALL',
  note: null,
  openedById: 'u-other',
  openedAt: '2026-11-21T08:00:00.000Z',
  submittedAt: null,
  decidedAt: null,
  voidReason: null,
  youCounted: false,
  lines: [
    { productId: 'p1', productName: 'كريم اليدين', sku: 'K-1', counted: null, countedById: null, countedAt: null, combinations: [] },
    {
      productId: 'p2', productName: 'قميص', sku: 'S-2', counted: null, countedById: null, countedAt: null,
      combinations: [
        { variantId: 'v-s', label: 'صغير' },
        { variantId: 'v-l', label: 'كبير' },
      ],
    },
  ],
  ...over,
});

/** A submitted sheet as the door answers the APPROVER: the server's expected and difference (no value before approval). */
const bookSheet = (over: T = {}, cost = false): T => ({
  ...blindSheet({ status: 'SUBMITTED', statusAr: 'مستني اعتماد', submittedAt: '2026-11-21T10:00:00.000Z' }),
  lines: [
    {
      productId: 'p1', productName: 'كريم اليدين', sku: 'K-1', counted: 41, book: 40, withCourier: 3, expected: 37, difference: 4, applied: null,
      unsourcedWithCourier: 2, combinations: [], ...(cost ? { valueAtCost: null } : {}),
    },
  ],
  ...over,
});

let list: { warehouses: T[]; counts: T[] };
let sheet: T;
let statement: T;
let onWrite: (url: string, body: T | null, method: string) => unknown;
const writes = () =>
  api.mock.calls
    .filter(([, init]) => ['POST', 'PATCH'].includes((init as RequestInit | undefined)?.method ?? ''))
    .map(([u, init]) => [u, (init as RequestInit).method, (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : null] as [string, string, T | null]);

const as = (...keys: string[]) => {
  user.current = { ...user.current, permissions: ['inventory.view', ...keys] };
};

const statementAnswer = (seesCost: boolean): T => ({
  warehouseId: 'wA',
  warehouseName: 'مخزن الشمال',
  keepers: ['رنا'],
  period: '90',
  periodAr: 'آخر 90 يوم',
  fromDay: '2026-08-24',
  timeZone: 'Asia/Amman',
  truncated: false,
  seesCost,
  sheets: [{ countId: 'k2', day: '2026-11-15', submittedAt: '', decidedAt: '', countedByName: 'رنا', approvedByName: 'منى', lines: 1, surplus: 0, shortfall: 1, ...(seesCost ? { valueAtCost: -2.5 } : {}) }],
  rows: [
    {
      countId: 'k2', day: '2026-11-15', productId: 'p1', productName: 'كريم اليدين', opening: 41, openingDay: '2026-11-01', net: 10,
      expected: 51, counted: 50, difference: -1, unsourcedWithCourier: 0, ...(seesCost ? { valueAtCost: -2.5 } : {}),
    },
  ],
  total: { sheets: 1, surplus: 0, shortfall: 1, ...(seesCost ? { valueAtCost: -2.5 } : {}) },
});

beforeEach(() => {
  api.mockReset();
  as();
  list = { warehouses: W, counts: [item()] };
  sheet = blindSheet();
  statement = statementAnswer(true);
  onWrite = () => ({ count: { id: 'k1' }, replay: false });
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') return onWrite(url, init.body ? JSON.parse(init.body as string) : null, init.method);
    if (url === '/api/inventory/counts') return list;
    if (url.startsWith('/api/inventory/counts/statement')) return statement;
    if (url.startsWith('/api/inventory/counts/')) return { count: sheet };
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => cleanup());

const mount = async () => {
  render(<StockCountsScreen />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/inventory/counts'));
};
const btn = (name: string, root: HTMLElement = document.body) => within(root).queryAllByRole('button', { name })[0] ?? null;
const openSheet = async () => {
  await mount();
  fireEvent.click((await screen.findAllByRole('button', { name: 'افتح الورقة' }))[0]);
  return (await screen.findByRole('dialog')) as HTMLElement;
};

describe('BLIND: the keeper counting is shown no book figure', () => {
  it('the sentence, one box per line and per combination — no shelf hint, no figure of the book', async () => {
    as('inventory.count');
    const d = await openSheet();
    expect(await within(d).findByText(BLIND_AR)).toBeTruthy();
    expect(within(d).getByLabelText('عدد «كريم اليدين»')).toBeTruthy();
    expect(within(d).getByLabelText('عدد «صغير» بالسطر 2')).toBeTruthy();
    expect(within(d).getByLabelText('عدد «كبير» بالسطر 2')).toBeTruthy();
    // (the keeper's own sentence names «الفرق» as somebody else's to see — it is left out of the search)
    expect((d.textContent ?? '').replace(BLIND_AR, '')).not.toMatch(/على الرف|المفروض|الفرق|بالكلفة|مع شركة الشحن/);
    expect(d.querySelectorAll('[data-variant]')).toHaveLength(0);
  });

  it('NEGATIVE: no other door is asked for the combinations (the products door answers the shelf)', async () => {
    as('inventory.count');
    await openSheet();
    await screen.findByText(BLIND_AR);
    expect(api.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/variants'))).toEqual([]);
  });

  it('NEGATIVE (source): the screen never subtracts an expected figure and never imports the shelf hint', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/StockCountsScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/counted\s*-\s*|-\s*[\w.?]*expected|expected\s*-/);
    expect(src).not.toMatch(/shelfHint|useProductCombinations/);
  });
});

describe('the count: save and submit', () => {
  it('«احفظ العدّ» sends the typed lines, combinations as typed with zeros; a blank line is not sent', async () => {
    as('inventory.count');
    const d = await openSheet();
    fireEvent.change(await within(d).findByLabelText('عدد «قميص»'), { target: { value: '3' } });
    fireEvent.change(within(d).getByLabelText('عدد «صغير» بالسطر 2'), { target: { value: '3' } });
    fireEvent.change(within(d).getByLabelText('عدد «كبير» بالسطر 2'), { target: { value: '0' } });
    fireEvent.click(btn('احفظ العدّ', d)!);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      '/api/inventory/counts/k1',
      'PATCH',
      { lines: [{ productId: 'p2', counted: 3, variants: [{ variantId: 'v-s', quantity: 3 }, { variantId: 'v-l', quantity: 0 }] }] },
    ]);
  });

  it('«سلّم الجرد» saves what is typed, then submits', async () => {
    as('inventory.count');
    const d = await openSheet();
    fireEvent.change(await within(d).findByLabelText('عدد «كريم اليدين»'), { target: { value: '41' } });
    fireEvent.click(btn('سلّم الجرد', d)!);
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes().map(([u, m]) => [u, m])).toEqual([
      ['/api/inventory/counts/k1', 'PATCH'],
      ['/api/inventory/counts/k1/submit', 'POST'],
    ]);
    expect(writes()[0][2]).toEqual({ lines: [{ productId: 'p1', counted: 41 }] });
  });

  it('NEGATIVE: a box that is not a whole number holds the presses', async () => {
    as('inventory.count');
    const d = await openSheet();
    fireEvent.change(await within(d).findByLabelText('عدد «كريم اليدين»'), { target: { value: '4.5' } });
    expect((btn('احفظ العدّ', d) as HTMLButtonElement).disabled).toBe(true);
    expect((btn('سلّم الجرد', d) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the door’s refusal is printed as it came', async () => {
    as('inventory.count');
    const sentence = 'لسا في منتجات ما انعدّت. اكتب العدد لكل سطر (ولو صفر) وبعدين سلّم.';
    onWrite = () => {
      throw new Error(sentence);
    };
    const d = await openSheet();
    fireEvent.change(await within(d).findByLabelText('عدد «كريم اليدين»'), { target: { value: '41' } });
    fireEvent.click(btn('سلّم الجرد', d)!);
    expect(await within(d).findByText(sentence)).toBeTruthy();
  });
});

describe('the approval view and its two hands', () => {
  it('expected · counted · difference — the server’s figures, printed as sent (a difference of 7 is 7, not 41 − 37)', async () => {
    as('inventory.count_approve');
    sheet = bookSheet({ lines: [{ ...(bookSheet().lines as T[])[0], difference: 7 }] });
    const d = await openSheet();
    const t = within((await waitFor(() => d.querySelector('table') ?? Promise.reject(new Error('no table')))) as HTMLElement);
    const row = t.getByText('كريم اليدين').closest('tr')!;
    expect(row.textContent).toMatch(/37/);
    expect(row.textContent).toMatch(/41/);
    expect(row.textContent).toMatch(/\+7/);
    expect(row.textContent).not.toMatch(/\+4/);
    // The units with the courier that name no warehouse are said beside the product.
    expect(row.textContent).toMatch(/بلا مخزن مكتوب/);
    // No cost key: no value column.
    expect(t.queryByText('القيمة بالكلفة')).toBeNull();
    expect(btn('اعتمد الجرد', d)).toBeTruthy();
  });

  it('«اعتمد الجرد» posts the approval door', async () => {
    as('inventory.count_approve');
    sheet = bookSheet();
    const d = await openSheet();
    fireEvent.click(await within(d).findByRole('button', { name: 'اعتمد الجرد' }));
    await waitFor(() => expect(writes()).toEqual([['/api/inventory/counts/k1/approve', 'POST', null]]));
  });

  it('NEGATIVE — TWO HANDS: whoever had a hand in the count gets a sentence, never the press', async () => {
    as('inventory.count', 'inventory.count_approve');
    sheet = bookSheet({ youCounted: true });
    const d = await openSheet();
    expect(await within(d).findByText(/بيعتمده حدا غيرك/)).toBeTruthy();
    expect(btn('اعتمد الجرد', d)).toBeNull();
  });

  it('a cost holder: «بتنحسب عند الاعتماد» before, the value after', async () => {
    as('inventory.count_approve', 'costs.view');
    sheet = bookSheet({}, true);
    let d = await openSheet();
    expect(await within(d).findAllByText('بتنحسب عند الاعتماد')).toBeTruthy();
    cleanup();
    sheet = bookSheet({ status: 'APPROVED', statusAr: 'معتمد', lines: [{ ...(bookSheet({}, true).lines as T[])[0], applied: 4, valueAtCost: 10 }] }, true);
    d = await openSheet();
    await within(d).findAllByText('القيمة بالكلفة');
    expect(d.textContent).toMatch(/10/);
    expect(btn('اعتمد الجرد', d)).toBeNull();
  });

  it('a viewer sees what was counted, and no press', async () => {
    sheet = blindSheet({ status: 'SUBMITTED', statusAr: 'مستني اعتماد', lines: [{ ...(blindSheet().lines as T[])[0], counted: 41 }] });
    const d = await openSheet();
    await within(d).findAllByText('انعدّ');
    expect(d.textContent).toMatch(/41/);
    for (const name of ['احفظ العدّ', 'سلّم الجرد', 'اعتمد الجرد', 'ألغي الورقة']) expect(btn(name, d), name).toBeNull();
  });

  it('void asks a reason, then posts it', async () => {
    as('inventory.count_approve');
    sheet = bookSheet();
    const d = await openSheet();
    fireEvent.click(await within(d).findByRole('button', { name: 'ألغي الورقة' }));
    const dialogs = await screen.findAllByRole('dialog');
    const v = dialogs[dialogs.length - 1] as HTMLElement;
    const press = within(v).getByRole('button', { name: 'ألغي الورقة' }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    fireEvent.change(within(v).getByLabelText('سبب الإلغاء *'), { target: { value: 'انفتحت بالغلط' } });
    fireEvent.click(press);
    await waitFor(() => expect(writes()).toEqual([['/api/inventory/counts/k1/void', 'POST', { reason: 'انفتحت بالغلط' }]]));
  });
});

describe('opening a sheet', () => {
  it('chosen products go out as `productIds`; all products send none', async () => {
    as('inventory.count');
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'ورقة جرد جديدة' }));
    const d = (await screen.findByRole('dialog')) as HTMLElement;
    fireEvent.click(within(d).getByRole('radio', { name: 'منتجات مختارة' }));
    await userEvent.click(within(d).getByPlaceholderText(/ابحث/));
    await userEvent.click(within(d).getByText('قميص'));
    fireEvent.click(within(d).getByRole('button', { name: 'افتح الورقة' }));
    await waitFor(() => expect(writes()[0]).toEqual(['/api/inventory/counts', 'POST', { warehouseId: 'wA', note: null, productIds: ['p2'] }]));
  });

  it('NEGATIVE: without the count key there is no «ورقة جرد جديدة»; with no warehouse neither', async () => {
    await mount();
    await screen.findAllByRole('button', { name: 'افتح الورقة' });
    expect(btn('ورقة جرد جديدة')).toBeNull();
    cleanup();
    as('inventory.count');
    list = { warehouses: [], counts: [] };
    await mount();
    expect(await screen.findByText('ما في أوراق جرد لسا')).toBeTruthy();
    expect(btn('ورقة جرد جديدة')).toBeNull();
  });
});

describe('«كشف عهدة الأمين»', () => {
  it('NEGATIVE: not offered without the approver’s key (it is all book figures)', async () => {
    as('inventory.count');
    await mount();
    expect(screen.queryByRole('radio', { name: 'كشف عهدة الأمين' })).toBeNull();
  });

  it('prints the server’s rows: opening, net, expected, counted, difference — and the value for a cost holder', async () => {
    as('inventory.count_approve', 'costs.view');
    await mount();
    fireEvent.click(screen.getByRole('radio', { name: 'كشف عهدة الأمين' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/inventory/counts/statement?warehouseId=wA&period=90'));
    expect(await screen.findByText(STATEMENT_CLAIM_AR)).toBeTruthy();
    expect(screen.getByText(/الأمين: رنا/)).toBeTruthy();
    const tables = document.querySelectorAll('table');
    const rows = within(tables[tables.length - 1] as HTMLElement);
    const tr = rows.getByText('كريم اليدين').closest('tr')!;
    for (const x of ['41', '+10', '51', '50', '-1']) expect(tr.textContent, x).toContain(x);
    expect(rows.getByText('بالكلفة')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'الكل' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/inventory/counts/statement?warehouseId=wA&period=all'));
  });

  it('NEGATIVE: without the cost key no value column', async () => {
    as('inventory.count_approve');
    statement = statementAnswer(false);
    await mount();
    fireEvent.click(screen.getByRole('radio', { name: 'كشف عهدة الأمين' }));
    await screen.findByText(STATEMENT_CLAIM_AR);
    expect(screen.queryByText('بالكلفة')).toBeNull();
    expect(screen.queryByText('الفرق بالكلفة')).toBeNull();
  });
});

describe('the page is on the menu and guided', () => {
  it('registered under the inventory tabs on `inventory.view`, with its guide', () => {
    expect(findRoute('/inventory/counts')).toMatchObject({ label: 'الجرد', permissions: ['inventory.view'] });
    expect(NAV.find((g) => g.routes.some((r) => r.path === '/inventory/exits'))!.routes.map((r) => r.path)).toContain('/inventory/counts');
    expect(GUIDED_PATHS).toContain('/inventory/counts');
    expect(GUIDE_TEXTS['/inventory/counts'].steps.length).toBeGreaterThan(2);
    const inv = NAV.find((g) => g.key === 'inventory')!;
    expect(inv.routes.at(-1)!.path).toBe('/inventory/counts');
    const page = readFileSync(join(process.cwd(), 'src/app/(system)/(shell)/inventory/counts/page.tsx'), 'utf8');
    expect(page).toContain("guardRoute('/inventory/counts')");
  });

  it('a column as wide as the phone: no fixed width, no horizontal scroll, no nowrap of its own', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/StockCountsScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/\bw-\[\d|min-w-\[|overflow-x|whitespace-nowrap|text-xs/);
  });

});
