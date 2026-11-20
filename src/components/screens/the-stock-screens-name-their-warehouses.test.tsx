// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * THE STOCK SCREENS NAME THEIR WAREHOUSES — for a store placed in warehouses only (the warehouse plan, W2c).
 *
 *   «أرصدة المخزون»   per-warehouse chips on each card (and «بالطريق», «مع الشحن», «بلا مكان»), a warehouse filter, and
 *                     a receive dialog that asks which warehouse the goods landed in (the door refuses a placed store's
 *                     receipt without one: `WAREHOUSE_REQUIRED`).
 *   «حركات المخزون»   a warehouse column and a warehouse filter.
 *
 * Every number drawn is one the server sent — nothing here adds, subtracts or compares a figure. A store that is NOT placed
 * gets none of it: its screens are pinned unchanged by `the-stock-balances-wear-the-kit` and
 * `the-movements-screen-wears-the-kit`, and the NEGATIVE cases below say so again. Nothing behind the login can be opened in
 * a browser here (every account has a second factor only the owner completes), so this is the proof the screens get.
 */

const { api, phone } = vi.hoisted(() => ({ api: vi.fn(), phone: { value: false } }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/inventory/balances',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    t: { cancel: 'إلغاء' },
    locale: 'ar',
    currentUser: { id: 'u1', name: 'سارة', role: 'COMPANY_ADMIN', permissions: ['inventory.view', 'inventory.adjust'], status: 'ACTIVE' },
  }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => null }));

import { InventoryBalancesScreen } from './InventoryBalancesScreen';
import { InventoryMovementsScreen } from './InventoryMovementsScreen';
import { ReceiveDialog } from '@/components/inventory/ReceiveDialog';

const health = {
  tone: 'ok', label: 'متوفر', why: 'سبب مكتوب', state: 'healthy', available: 10, perDay: 2, coverDays: 5, windowDays: 13,
  score: 40, bands: [], needsRestock: false,
};
const WAREHOUSES = [
  { id: 'w-a', name: 'مخزن الشمال', mayReceive: true },
  { id: 'w-b', name: 'مخزن الجنوب', mayReceive: false },
];
const ROWS = [
  {
    id: 'A', name: 'منتج A', sku: 'SKU-A', sourceType: 'PURCHASED', produced: 20, sold: 8, remaining: 12, reserved: 2,
    lastUnitCost: 3, health,
    places: { warehouses: [{ id: 'w-a', onHand: 7 }, { id: 'w-b', onHand: 3 }], inTransit: 1, withCourier: 1 },
  },
  {
    id: 'B', name: 'منتج B', sku: 'SKU-B', sourceType: 'PURCHASED', produced: 9, sold: 0, remaining: 9, reserved: 0,
    lastUnitCost: 2, health,
    places: { warehouses: [{ id: 'w-b', onHand: 6 }], inTransit: 0, withCourier: 0, unplaced: 3 },
  },
];

const stubInventory = (body: Record<string, unknown>) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })));

beforeEach(() => {
  api.mockReset();
  phone.value = false;
  // The two banners ask their doors: no opening count to offer, the store already placed.
  api.mockImplementation(async (url: string) => {
    if (url === '/api/inventory/opening-count') return { count: null, movements: 1, countable: false, products: [] };
    if (url === '/api/inventory/placement') return { placed: true };
    return { ok: true };
  });
  stubInventory({ stockSummary: ROWS, alerts: [], ledgerDays: 13, warehouses: WAREHOUSES });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = (name: string) => screen.getByText(name).closest('div[class*="space-y-3"]') as HTMLElement;

describe('«أرصدة المخزون» of a placed store', () => {
  it('each card prints the server’s figures by place — named warehouses, the road, the courier, no place', async () => {
    render(<InventoryBalancesScreen />);
    await screen.findByText('منتج A');
    const a = within(card('منتج A'));
    expect(a.getByText('مخزن الشمال · 7')).toBeTruthy();
    expect(a.getByText('مخزن الجنوب · 3')).toBeTruthy();
    expect(a.getByText('بالطريق · 1')).toBeTruthy();
    expect(a.getByText('مع الشحن · 1')).toBeTruthy();
    expect(a.queryByText(/بلا مكان/)).toBeNull();
    const b = within(card('منتج B'));
    expect(b.getByText('مخزن الجنوب · 6')).toBeTruthy();
    expect(b.getByText('بلا مكان · 3')).toBeTruthy();
    // NEGATIVE: a zero is not drawn as a chip.
    expect(b.queryByText(/بالطريق/)).toBeNull();
    expect(b.queryByText(/مع الشحن/)).toBeNull();
    // The store figures are untouched: the shelf is the server's 12, not a sum of the chips.
    expect(a.getByText('12')).toBeTruthy();
  });

  it('the warehouse filter keeps the products the server lists in that warehouse, and «كل المخازن» brings all back', async () => {
    render(<InventoryBalancesScreen />);
    await screen.findByText('منتج A');
    const filter = screen.getByLabelText('المخزن') as HTMLSelectElement;
    expect([...filter.options].map((o) => o.textContent)).toEqual(['كل المخازن', 'مخزن الشمال', 'مخزن الجنوب']);
    fireEvent.change(filter, { target: { value: 'w-a' } });
    expect(screen.queryByText('منتج B')).toBeNull();
    expect(screen.getByText('منتج A')).toBeTruthy();
    expect(screen.getByText('مخزن الشمال · 7').className).toContain('ring-2');
    fireEvent.change(filter, { target: { value: 'all' } });
    expect(screen.getByText('منتج B')).toBeTruthy();
  });

  it('«استلام» asks for the warehouse, offers only the ones she may receive into, and sends it', async () => {
    render(<InventoryBalancesScreen />);
    await screen.findByText('منتج A');
    fireEvent.click(within(card('منتج A')).getByRole('button', { name: 'استلام' }));
    const pick = screen.getByLabelText('المخزن اللي دخلت عليه البضاعة') as HTMLSelectElement;
    // Only «مخزن الشمال» may be received into: one choice, chosen for her.
    expect([...pick.options].map((o) => o.textContent)).toEqual(['مخزن الشمال']);
    expect(pick.value).toBe('w-a');
    fireEvent.change(screen.getByLabelText('الكمية المستلمة'), { target: { value: '4' } });
    // The dialog's own press (the cards behind it carry «استلام» too).
    fireEvent.click(screen.getAllByRole('button', { name: 'استلام' }).find((b) => b.getAttribute('type') === 'submit')!);
    await waitFor(() => expect(api.mock.calls.some(([u, i]) => u === '/api/inventory' && (i as RequestInit)?.method === 'POST')).toBe(true));
    const post = api.mock.calls.find(([u, i]) => u === '/api/inventory' && (i as RequestInit)?.method === 'POST') as [string, RequestInit];
    expect(JSON.parse(post[1].body as string)).toEqual({
      action: 'receive', productId: 'A', quantity: 4, zeroCostReason: null, note: null, warehouseId: 'w-a',
    });
  });

  it('at 375px nothing is wider than the phone', async () => {
    phone.value = true;
    render(<InventoryBalancesScreen />);
    await screen.findByText('منتج A');
    const tokens = [...document.body.querySelectorAll('[class]')].flatMap((e) => (e.getAttribute('class') ?? '').split(/\s+/));
    expect(tokens.filter((t) => /^(min-w|w)-\[(\d+)px\]$/.test(t) && Number(/\d+/.exec(t)![0]) > 375)).toEqual([]);
    expect(tokens).not.toContain('whitespace-nowrap');
  });

  it('NEGATIVE: a store that is not placed draws no chip, no filter, and its receive dialog asks no warehouse', async () => {
    stubInventory({ stockSummary: ROWS.map(({ places: _p, ...r }) => (void _p, r)), alerts: [], ledgerDays: 13 });
    render(<InventoryBalancesScreen />);
    await screen.findByText('منتج A');
    expect(screen.queryByText(/مخزن الشمال/)).toBeNull();
    expect(screen.queryByLabelText('المخزن')).toBeNull();
    fireEvent.click(within(card('منتج A')).getByRole('button', { name: 'استلام' }));
    expect(screen.queryByLabelText('المخزن اللي دخلت عليه البضاعة')).toBeNull();
  });
});

describe('the receive dialog’s warehouse', () => {
  const draw = (warehouses?: { id: string; name: string }[]) => {
    const onSaved = vi.fn();
    render(<ReceiveDialog product={{ id: 'p1', name: 'سيروم', remaining: 5, lastUnitCost: 3 }} onClose={() => {}} onSaved={onSaved} warehouses={warehouses} />);
    return onSaved;
  };
  const press = () => screen.getByRole('button', { name: 'استلام' }) as HTMLButtonElement;

  it('two warehouses: none chosen for her, the press waits until she picks one', () => {
    draw([{ id: 'w1', name: 'الأول' }, { id: 'w2', name: 'التاني' }]);
    const pick = screen.getByLabelText('المخزن اللي دخلت عليه البضاعة') as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['اختار المخزن', 'الأول', 'التاني']);
    expect(press().disabled).toBe(true);
    fireEvent.change(pick, { target: { value: 'w2' } });
    expect(press().disabled).toBe(false);
  });

  it('NEGATIVE: no warehouse she may receive into — it says why, and nothing can be sent', () => {
    draw([]);
    expect(screen.getByText(/ما إلك وصول على ولا مخزن/)).toBeTruthy();
    expect(press().disabled).toBe(true);
    fireEvent.click(press());
    expect(api).not.toHaveBeenCalled();
  });

  it('NEGATIVE: no list at all (a store not placed) — no picker, and the body carries no warehouse key', async () => {
    api.mockResolvedValue({ ok: true });
    const onSaved = draw(undefined);
    expect(screen.queryByLabelText('المخزن اللي دخلت عليه البضاعة')).toBeNull();
    fireEvent.change(screen.getByLabelText('الكمية المستلمة'), { target: { value: '2' } });
    fireEvent.click(press());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect('warehouseId' in JSON.parse((api.mock.calls[0][1] as RequestInit).body as string)).toBe(false);
  });
});

describe('«حركات المخزون» of a placed store', () => {
  const MOVES = [
    { id: 'm1', type: 'SALE', quantity: -2, balanceAfter: 5, reason: null, createdAt: '2026-11-02T09:00:00.000Z', product: { id: 'p1', name: 'كريم تجربة', sku: 'S1' }, batchNumber: 'B-1', createdByName: null, warehouseName: 'مخزن الشمال' },
    { id: 'm2', type: 'PRODUCTION', quantity: 9, balanceAfter: 7, reason: null, createdAt: '2026-11-01T09:00:00.000Z', product: { id: 'p2', name: 'صابون تجربة', sku: 'S2' }, batchNumber: 'B-2', createdByName: null, warehouseName: null },
  ];
  let asked: string[];
  beforeEach(() => {
    asked = [];
    api.mockImplementation(async (url: string) => {
      asked.push(url);
      return { movements: MOVES, types: [{ type: 'SALE', count: 1 }], hasMore: false, warehouses: [{ id: 'w-a', name: 'مخزن الشمال' }] };
    });
  });

  it('a warehouse column (a store-wide line says so), and the filter asks the server for one warehouse', async () => {
    render(<InventoryMovementsScreen />);
    await screen.findAllByText('كريم تجربة');
    expect(screen.getAllByText('المخزن').length).toBeGreaterThan(0);
    expect(screen.getAllByText('مخزن الشمال').length).toBeGreaterThan(0);
    expect(screen.getAllByText('المتجر كله').length).toBeGreaterThan(0);
    const filter = screen.getAllByRole('combobox').find((s) => [...(s as HTMLSelectElement).options].some((o) => o.textContent === 'كل المخازن')) as HTMLSelectElement;
    fireEvent.change(filter, { target: { value: 'w-a' } });
    await waitFor(() => expect(asked.some((u) => u.includes('warehouse=w-a'))).toBe(true));
  });

  it('NEGATIVE: a store not placed — no column, no filter, and the address carries no warehouse', async () => {
    api.mockImplementation(async (url: string) => {
      asked.push(url);
      return { movements: MOVES.map(({ warehouseName: _w, ...m }) => (void _w, m)), types: [], hasMore: false };
    });
    render(<InventoryMovementsScreen />);
    await screen.findAllByText('كريم تجربة');
    expect(screen.queryByText('كل المخازن')).toBeNull();
    expect(screen.queryByText('المتجر كله')).toBeNull();
    expect(asked.every((u) => !u.includes('warehouse'))).toBe(true);
  });
});

describe('the screens compute no figure', () => {
  it('no sum, no difference of a place figure in the two screens or the dialog', () => {
    for (const f of [
      'src/components/screens/InventoryBalancesScreen.tsx',
      'src/components/screens/InventoryMovementsScreen.tsx',
      'src/components/inventory/ReceiveDialog.tsx',
    ]) {
      const src = stripComments(repoFile(f));
      expect(src, f).not.toMatch(/places[^\n]*\.reduce\(/);
      expect(src, f).not.toMatch(/onHand\s*[-+]/);
      expect(src, f).not.toMatch(/(inTransit|withCourier|unplaced)\s*[-+]\s*\w/);
    }
  });
});
