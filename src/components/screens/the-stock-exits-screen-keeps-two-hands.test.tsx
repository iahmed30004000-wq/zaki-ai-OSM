// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «إخراج بضاعة» (warehouse plan W6b) — the screen of W6a's three doors and of the month's table.
 *
 * DEFINITION OF DONE it pins:
 *  1. Every state of an exit is drawn with its word: waiting for approval, out, rejected (with its reason); the empty list,
 *     the load failure, a store with no warehouse.
 *  2. TWO HANDS, VISIBLE: the person who asked never gets «اعتمد» / «ارفض» on her own request — the row says somebody else
 *     decides; a holder of the decision key sees both on anybody else's pending request; a viewer sees no press.
 *  3. The request: warehouse, reason, lines; «أخرى» needs a sentence before the press opens; the door gets a client-made id,
 *     and a retry after a refusal carries the SAME id. Approve and reject post to their doors; reject asks a reason.
 *  4. The month's table prints only what the server sent: the value at cost for a cost holder, «بلا كلفة» for an uncosted line
 *     (never 0), no money column at all without the cost key; the sentence that an exit is not a sale.
 *  5. Every refusal is the door's Arabic sentence, printed as it came.
 *  6. The ledger screen names the exit movement types.
 */

const { api, user } = vi.hoisted(() => ({
  api: vi.fn(),
  user: { current: { id: 'u-me', name: 'سارة', role: 'CUSTOM', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar', currentUser: user.current }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/inventory/exits', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenGuide', () => ({ GuideButton: () => null }));
vi.mock('@/hooks/useLiveRefresh', async () => {
  const R = await import('react');
  return { useLiveRefresh: (load: () => unknown) => R.useEffect(() => void load(), []) };
});
vi.mock('@/hooks/useProducts', () => ({
  useProducts: () => ({
    loading: false,
    products: [
      { id: 'p1', name: 'كريم اليدين', sku: 'K-1' },
      { id: 'p2', name: 'صابون الزيت', sku: 'S-2' },
    ],
  }),
}));

import { NOT_SALES_AR, StockExitsScreen } from './StockExitsScreen';
import { findRoute, NAV } from '@/lib/route-registry';
import { GUIDE_TEXTS } from '@/lib/route-guide-texts';
import { GUIDED_PATHS } from '@/lib/route-guide';
import { EXIT_REASON_AR, EXIT_REASONS } from '@/lib/stock-exit-reasons';

type T = Record<string, unknown>;
const W = [{ id: 'wA', name: 'مخزن الشمال' }];
const REASONS = EXIT_REASONS.map((r) => ({ reason: r, ar: EXIT_REASON_AR[r] }));

const exit = (over: T = {}): T => ({
  id: 'x1',
  warehouseId: 'wA',
  warehouseName: 'مخزن الشمال',
  reason: 'EXPIRED',
  reasonAr: 'منتهي',
  note: null,
  status: 'PENDING',
  statusAr: 'مستني اعتماد',
  requestedById: 'u-other',
  requestedByName: 'رنا',
  requestedAt: '2026-11-20T08:00:00.000Z',
  decidedById: null,
  decidedByName: null,
  decidedAt: null,
  rejectReason: null,
  lines: [{ productId: 'p1', productName: 'كريم اليدين', quantity: 4 }],
  ...over,
});

const monthAnswer = (seesCost: boolean): T => ({
  month: '2026-11',
  monthAr: 'تشرين الثاني 2026',
  current: true,
  prev: '2026-10',
  next: null,
  truncated: false,
  exits: 2,
  seesCost,
  lines: [
    {
      exitId: 'x1', decidedAt: '2026-11-05T08:00:00.000Z', warehouseName: 'مخزن الشمال', reason: 'EXPIRED', reasonAr: 'منتهي', note: null,
      productId: 'p1', productName: 'كريم اليدين', quantity: 4, requestedByName: 'رنا', decidedByName: 'منى',
      ...(seesCost ? { valueAtCost: 4.494, uncosted: false } : {}),
    },
    {
      exitId: 'x2', decidedAt: '2026-11-06T08:00:00.000Z', warehouseName: 'مخزن الشمال', reason: 'SAMPLES', reasonAr: 'عيّنات وهدايا', note: 'معرض',
      productId: 'p2', productName: 'صابون الزيت', quantity: 3, requestedByName: 'رنا', decidedByName: 'منى',
      ...(seesCost ? { valueAtCost: null, uncosted: true } : {}),
    },
  ],
  reasons: [
    { reason: 'EXPIRED', reasonAr: 'منتهي', quantity: 4, lines: 1, ...(seesCost ? { valueAtCost: 4.494, uncostedLines: 0 } : {}) },
    { reason: 'SAMPLES', reasonAr: 'عيّنات وهدايا', quantity: 3, lines: 1, ...(seesCost ? { valueAtCost: 0, uncostedLines: 1 } : {}) },
  ],
  total: { quantity: 7, lines: 2, ...(seesCost ? { valueAtCost: 4.494, uncostedLines: 1 } : {}) },
});

let list: { warehouses: T[]; reasons: T[]; exits: T[] };
let month: T;
let onPost: (url: string, body: T | null) => unknown;
const posts = () =>
  api.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([u, init]) => [u, (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : null] as [string, T | null]);

const as = (...keys: string[]) => {
  user.current = { ...user.current, permissions: ['inventory.view', ...keys] };
};

beforeEach(() => {
  api.mockReset();
  as();
  list = { warehouses: W, reasons: REASONS, exits: [exit()] };
  month = monthAnswer(true);
  onPost = () => ({ exit: {}, replay: false });
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return onPost(url, init.body ? JSON.parse(init.body as string) : null);
    if (url === '/api/inventory/exits') return list;
    if (url.startsWith('/api/inventory/exits/month')) return month;
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => cleanup());

const mount = async () => {
  render(<StockExitsScreen />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/inventory/exits'));
};
const refuse = (sentence: string) => () => {
  throw new Error(sentence);
};
const btn = (name: string) => screen.queryAllByRole('button', { name })[0] ?? null;
/** The kit's `Rows` draws a list twice (a table on a desk, cards on a phone): questions are asked of the first table. */
const table = async (n = 0) =>
  within(
    (await waitFor(() => {
      const t = document.querySelectorAll('table')[n];
      if (!t) throw new Error('no table');
      return t;
    })) as HTMLElement
  );
const toMonth = async () => {
  fireEvent.click(screen.getByRole('radio', { name: 'تقرير الشهر' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/inventory/exits/month'));
};

describe('the list: every state with its word', () => {
  it('waiting · out · rejected — each with its chip, its people and its reason', async () => {
    list.exits = [
      exit({ id: 'a' }),
      exit({ id: 'b', status: 'APPROVED', statusAr: 'طلع', decidedById: 'u-x', decidedByName: 'منى', decidedAt: '2026-11-20T09:00:00.000Z' }),
      exit({ id: 'c', status: 'REJECTED', statusAr: 'مرفوض', decidedById: 'u-x', decidedByName: 'منى', rejectReason: 'العدّ غلط', reason: 'OTHER', reasonAr: 'أخرى', note: 'كسر بالرف' }),
    ];
    await mount();
    const t = await table();
    expect(t.getByText('مستني اعتماد')).toBeTruthy();
    expect(t.getByText('طلع')).toBeTruthy();
    expect(t.getByText('مرفوض')).toBeTruthy();
    expect(t.getByText('السبب: العدّ غلط')).toBeTruthy();
    expect(t.getByText('اعتمده: منى')).toBeTruthy();
    expect(t.getByText('رفضه: منى')).toBeTruthy();
    expect(t.getByText('كسر بالرف')).toBeTruthy();
    expect(t.getAllByText('مخزن الشمال').length).toBe(3);
  });

  it('the status filter counts from the list', async () => {
    list.exits = [exit({ id: 'a' }), exit({ id: 'b', status: 'APPROVED', statusAr: 'طلع' })];
    await mount();
    await table();
    fireEvent.click(screen.getByRole('radio', { name: /طلع/ }));
    const t = await table();
    expect(t.queryByText('مستني اعتماد')).toBeNull();
    expect(t.getByText('طلع')).toBeTruthy();
  });

  it('an empty list, a load failure, and a store with no warehouse each say so', async () => {
    list = { warehouses: [], reasons: REASONS, exits: [] };
    as('inventory.exit');
    await mount();
    expect(await screen.findByText('ما في طلبات إخراج لسا')).toBeTruthy();
    expect(screen.getByText(/المخازن بتنعرّف من «البلدان والمدن»/)).toBeTruthy();
    // No warehouse: no request to open.
    expect(btn('طلب إخراج')).toBeNull();
    cleanup();
    api.mockImplementation(async () => {
      throw new Error('ما إلك صلاحية');
    });
    render(<StockExitsScreen />);
    expect(await screen.findByText('ما إلك صلاحية')).toBeTruthy();
  });
});

describe('two hands, visible', () => {
  it('NEGATIVE: the requester never gets «اعتمد» or «ارفض» on her own request — even holding both keys', async () => {
    as('inventory.exit', 'inventory.exit_approve');
    list.exits = [exit({ requestedById: 'u-me', requestedByName: 'سارة' })];
    await mount();
    const t = await table();
    expect(t.getByText('بيعتمده حدا غيرك')).toBeTruthy();
    expect(t.queryByRole('button', { name: 'اعتمد' })).toBeNull();
    expect(t.queryByRole('button', { name: 'ارفض' })).toBeNull();
  });

  it('a holder of the decision key gets both on somebody else’s pending request, and nothing on a decided one', async () => {
    as('inventory.exit_approve');
    list.exits = [exit({ id: 'a' }), exit({ id: 'b', status: 'APPROVED', statusAr: 'طلع' })];
    await mount();
    const t = await table();
    expect(t.getAllByRole('button', { name: 'اعتمد' })).toHaveLength(1);
    expect(t.getAllByRole('button', { name: 'ارفض' })).toHaveLength(1);
  });

  it('NEGATIVE: a viewer (inventory.view only) sees the list and no press at all; the request key alone gives the request only', async () => {
    await mount();
    const t = await table();
    expect(t.queryByRole('button')).toBeNull();
    expect(btn('طلب إخراج')).toBeNull();
    cleanup();
    as('inventory.exit');
    await mount();
    expect(btn('طلب إخراج')).toBeTruthy();
    expect((await table()).queryByRole('button', { name: 'اعتمد' })).toBeNull();
  });

  it('approve posts to its door with no body; a refusal is the door’s sentence', async () => {
    as('inventory.exit_approve');
    await mount();
    fireEvent.click((await table()).getByRole('button', { name: 'اعتمد' }));
    const dialog = await screen.findByRole('dialog');
    const short = 'المخزن ما فيه هالكمية هلق. ارفض الطلب، أو استنى لحد ما تتصحّح الكمية.';
    onPost = refuse(short);
    fireEvent.click(within(dialog).getByRole('button', { name: 'اعتمد الإخراج' }));
    expect(await within(dialog).findByText(short)).toBeTruthy();
    onPost = () => ({ exit: {}, replay: false });
    fireEvent.click(within(dialog).getByRole('button', { name: 'اعتمد الإخراج' }));
    expect(await screen.findByText('انعتمد الإخراج — البضاعة طلعت من المخزن.')).toBeTruthy();
    expect(posts().map(([u]) => u)).toEqual(['/api/inventory/exits/x1/approve', '/api/inventory/exits/x1/approve']);
    expect(posts()[1][1]).toBeNull();
  });

  it('reject asks a reason before its press opens, and posts it', async () => {
    as('inventory.exit_approve');
    await mount();
    fireEvent.click((await table()).getByRole('button', { name: 'ارفض' }));
    const dialog = await screen.findByRole('dialog');
    const press = within(dialog).getByRole('button', { name: 'ارفض الإخراج' }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('سبب الرفض *'), { target: { value: 'العدّ غلط' } });
    expect(press.disabled).toBe(false);
    fireEvent.click(press);
    expect(await screen.findByText('انرفض الإخراج — البضاعة رجعت حرّة بمخزنها.')).toBeTruthy();
    expect(posts()).toEqual([['/api/inventory/exits/x1/reject', { reason: 'العدّ غلط' }]]);
  });
});

describe('the request', () => {
  const openForm = async () => {
    as('inventory.exit');
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'طلب إخراج' }));
    return screen.findByRole('dialog');
  };

  it('warehouse, reason and a line open it; «أخرى» needs a sentence; a refusal is printed and the retry carries the same id', async () => {
    const dialog = await openForm();
    const press = within(dialog).getByRole('button', { name: 'اطلب' }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    // The only warehouse is chosen already.
    expect(within(dialog).getByRole('radio', { name: 'مخزن الشمال' }).getAttribute('aria-checked')).toBe('true');
    // Every reason of the closed list is offered, in its own word.
    const select = within(dialog).getByLabelText('سبب الإخراج') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text).slice(1)).toEqual(EXIT_REASONS.map((r) => EXIT_REASON_AR[r]));
    await userEvent.click(within(dialog).getByPlaceholderText(/ابحث/));
    await userEvent.click(within(dialog).getByText('صابون الزيت'));
    const qty = within(dialog).getByLabelText('كمية السطر 1');
    fireEvent.change(qty, { target: { value: '0' } });
    expect(within(dialog).getByText('الكمية لازم تكون رقم صحيح أكبر من صفر.')).toBeTruthy();
    fireEvent.change(qty, { target: { value: '3' } });
    fireEvent.change(select, { target: { value: 'OTHER' } });
    // NEGATIVE: «أخرى» without a sentence keeps the press shut.
    expect(press.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('ليش طالعة البضاعة؟ *'), { target: { value: 'انكسرت بالنقل' } });
    expect(press.disabled).toBe(false);
    const short = 'ما في كفاية بالبضاعة الحرّة بهالمخزن.';
    onPost = refuse(short);
    fireEvent.click(press);
    expect(await within(dialog).findByText(short)).toBeTruthy();
    onPost = () => ({ exit: {}, replay: false });
    fireEvent.click(press);
    expect(await screen.findByText('انطلب الإخراج — البضاعة موقوفة لحد ما حدا تاني يعتمد.')).toBeTruthy();
    const [first, second] = posts();
    expect(first[0]).toBe('/api/inventory/exits');
    expect(first[1]).toMatchObject({ warehouseId: 'wA', reason: 'OTHER', note: 'انكسرت بالنقل', lines: [{ productId: 'p2', quantity: 3 }] });
    expect(String(first[1]!.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second[1]!.id).toBe(first[1]!.id);
  });

  it('the door’s other refusals are printed as they came', async () => {
    for (const sentence of [
      'هالمتجر لسا ما توزّع على المخازن. وزّع الرصيد على المخازن أول، وبعدين اطلب إخراج.',
      'نفس المنتج مكتوب بسطرين. اجمعهم بسطر واحد.',
      'هالمخزن موقوف. ما بينطلب منه إخراج.',
      'ما إلك وصول على هالمخزن.',
    ]) {
      const dialog = await openForm();
      fireEvent.change(within(dialog).getByLabelText('سبب الإخراج'), { target: { value: 'DAMAGED' } });
      await userEvent.click(within(dialog).getByPlaceholderText(/ابحث/));
      await userEvent.click(within(dialog).getByText('كريم اليدين'));
      fireEvent.change(within(dialog).getByLabelText('كمية السطر 1'), { target: { value: '1' } });
      onPost = refuse(sentence);
      fireEvent.click(within(dialog).getByRole('button', { name: 'اطلب' }));
      expect(await within(dialog).findByText(sentence)).toBeTruthy();
      cleanup();
      api.mockClear();
    }
  });
});

describe('the month’s table prints only what the server sent', () => {
  it('for a cost holder: the value, «بلا كلفة» for the uncosted line (never 0), the sums and the sentence that this is not a sale', async () => {
    await mount();
    await toMonth();
    expect(await screen.findByText('تشرين الثاني 2026')).toBeTruthy();
    expect(screen.getByText(NOT_SALES_AR)).toBeTruthy();
    expect(NOT_SALES_AR).toMatch(/مش مبيعات/);
    expect(screen.getByText('قيمتها بالكلفة')).toBeTruthy();
    expect(screen.getByText('و1 سطر بلا كلفة')).toBeTruthy();
    const lines = await table(1);
    expect(lines.getByText('بلا كلفة')).toBeTruthy();
    // Drawn by the kit's `Money` (the store's digits; bare in a test with no shell).
    expect(lines.getByText('كريم اليدين', { exact: false }).closest('tr')!.textContent).toMatch(/4\.49/);
    // The uncosted line's row carries no zero figure.
    const row = lines.getByText('صابون الزيت', { exact: false }).closest('tr')!;
    expect(row.textContent).not.toMatch(/\b0([.,]0+)?\b/);
    expect(lines.getAllByText('اعتمده: منى').length).toBe(2);
  });

  it('NEGATIVE: without the cost key there is no money column, no value tile and no «بلا كلفة» — quantities only', async () => {
    month = monthAnswer(false);
    await mount();
    await toMonth();
    expect(await screen.findByText('تشرين الثاني 2026')).toBeTruthy();
    expect(screen.queryByText('قيمتها بالكلفة')).toBeNull();
    expect(screen.queryByText('القيمة بالكلفة')).toBeNull();
    expect(screen.queryByText(/بلا كلفة/)).toBeNull();
    expect(screen.getByText(NOT_SALES_AR)).toBeTruthy();
  });

  it('the arrows ask the server for the month it named; the next arrow is shut on this month', async () => {
    await mount();
    await toMonth();
    await screen.findByText('تشرين الثاني 2026');
    expect((screen.getByRole('button', { name: 'الشهر اللي بعده' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'الشهر اللي قبله' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/inventory/exits/month?month=2026-10'));
  });

  it('a refused month is the door’s sentence', async () => {
    api.mockImplementation(async (url: string) => {
      if (url === '/api/inventory/exits') return list;
      throw new Error('الشهر غير صالح.');
    });
    await mount();
    await toMonth();
    expect(await screen.findByText('الشهر غير صالح.')).toBeTruthy();
  });

  it('this file does no arithmetic on a figure: no sum, no reduce, no rounding', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/StockExitsScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/\.reduce\(|toFixed\(|Math\.round|roundMinor|\+=/);
  });
});

describe('the movements tab names the exit types (20/11, W6b)', () => {
  it('every EXIT_ type of an approved exit is «إخراج — <its reason>», and the damaged stays «تالف»', async () => {
    const types = ['EXIT_EXPIRED', 'EXIT_SAMPLES', 'EXIT_SUPPLIER_RETURN', 'EXIT_OFF_SYSTEM_SALE', 'EXIT_PARTNER_DRAW', 'EXIT_OTHER', 'DAMAGE'];
    api.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/inventory/movements')) {
        return {
          movements: types.map((type, i) => ({
            id: `m${i}`, type, quantity: -1, balanceAfter: 10, reason: null, createdAt: '2026-11-20T08:00:00.000Z',
            product: { id: 'p1', name: 'كريم اليدين', sku: null }, batchNumber: null, createdByName: 'منى',
          })),
          types: types.map((type) => ({ type, count: 1 })),
          hasMore: false,
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    const { InventoryMovementsScreen } = await import('./InventoryMovementsScreen');
    render(<InventoryMovementsScreen />);
    const t = await table();
    for (const words of ['إخراج — منتهي', 'إخراج — عيّنات وهدايا', 'إخراج — مرتجع للمورّد', 'إخراج — بيع برّا النظام', 'إخراج — سحب شريك', 'إخراج — أخرى', 'تالف']) {
      expect(t.getByText(words), words).toBeTruthy();
    }
    expect(t.queryByText(/^EXIT_/)).toBeNull();
  });
});

describe('the page and its place', () => {
  it('the last tab of «المخزون والمنتجات» on inventory.view, guarded, with its guide', () => {
    expect(findRoute('/inventory/exits')).toMatchObject({ label: 'إخراج بضاعة', permissions: ['inventory.view'] });
    const inv = NAV.find((g) => g.key === 'inventory')!;
    // 21/11 (W5b): was `inv.routes.at(-1)` — «الجرد» (`/inventory/counts`) is the last tab now, right after this one.
    expect(inv.routes.map((r) => r.path).slice(-2)).toEqual(['/inventory/exits', '/inventory/counts']);
    expect(GUIDED_PATHS).toContain('/inventory/exits');
    expect(GUIDE_TEXTS['/inventory/exits']?.steps.join(' ')).toContain('اعتمد');
    const page = readFileSync(join(process.cwd(), 'src/app/(system)/(shell)/inventory/exits/page.tsx'), 'utf8');
    expect(page).toContain("guardRoute('/inventory/exits')");
  });

  it('a column as wide as the phone: no fixed width, no horizontal scroll, no nowrap of its own', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/StockExitsScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/\bw-\[\d|min-w-\[|overflow-x|whitespace-nowrap|text-xs/);
  });
});
