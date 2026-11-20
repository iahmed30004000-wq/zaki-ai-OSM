// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «من أي مخزن؟» ON THE THREE SHIPPING SCREENS (the warehouse plan, request W4c).
 *
 * «التجهيز», «إنشاء شحنة» and «دفعات الشحن» of a store PLACED in warehouses draw a picker of the warehouses the server
 * offers (one → chosen; several → the last pick of this person on this device, if still offered), ask their list for the
 * chosen warehouse, and «إنشاء شحنة» carries it in the press. A shortage in the chosen warehouse offers a new transfer to
 * whoever holds the transfer key. The batch card names its warehouse.
 *
 * A store that is NOT placed (the list carries no `warehouses`): no picker, and the very requests and bodies these
 * screens sent before — pinned here by their exact URLs and keys.
 */

const { apiJson, confirmAsk, toastFailed, user, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  confirmAsk: vi.fn(async (o: { title: string }) => o !== null),
  toastFailed: vi.fn(),
  user: { current: null as unknown },
  phone: { current: false },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/ops',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.current }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => false }));
// The real hook runs `load` again when its `key` changes; so does this one.
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void> | void, opts?: { key?: unknown; initial?: boolean }) => {
    React.useEffect(() => {
      if (opts?.initial !== false) void load();
    }, [opts?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  },
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: toastFailed, done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => confirmAsk,
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ChangeRequestReview', () => ({ ChangeRequestReview: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({ DelayShipmentDialog: () => null }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null, ScanSheet: () => null }));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => ({ dims: { width: 100, height: 150 } }), LabelSizePicker: () => null }));

import { PreparationScreen } from './PreparationScreen';
import { ShipmentsNewScreen } from './ShipmentsNewScreen';
import { ShippingBatchesScreen } from './ShippingBatchesScreen';
import { NO_WAREHOUSE_AR } from '@/components/ops/WarehousePicker';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 20000 });

const A = { id: 'wa', name: 'مخزن الشمال' };
const B = { id: 'wb', name: 'مخزن الجنوب' };
const PACKER = { id: 'u1', status: 'ACTIVE', role: 'CUSTOM', permissions: ['ops.prepare', 'ops.ship', 'ops.batches'] };
const MOVER = { ...PACKER, permissions: [...PACKER.permissions, 'inventory.view', 'inventory.transfer'] };

beforeEach(() => {
  vi.clearAllMocks();
  user.current = PACKER;
  phone.current = false;
  window.localStorage.clear();
});
afterEach(cleanup);

/** Every GET the screen made, in order (the references door aside). */
const gets = (prefix: string) => apiJson.mock.calls.filter((c) => !c[1] && String(c[0]).startsWith(prefix)).map((c) => String(c[0]));

/* ───────────────────────────── «التجهيز» ───────────────────────────── */

const group = (over: Record<string, unknown> = {}) => ({
  productId: 'p1', productName: 'مقشر', orders: 1, required: 4, available: 4, shortage: 0,
  lines: [{ orderId: 'o1', orderNumber: 'ORD-1', customerName: 'زبون', regionName: null, pendingChangeRequestId: null, quantity: 4, freeQuantity: 0, reservedQty: 4, shippingStatus: 'NOT_READY' }],
  ...over,
});
function servePrep(warehouses?: unknown[], shortages = 0) {
  apiJson.mockImplementation(async () => ({
    allowNegativeStock: false,
    totals: { products: 1, orders: 1, shortages },
    groups: [group(shortages ? { available: 1, shortage: 3 } : {})],
    ...(warehouses ? { warehouses } : {}),
  }));
}

describe('«التجهيز»', () => {
  it('a store that is not placed: one request, the one it always made, and no picker', async () => {
    servePrep();
    render(<PreparationScreen />);
    await screen.findByText('مقشر', undefined, WAIT);
    expect(gets('/api/ops/preparation')).toEqual(['/api/ops/preparation']);
    expect(screen.queryByLabelText(/المخزن/)).toBeNull();
    expect(screen.queryByText(/انقل بضاعة/)).toBeNull();
  });

  it('a placed store with ONE warehouse: it is chosen, and the list is asked for it', async () => {
    servePrep([A]);
    render(<PreparationScreen />);
    await waitFor(() => expect(gets('/api/ops/preparation')).toContain('/api/ops/preparation?warehouse=wa'), WAIT);
    const select = screen.getByLabelText('المخزن اللي بتجهّز منه') as HTMLSelectElement;
    expect(select.value).toBe('wa');
    expect([...select.options].map((o) => o.textContent)).toEqual([A.name]);
  });

  it('several: «كل المخازن» first (the store’s shelf); a pick asks again and is remembered for this person', async () => {
    servePrep([A, B]);
    render(<PreparationScreen />);
    const select = (await screen.findByLabelText('المخزن اللي بتجهّز منه', undefined, WAIT)) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['كل المخازن', A.name, B.name]);
    expect(gets('/api/ops/preparation')).toEqual(['/api/ops/preparation']);
    fireEvent.change(select, { target: { value: 'wb' } });
    await waitFor(() => expect(gets('/api/ops/preparation')).toContain('/api/ops/preparation?warehouse=wb'), WAIT);
    expect(window.localStorage.getItem('ops-warehouse:u1')).toBe('wb');
  });

  it('the remembered pick is chosen on the next visit', async () => {
    window.localStorage.setItem('ops-warehouse:u1', 'wb');
    servePrep([A, B]);
    render(<PreparationScreen />);
    await waitFor(() => expect(gets('/api/ops/preparation')).toContain('/api/ops/preparation?warehouse=wb'), WAIT);
  });

  it('NEGATIVE: a remembered warehouse that is no longer offered is not asked for', async () => {
    window.localStorage.setItem('ops-warehouse:u1', 'gone');
    servePrep([A, B]);
    render(<PreparationScreen />);
    await screen.findByLabelText('المخزن اللي بتجهّز منه', undefined, WAIT);
    await new Promise((r) => setTimeout(r, 50));
    expect(gets('/api/ops/preparation')).toEqual(['/api/ops/preparation']);
  });

  it('placed, and she reaches none: the sentence, no select', async () => {
    servePrep([]);
    render(<PreparationScreen />);
    expect(await screen.findByText(NO_WAREHOUSE_AR, undefined, WAIT)).toBeTruthy();
    expect(screen.queryByLabelText(/المخزن اللي بتجهّز منه/)).toBeNull();
  });

  it('a shortage in the chosen warehouse offers a new transfer to the holder of the transfer key', async () => {
    user.current = MOVER;
    servePrep([A], 1);
    render(<PreparationScreen />);
    const link = await screen.findByRole('link', { name: 'انقل بضاعة بين المخازن' }, WAIT);
    expect(link.getAttribute('href')).toBe('/inventory/transfers');
  });

  it('NEGATIVE: without the transfer key there is no link that would end in a refusal', async () => {
    servePrep([A], 1);
    render(<PreparationScreen />);
    await waitFor(() => expect(gets('/api/ops/preparation')).toContain('/api/ops/preparation?warehouse=wa'), WAIT);
    expect(screen.queryByRole('link', { name: 'انقل بضاعة بين المخازن' })).toBeNull();
  });

  it('a warehouse refused since the pick (stopped, taken away): back to the store’s shelf, no error screen', async () => {
    window.localStorage.setItem('ops-warehouse:u1', 'wb');
    apiJson.mockImplementation(async (url: string) => {
      if (url.includes('warehouse=wb')) {
        throw Object.assign(new Error('هالمخزن موقوف. اعمل الشحنة من مخزن تاني.'), { status: 409, data: { code: 'WAREHOUSE_STOPPED' } });
      }
      return { allowNegativeStock: false, totals: { products: 1, orders: 1, shortages: 0 }, groups: [group()], warehouses: [A, B] };
    });
    render(<PreparationScreen />);
    await waitFor(() => expect(gets('/api/ops/preparation').filter((u) => u === '/api/ops/preparation').length).toBeGreaterThanOrEqual(2), WAIT);
    expect(screen.queryByText(/هالمخزن موقوف/)).toBeNull();
    expect(window.localStorage.getItem('ops-warehouse:u1')).toBeNull();
  });
});

/* ───────────────────────────── «إنشاء شحنة» ───────────────────────────── */

const row = (over: Record<string, unknown> = {}) => ({
  id: '1', orderNumber: 'SY-2026-0001', merchantRef: null,
  customer: { id: 'c1', fullName: 'سامر خليل', phone: '0790000000', city: 'دمشق' },
  previousOrders: 0, region: { id: 'r1', name: 'دمشق' },
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
  cod: { subtotal: 20, discount: 0, deliveryFee: 0, cod: 20, currency: 'SYP', feeSource: 'region' },
  blocks: [], selectable: true, hardBlocked: false, shipHoldUntil: null, standDownBlocked: null, shipHoldReason: null,
  ...over,
});
const SHORT = 'نقص مخزون بمخزن «مخزن الشمال»: منتج (ينقص 1) — في منه بمخزن «مخزن الجنوب»: انقله من هناك، أو اعمل الشحنة من هناك.';

function serveShip(warehouses?: unknown[], orders: unknown[] = [row()]) {
  apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { batch: { id: 'b1', batchNumber: 'SB-1' }, shipped: 1, exceptions: [] };
    if (url.startsWith('/api/ops/shipments')) return { orders, heldCount: 0, ...(warehouses ? { warehouses } : {}) };
    return { providers: [{ id: 'p1', name: 'شركة الشحن أ' }], regions: [] };
  });
}
const posted = () => {
  const call = apiJson.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
};
const pick = async () => {
  await screen.findAllByText(/سامر خليل/, undefined, WAIT);
  fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
  fireEvent.click(document.querySelector('thead input[type="checkbox"]') as HTMLInputElement);
};
const pressButton = () => screen.getAllByText(/إنشاء شحنة \(/)[0].closest('button') as HTMLButtonElement;

describe('«إنشاء شحنة»', () => {
  it('a store that is not placed: the list and the press are today’s — no warehouse anywhere', async () => {
    serveShip();
    render(<ShipmentsNewScreen />);
    await pick();
    await act(async () => {
      fireEvent.click(pressButton());
    });
    await waitFor(() => expect(posted()).not.toBeNull(), WAIT);
    expect(Object.keys(posted()).sort()).toEqual(['acknowledgedOrderIds', 'deliveryProviderId', 'orderIds']);
    for (const u of gets('/api/ops/shipments')) expect(u).not.toContain('warehouse');
    expect(screen.queryByLabelText(/طالعة منه الشحنة/)).toBeNull();
    expect(confirmAsk.mock.calls[0][0].title).toBe('شحن 1 طلباً مع شركة الشحن أ؟');
  });

  it('placed, several, none chosen: the press waits; a pick asks the list for it and the press carries it', async () => {
    serveShip([A, B]);
    render(<ShipmentsNewScreen />);
    await pick();
    expect(pressButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('المخزن اللي طالعة منه الشحنة'), { target: { value: 'wb' } });
    await waitFor(() => expect(gets('/api/ops/shipments').some((u) => u.includes('warehouse=wb'))).toBe(true), WAIT);
    await screen.findAllByText(/سامر خليل/, undefined, WAIT);
    fireEvent.click(document.querySelector('thead input[type="checkbox"]') as HTMLInputElement);
    await act(async () => {
      fireEvent.click(pressButton());
    });
    await waitFor(() => expect(posted()).not.toBeNull(), WAIT);
    expect(posted().warehouseId).toBe('wb');
    expect(confirmAsk.mock.calls[0][0].title).toBe('شحن 1 طلباً مع شركة الشحن أ من مخزن «مخزن الجنوب»؟');
  });

  it('a phone: the bar under the thumb says to pick the warehouse first', async () => {
    phone.current = true;
    serveShip([A, B]);
    render(<ShipmentsNewScreen />);
    await screen.findAllByText(/سامر خليل/, undefined, WAIT);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(await screen.findByText('اختار المخزن من فوق أولاً.', undefined, WAIT)).toBeTruthy();
    const select = screen.getByLabelText('المخزن اللي طالعة منه الشحنة') as HTMLSelectElement;
    expect(select.className).toContain('w-full');
  });

  it('a shortage in the chosen warehouse: the server’s sentence names the other one, and a link opens a new transfer', async () => {
    user.current = MOVER;
    serveShip([A], [row({ blocks: [{ code: 'STOCK_SHORTAGE', message: SHORT, hard: true }], selectable: false, hardBlocked: true })]);
    render(<ShipmentsNewScreen />);
    expect((await screen.findAllByText(new RegExp('في منه بمخزن «مخزن الجنوب»'), undefined, WAIT)).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'انقل بضاعة بين المخازن' }).length).toBeGreaterThan(0), WAIT);
    for (const l of screen.getAllByRole('link', { name: 'انقل بضاعة بين المخازن' })) expect(l.getAttribute('href')).toBe('/inventory/transfers');
  });

  it('NEGATIVE: the same shortage for somebody without the transfer key — the sentence, no link', async () => {
    serveShip([A], [row({ blocks: [{ code: 'STOCK_SHORTAGE', message: SHORT, hard: true }], selectable: false, hardBlocked: true })]);
    render(<ShipmentsNewScreen />);
    await screen.findAllByText(new RegExp('في منه بمخزن'), undefined, WAIT);
    expect(screen.queryByRole('link', { name: 'انقل بضاعة بين المخازن' })).toBeNull();
  });

  it('NEGATIVE: a store that is not placed never offers the link, even to the key holder', async () => {
    user.current = MOVER;
    serveShip(undefined, [row({ blocks: [{ code: 'STOCK_SHORTAGE', message: 'نقص مخزون: منتج (ينقص 1)', hard: true }], selectable: false, hardBlocked: true })]);
    render(<ShipmentsNewScreen />);
    await screen.findAllByText(/نقص مخزون: منتج/, undefined, WAIT);
    expect(screen.queryByRole('link', { name: 'انقل بضاعة بين المخازن' })).toBeNull();
  });
});

/* ───────────────────────────── «دفعات الشحن» ───────────────────────────── */

const batch = (over: Record<string, unknown> = {}) => ({
  id: 'b1', batchNumber: 'SB-2026-0001', status: 'READY',
  provider: { id: 'dp1', name: 'شركة', code: 'X', kind: 'COMPANY', apiEnabled: false },
  creator: { id: 'u1', name: 'سارة' }, createdAt: '2026-11-01T08:00:00.000Z', shippedAt: null, notes: null,
  _count: { orders: 2 }, courierCityGap: null, ...over,
});

describe('«دفعات الشحن»', () => {
  it('a store that is not placed: the request it always made, no picker, no warehouse on the card', async () => {
    apiJson.mockResolvedValue({ batches: [batch()], pagination: { total: 1 } });
    render(<ShippingBatchesScreen />);
    await screen.findByText('SB-2026-0001', undefined, WAIT);
    expect(gets('/api/shipping-batches')).toEqual(['/api/shipping-batches?limit=100']);
    expect(screen.queryByText(/من مخزن/)).toBeNull();
    expect(screen.queryByLabelText('المخزن')).toBeNull();
  });

  it('placed: each card names its warehouse, and a pick narrows the list to one warehouse', async () => {
    apiJson.mockResolvedValue({
      batches: [batch({ warehouse: A }), batch({ id: 'b2', batchNumber: 'SB-2026-0002', warehouse: B })],
      pagination: { total: 2 },
      warehouses: [A, B],
    });
    render(<ShippingBatchesScreen />);
    expect(await screen.findByText(`من مخزن ${A.name}`, undefined, WAIT)).toBeTruthy();
    expect(screen.getByText(`من مخزن ${B.name}`)).toBeTruthy();
    const select = screen.getByLabelText('المخزن') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['كل المخازن', A.name, B.name]);
    fireEvent.change(select, { target: { value: 'wa' } });
    await waitFor(() => expect(gets('/api/shipping-batches')).toContain('/api/shipping-batches?limit=100&warehouse=wa'), WAIT);
  });

  it('a batch of before the placement (no warehouse) says nothing about one', async () => {
    apiJson.mockResolvedValue({ batches: [batch({ warehouse: null })], pagination: { total: 1 }, warehouses: [A] });
    render(<ShippingBatchesScreen />);
    await screen.findByText('SB-2026-0001', undefined, WAIT);
    expect(screen.queryByText(/من مخزن/)).toBeNull();
  });
});
