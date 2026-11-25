// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «اسم المخزن أظهره بمتابعة المرتجعات، واعمل فلتر من أي مخزن طلع المرتجع» (F10, the owner, 25/11) — WHAT THE DESK DRAWS.
 *
 *   · a PLACED store: a column «المخزن» on both views — the warehouse the parcel left from, «—» for a parcel with none —
 *     and a dropdown «المخزن»: «كل المخازن», the warehouses this person reaches (the server's list, the receive dialog's
 *     door), «بلا مخزن». The choice travels to the server as `warehouse=`, on every page, and «إعادة تعيين» clears it.
 *     While one warehouse is chosen «استلام الكل» is not drawn: the press walks the other filters, not the warehouse.
 *   · a store that is NOT placed: no column, no dropdown, and the list is asked exactly what it was asked before.
 * Nothing behind the login opens in a browser (every account has a second factor), so this is the proof of the screen.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/returns', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), warn: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));

import { ReturnsScreen } from './ReturnsScreen';

const PLACES = [
  { id: 'w1', name: 'الرئيسي' },
  { id: 'w2', name: 'الفرع' },
];
const completion = { halves: [], settledCount: 0, degree: 'NONE', complete: false, awaiting: [], label: '' };
const waiting = (id: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber: `ORD-${id}`, merchantRef: null, trackingNumber: `T-${id}`, shippingStatus: 'RETURNED', returnReason: null,
  expectedQty: 2, daysWaited: 2, customer: { fullName: 'سارة' }, region: { name: 'عمّان' }, deliveryProvider: { name: 'ناقل' },
  lines: [{ itemId: 'i1', productName: 'زيت', shipped: 2, delivered: null, expectedBack: 2 }], completion, action: null,
  ...over,
});
const counted = (id: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber: `ORD-${id}`, merchantRef: null, trackingNumber: `T-${id}`, shippingStatus: 'RETURNED', returnReason: null,
  customer: { fullName: 'هبة' }, region: { name: 'عمّان' }, deliveryProvider: { name: 'أمان' },
  receipt: { expectedQty: 2, receivedQty: 2, damagedQty: 0, missingQty: 0, courierFeeCharged: false, inspectedAt: '2026-11-24T10:00:00.000Z', inspectedBy: 'أمين', note: null },
  ...over,
});

let placed: boolean;
let totalPages: number;
const listCalls = () =>
  api.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/ops/returns?') || u === '/api/ops/returns');
const lastList = () => new URL(listCalls().at(-1)!, 'http://x').searchParams;

beforeEach(() => {
  vi.clearAllMocks();
  placed = true;
  totalPages = 1;
  api.mockImplementation(async (url: string) => {
    if (url === '/api/ops/returns/warehouses') return placed ? { placed: true, warehouses: PLACES } : { placed: false };
    const view = new URL(url, 'http://x').searchParams.get('view') ?? 'pending';
    const orders = view === 'received' ? [counted('R1', { sourceWarehouseName: 'الفرع' }), counted('R2')] : [waiting('P1', { sourceWarehouseName: 'الرئيسي' }), waiting('P2')];
    return {
      count: orders.length,
      orders,
      pagination: { total: orders.length * totalPages, page: Number(new URL(url, 'http://x').searchParams.get('page') ?? 1), limit: 25, totalPages },
      facts: { views: { pending: 2, received: 2 }, statuses: { RETURN_REQUESTED: 0, RETURNED: 2, FAILED_DELIVERY: 0, PARTIALLY_DELIVERED: 0 }, couriers: [], ages: { fresh: 2, few: 0, week: 0, old: 0 }, noBarcode: 0 },
      applied: { view, status: null, courier: null, age: null, q: null },
      mayChargeFee: false,
      mayReceiveAll: true,
    };
  });
});
afterEach(() => cleanup());

const headings = () => [...document.querySelectorAll('th')].map((th) => th.textContent?.trim());
const deskRow = (orderNumber: string) =>
  screen.getAllByText(orderNumber).map((el) => el.closest('tr')).find((tr): tr is HTMLTableRowElement => !!tr)!;
const cellOf = (tr: HTMLElement, heading: string) => [...tr.querySelectorAll('td')][headings().indexOf(heading)] as HTMLElement;
const draw = async () => {
  render(<ReturnsScreen />);
  await screen.findByLabelText('العرض');
};
const placedDrawn = async () => {
  await draw();
  await screen.findByLabelText('المخزن');
};

describe('a placed store: the warehouse the parcel left from', () => {
  it('has its own column on the waiting parcels — the name, or «—» for a parcel with none; the courier cell is the courier', async () => {
    await placedDrawn();
    await waitFor(() => expect(headings()).toContain('المخزن'));
    expect(headings().indexOf('المخزن')).toBe(headings().indexOf('شركة الشحن') + 1);
    expect(cellOf(deskRow('ORD-P1'), 'المخزن').textContent).toBe('الرئيسي');
    expect(cellOf(deskRow('ORD-P2'), 'المخزن').textContent).toBe('—');
    expect(cellOf(deskRow('ORD-P1'), 'شركة الشحن').textContent).toBe('ناقل');
    expect(document.body.textContent).not.toContain('طلع من مخزن');
  });

  it('and on the counted ones', async () => {
    await placedDrawn();
    fireEvent.change(screen.getByLabelText('العرض'), { target: { value: 'received' } });
    const row = await waitFor(() => deskRow('ORD-R1'));
    expect(cellOf(row, 'المخزن').textContent).toBe('الفرع');
    expect(cellOf(deskRow('ORD-R2'), 'المخزن').textContent).toBe('—');
  });

  it('the dropdown offers all, the warehouses she reaches, and «بلا مخزن» — and the choice goes to the server', async () => {
    await placedDrawn();
    const pick = screen.getByLabelText('المخزن') as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['كل المخازن', 'الرئيسي', 'الفرع', 'بلا مخزن']);
    expect(lastList().has('warehouse')).toBe(false);
    fireEvent.change(pick, { target: { value: 'w2' } });
    await waitFor(() => expect(lastList().get('warehouse')).toBe('w2'));
    fireEvent.change(pick, { target: { value: 'none' } });
    await waitFor(() => expect(lastList().get('warehouse')).toBe('none'));
  });

  it('a page turn keeps the warehouse', async () => {
    totalPages = 3;
    await placedDrawn();
    fireEvent.change(screen.getByLabelText('المخزن'), { target: { value: 'w1' } });
    await waitFor(() => expect(lastList().get('warehouse')).toBe('w1'));
    fireEvent.click(await screen.findByLabelText('الصفحة التالية'));
    await waitFor(() => expect(lastList().get('page')).toBe('2'));
    expect(lastList().get('warehouse')).toBe('w1');
  });

  it('«إعادة تعيين» clears it', async () => {
    await placedDrawn();
    fireEvent.change(screen.getByLabelText('المخزن'), { target: { value: 'w1' } });
    await waitFor(() => expect(lastList().get('warehouse')).toBe('w1'));
    fireEvent.click(screen.getByRole('button', { name: /إعادة تعيين/ }));
    await waitFor(() => expect(lastList().has('warehouse')).toBe(false));
    expect((screen.getByLabelText('المخزن') as HTMLSelectElement).value).toBe('all');
  });

  it('NEGATIVE: «استلام الكل» is not drawn while one warehouse is chosen, and comes back with «كل المخازن»', async () => {
    await placedDrawn();
    expect(screen.getByRole('button', { name: /^استلام الكل/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('المخزن'), { target: { value: 'w1' } });
    await waitFor(() => expect(lastList().get('warehouse')).toBe('w1'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^استلام الكل/ })).toBeNull());
    fireEvent.change(screen.getByLabelText('المخزن'), { target: { value: 'all' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^استلام الكل/ })).toBeTruthy());
  });
});

describe('a store that is not placed', () => {
  it('NEGATIVE: no column, no dropdown, the courier line as before, and no `warehouse` asked of the list', async () => {
    placed = false;
    await draw();
    await waitFor(() => expect(api.mock.calls.some((c) => c[0] === '/api/ops/returns/warehouses')).toBe(true));
    expect(headings()).not.toContain('المخزن');
    expect(screen.queryByLabelText('المخزن')).toBeNull();
    // W4d's line under the courier stays what it was for a row that names a warehouse.
    expect(cellOf(deskRow('ORD-P1'), 'شركة الشحن').textContent).toBe('ناقلطلع من مخزن الرئيسي');
    for (const u of listCalls()) expect(new URL(u, 'http://x').searchParams.has('warehouse'), u).toBe(false);
    expect(screen.getByRole('button', { name: /^استلام الكل/ })).toBeTruthy();
  });
});
