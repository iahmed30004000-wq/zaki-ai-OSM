// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * THE RETURNS DESK AND THE COUNT ASK FOR A WAREHOUSE — ONLY IN A PLACED STORE (the warehouse plan, W2b) — WHAT THE SCREENS DRAW.
 *
 *   · the receive dialog: «استلمته بمخزن», the warehouse the parcel left from chosen already («(طلع منه)»), another may be
 *     picked; the receipt carries `warehouseId`. A store that is not placed: no control, the body it always sent.
 *   · «استلام الكل»: «استلمتها بمخزن», and «نعم، استلم الكل» stays off until ONE warehouse is chosen; every request of the
 *     walk carries it.
 *   · «جرد مخزون»: «المخزن اللي عدّيته» and «الكمية الموجودة فعلياً بالمخزن» — no figure is drawn to compare with (the
 *     expected number is the server's); the save stays off until a warehouse and a count exist.
 * Nothing behind the login opens in a browser (every account has a second factor), so this is the proof of the screens.
 */

const { api, toast } = vi.hoisted(() => ({ api: vi.fn(), toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/returns', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { cancel: 'الغاء' }, locale: 'ar' }) }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: ({ value }: { value: string }) => <div data-testid="picker">{value}</div> }));
vi.mock('@/components/inventory/OpeningStockCount', () => ({ OpeningStockCountBanner: () => null }));

import { ReturnsScreen } from './ReturnsScreen';
import { InventoryBalancesScreen } from './InventoryBalancesScreen';

const PLACES = [
  { id: 'w1', name: 'الرئيسي' },
  { id: 'w2', name: 'الفرع' },
];
const ROW = {
  id: 'o1', orderNumber: 'ORD-1', merchantRef: null, trackingNumber: 'T1', shippingStatus: 'RETURNED', returnReason: null,
  expectedQty: 2, daysWaited: 2, customer: { fullName: 'سارة' }, region: { name: 'عمّان' }, deliveryProvider: { name: 'ناقل' },
  lines: [{ itemId: 'i1', productName: 'زيت', shipped: 2, delivered: null, expectedBack: 2 }],
  completion: { halves: [], settledCount: 0, degree: 'NONE', complete: false, awaiting: [], label: '' },
  action: null,
  sourceWarehouseName: 'الرئيسي',
};

let placed: boolean;
const posts = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
const bodies = () => posts().map((c) => JSON.parse(String((c[1] as RequestInit).body)));

beforeEach(() => {
  vi.clearAllMocks();
  placed = true;
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/ops/returns/warehouses') return placed ? { placed: true, warehouses: PLACES } : { placed: false };
    if (init?.method === 'POST' && url === '/api/ops/returns/receive-all') return { received: 1, skipped: {}, nextCursor: null };
    if (init?.method === 'POST') return { missingQty: 0, courierFeeAmount: 0, completion: { ...ROW.completion, complete: true } };
    const view = new URL(url, 'http://x').searchParams.get('view') ?? 'pending';
    return {
      count: 1,
      orders: [ROW],
      pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      facts: { views: { pending: 1, received: 0 }, statuses: { RETURN_REQUESTED: 0, RETURNED: 1, FAILED_DELIVERY: 0, PARTIALLY_DELIVERED: 0 }, couriers: [], ages: { fresh: 1, few: 0, week: 0, old: 0 }, noBarcode: 0 },
      applied: { view, status: null, courier: null, age: null, q: null },
      mayChargeFee: false,
      mayReceiveAll: true,
    };
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const openReceipt = async () => {
  render(<ReturnsScreen />);
  await screen.findByLabelText('العرض');
  const row = screen.getAllByText('ORD-1').map((el) => el.closest('tr')).find((tr): tr is HTMLTableRowElement => !!tr)!;
  fireEvent.click(within(row).getByRole('button', { name: 'استلام' }));
  return screen.findByRole('dialog');
};

describe('the receive dialog of a placed store', () => {
  it('asks where it was received, with the warehouse it left from chosen — and sends it', async () => {
    const dialog = await openReceipt();
    const pick = (await within(dialog).findByLabelText('استلمته بمخزن')) as HTMLSelectElement;
    expect(pick.value).toBe('w1');
    expect([...pick.options].map((o) => o.textContent)).toEqual(['اختار المخزن', 'الرئيسي (طلع منه)', 'الفرع']);
    fireEvent.change(pick, { target: { value: 'w2' } });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد الاستلام' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodies()[0]).toMatchObject({ orderId: 'o1', warehouseId: 'w2' });
  });

  it('NEGATIVE: with no warehouse chosen the press stays off', async () => {
    const dialog = await openReceipt();
    const pick = (await within(dialog).findByLabelText('استلمته بمخزن')) as HTMLSelectElement;
    fireEvent.change(pick, { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect((within(dialog).getByRole('button', { name: 'تأكيد الاستلام' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('NEGATIVE: a store that is not placed — no control, and the body is the one it always was', async () => {
    placed = false;
    const dialog = await openReceipt();
    await waitFor(() => expect(api.mock.calls.some((c) => c[0] === '/api/ops/returns/warehouses')).toBe(true));
    expect(within(dialog).queryByLabelText('استلمته بمخزن')).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد الاستلام' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(Object.keys(bodies()[0]).sort()).toEqual(['chargeCourierFee', 'countedAndInspected', 'damagedQty', 'orderId', 'receivedQty'].sort());
  });
});

describe('«استلام الكل» of a placed store', () => {
  const open = async () => {
    render(<ReturnsScreen />);
    await screen.findByLabelText('العرض');
    fireEvent.click(screen.getByRole('button', { name: /^استلام الكل/ }));
    return screen.findByRole('dialog');
  };

  it('ONE warehouse for the whole press: off until chosen, then every request carries it', async () => {
    const dialog = await open();
    expect(dialog.textContent).toContain('كلها على نفس المخزن');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'أقرّ إني عددت وفحصت المرتجعات' }));
    const yes = within(dialog).getByRole('button', { name: 'نعم، استلم الكل' }) as HTMLButtonElement;
    const pick = (await within(dialog).findByLabelText('استلمتها بمخزن')) as HTMLSelectElement;
    expect(pick.value).toBe('');
    expect(yes.disabled).toBe(true);
    fireEvent.change(pick, { target: { value: 'w2' } });
    expect(yes.disabled).toBe(false);
    fireEvent.click(yes);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodies()[0]).toMatchObject({ countedAndInspected: true, warehouseId: 'w2' });
  });

  it('NEGATIVE: a store that is not placed — no picker, «على الرف», and no warehouse on the wire', async () => {
    placed = false;
    const dialog = await open();
    await waitFor(() => expect(api.mock.calls.some((c) => c[0] === '/api/ops/returns/warehouses')).toBe(true));
    expect(within(dialog).queryByLabelText('استلمتها بمخزن')).toBeNull();
    expect(dialog.textContent).toContain('البضاعة بترجع على الرف.');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'أقرّ إني عددت وفحصت المرتجعات' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'نعم، استلم الكل' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodies()[0]).not.toHaveProperty('warehouseId');
  });
});

/* ───────────── the count ───────────── */

const PRODUCT = {
  id: 'prod-1', name: 'كريم', sku: 'KR-1', sourceType: 'PURCHASED', produced: 500, sold: 20, remaining: 480, reserved: 0,
  health: { state: 'HEALTHY', label: 'متوفر', tone: 'success', why: '', available: 480, perDay: null, coverDays: null, windowDays: 13, score: null, bands: [], needsRestock: false },
};
let sent: { url: string; body: Record<string, unknown> }[] = [];

function stubInventory(warehouses: unknown) {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        sent.push({ url, body: JSON.parse(String(init!.body)) });
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      return { ok: true, json: async () => ({ stockSummary: [PRODUCT], alerts: [], ledgerDays: 13, ...(warehouses ? { warehouses } : {}) }) } as Response;
    })
  );
}

const openCount = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<InventoryBalancesScreen />);
  await waitFor(() => expect(screen.getByText('كريم')).toBeTruthy());
  await user.click(screen.getAllByRole('button', { name: /جرد مخزون/ })[0]);
  await waitFor(() => expect(screen.getByTestId('picker').textContent).toBe('prod-1'));
};

describe('«جرد مخزون» of a placed store counts one warehouse', () => {
  it('asks which warehouse and what is physically there; draws no figure to compare with; sends the warehouse', async () => {
    stubInventory([
      { id: 'w1', name: 'الرئيسي', mayReceive: true },
      { id: 'w2', name: 'الفرع', mayReceive: true },
      { id: 'w3', name: 'بعيد', mayReceive: false },
    ]);
    const user = userEvent.setup();
    await openCount(user);
    const pick = screen.getByLabelText('المخزن اللي عدّيته *') as HTMLSelectElement;
    // Only the warehouses she may use.
    expect([...pick.options].map((o) => o.textContent)).toEqual(['اختار المخزن', 'الرئيسي', 'الفرع']);
    expect(screen.queryByText('المتاح في النظام')).toBeNull();
    expect(document.body.textContent).toContain('الطرود اللي طلعت مع شركة الشحن ما بتنعدّ');
    const save = screen.getByRole('button', { name: 'سجّل الجرد' }) as HTMLButtonElement;
    await user.type(screen.getByLabelText('الكمية الموجودة فعلياً بالمخزن *'), '7');
    await user.type(screen.getByLabelText('سبب الفرق *'), 'جرد آخر الشهر');
    expect(save.disabled).toBe(true);
    await user.selectOptions(pick, 'w2');
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ action: 'recount', productId: 'prod-1', countedQuantity: '7', reason: 'جرد آخر الشهر', warehouseId: 'w2' });
  });

  it('NEGATIVE: a store that is not placed — today’s count, no warehouse asked or sent', async () => {
    stubInventory(null);
    const user = userEvent.setup();
    await openCount(user);
    expect(screen.queryByLabelText('المخزن اللي عدّيته *')).toBeNull();
    expect(screen.getByText('المتاح في النظام')).toBeTruthy();
  });
});
