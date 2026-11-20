// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * «طلع من مخزن كذا» ON THE TRACKING ROW AND AT THE RETURNS DESK (the warehouse plan, request W4d) — WHAT THE SCREENS DRAW.
 *
 * The doors send `sourceWarehouseName` only for an order that left from a warehouse. The screens:
 *
 *   • tracking: under the courier, «طلع من مخزن <name>», on the desk and on the phone card;
 *   • returns: the same line under the courier in both views, and in the receive dialog the DEFAULT RECEIVER —
 *     «طلع من مخزن <name> — رجّعه عليه.» — said only: the dialog grows no field and the receipt it sends is the same body;
 *   • a row with no name draws nothing new: no «مخزن» anywhere, the courier cell is the courier's name alone.
 */

const { api, toast } = vi.hoisted(() => ({ api: vi.fn(), toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() } }));
const phone = vi.hoisted(() => ({ value: false }));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops',
}));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => async () => true, useTell: () => async () => undefined }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));

import { TrackingScreen } from './TrackingScreen';
import { ReturnsScreen } from './ReturnsScreen';

configure({ asyncUtilTimeout: 8000 });

const P1 = '11111111-1111-4111-8111-111111111111';
const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };
const PLACE = 'المخزن الشمالي';

const parcel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  shippingStatus: 'SHIPPED',
  collectionStatus: 'NOT_APPLICABLE',
  settlementStatus: 'NOT_APPLICABLE',
  daysInTransit: 2,
  lateThresholdDays: 3,
  late: false,
  totalAmount: 40,
  currency: 'JOD',
  deliveryFailureReason: null,
  customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
  region: { name: 'عمّان' },
  deliveryProvider: { id: P1, name: 'الباشا', kind: 'COMPANY' },
  expectedCollection: 37.5,
  _count: { deliveryAttempts: 0, notes: 0 },
  alert: null,
  courierSaid: null,
  ...over,
});

const completion = {
  halves: [{ key: 'GOODS', label: 'استلام الراجع', settled: false, units: 2 }],
  settledCount: 0,
  degree: 'NONE',
  complete: false,
  awaiting: ['GOODS'],
  label: 'تمّ 0 من 1',
};
const waiting = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  shippingStatus: 'RETURNED',
  returnReason: null,
  expectedQty: 2,
  daysWaited: 3,
  customer: { fullName: 'منى' },
  region: { name: 'عمّان' },
  deliveryProvider: { name: 'ناقل' },
  lines: [{ itemId: 'i1', productName: 'منتج', shipped: 2, delivered: null, expectedBack: 2 }],
  completion,
  action: null,
  ...over,
});
const counted = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  shippingStatus: 'RETURNED',
  returnReason: null,
  customer: { fullName: 'هبة' },
  region: { name: 'عمّان' },
  deliveryProvider: { name: 'أمان' },
  receipt: {
    expectedQty: 2, receivedQty: 2, damagedQty: 0, missingQty: 0, courierFeeCharged: false,
    inspectedAt: '2026-11-19T10:00:00.000Z', inspectedBy: 'أمين', note: null,
  },
  ...over,
});

let trackingRows: unknown[];
let returnRows: (view: string) => unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  trackingRows = [];
  returnRows = () => [];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { missingQty: 0, courierFeeAmount: 0, completion: { ...completion, complete: true } };
    const u = new URL(url, 'http://x');
    if (u.pathname.startsWith('/api/ops/returns')) {
      const view = u.searchParams.get('view') ?? 'pending';
      const orders = returnRows(view);
      return {
        count: orders.length,
        orders,
        pagination: { total: orders.length, page: 1, limit: 25, totalPages: 1 },
        facts: {
          views: { pending: 2, received: 1 },
          statuses: { RETURN_REQUESTED: 0, RETURNED: 2, FAILED_DELIVERY: 0, PARTIALLY_DELIVERED: 0 },
          couriers: [],
          ages: { fresh: 2, few: 0, week: 0, old: 0 },
          noBarcode: 0,
        },
        applied: { view, status: null, courier: null, age: null, q: null },
        mayChargeFee: false,
        mayReceiveAll: false,
      };
    }
    return {
      count: trackingRows.length,
      orders: trackingRows,
      lateCount: 0,
      dialCode: '962',
      pagination: { total: trackingRows.length, page: 1, limit: 25, totalPages: 1 },
      facts: {
        total: trackingRows.length,
        tasks: NO_TASKS,
        lateCount: 0,
        notLate: 0,
        couriers: [{ id: P1, name: 'الباشا', count: trackingRows.length }],
        regions: [],
        ages: { fresh: 1, few: 0, week: 0, old: 0 },
      },
      applied: {},
      capped: false,
      access: { money: true, returns: true, collect: false },
    };
  });
});
afterEach(() => cleanup());

const headings = () => [...document.querySelectorAll('th')].map((th) => th.textContent?.trim());
const deskRow = (orderNumber: string) =>
  screen.getAllByText(orderNumber).map((el) => el.closest('tr')).find((tr): tr is HTMLTableRowElement => !!tr)!;
const cellOf = (tr: HTMLElement, heading: string) => [...tr.querySelectorAll('td')][headings().indexOf(heading)] as HTMLElement;
const cards = () => document.querySelector('ul.md\\:hidden') as HTMLElement | null;

describe('the tracking row', () => {
  const draw = async () => {
    render(<TrackingScreen />);
    await screen.findByLabelText('جهة الشحن');
  };

  it('— under the courier: «طلع من مخزن <name>», in the server’s words, on the desk and on the card', async () => {
    trackingRows = [parcel('a', { sourceWarehouseName: PLACE })];
    await draw();
    const cell = cellOf(deskRow('ORD-a'), 'جهة الشحن');
    expect(cell.textContent).toContain('الباشا');
    const line = within(cell).getByText(`طلع من مخزن ${PLACE}`);
    // Existing classes only: a small muted line under the name.
    expect(line.className).toBe('block text-note text-[var(--sys-muted-foreground)]');
    if (cards()) expect(within(cards()!).getAllByText(`طلع من مخزن ${PLACE}`).length).toBeGreaterThan(0);
  });

  it('and a row with no courier still says the warehouse', async () => {
    trackingRows = [parcel('a', { deliveryProvider: null, sourceWarehouseName: PLACE })];
    await draw();
    const cell = cellOf(deskRow('ORD-a'), 'جهة الشحن');
    expect(cell.textContent).toBe(`—طلع من مخزن ${PLACE}`);
  });

  it('NEGATIVE: a row with no name draws nothing new — no «مخزن» on the screen, the cell is the courier alone', async () => {
    trackingRows = [parcel('a'), parcel('b', { deliveryProvider: null })];
    await draw();
    expect(cellOf(deskRow('ORD-a'), 'جهة الشحن').textContent).toBe('الباشا');
    expect(cellOf(deskRow('ORD-b'), 'جهة الشحن').textContent).toBe('—');
    expect(document.body.textContent).not.toContain('طلع من مخزن');
  });
});

describe('the returns desk', () => {
  const draw = async () => {
    render(<ReturnsScreen />);
    await screen.findByLabelText('العرض');
  };

  it('— a waiting parcel says where it left from under its courier', async () => {
    returnRows = () => [waiting('P1', { sourceWarehouseName: PLACE }), waiting('P2')];
    await draw();
    const cell = cellOf(deskRow('ORD-P1'), 'شركة الشحن');
    expect(cell.textContent).toBe(`ناقلطلع من مخزن ${PLACE}`);
    expect(within(cell).getByText(`طلع من مخزن ${PLACE}`).className).toBe('block text-note text-[var(--sys-muted-foreground)]');
    // NEGATIVE: its neighbour with no name is the courier alone.
    expect(cellOf(deskRow('ORD-P2'), 'شركة الشحن').textContent).toBe('ناقل');
  });

  it('and the receive dialog names the default receiver — said only: no new field, the same body on the wire', async () => {
    returnRows = () => [waiting('P1', { sourceWarehouseName: PLACE })];
    await draw();
    fireEvent.click(within(deskRow('ORD-P1')).getByRole('button', { name: 'استلام' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`طلع من مخزن ${PLACE} — رجّعه عليه.`)).toBeTruthy();
    // No control asks for a warehouse: choosing the receiver is a later request.
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByLabelText(/مخزن/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد الاستلام' }));
    await vi.waitFor(() => expect(api.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const post = api.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(Object.keys(JSON.parse(String((post[1] as RequestInit).body))).sort()).toEqual(
      ['chargeCourierFee', 'countedAndInspected', 'damagedQty', 'orderId', 'receivedQty'].sort(),
    );
  });

  it('NEGATIVE: a parcel with no source warehouse — no line on the row, none in the dialog', async () => {
    returnRows = () => [waiting('P1')];
    await draw();
    fireEvent.click(within(deskRow('ORD-P1')).getByRole('button', { name: 'استلام' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).not.toContain('مخزن');
    expect(document.body.textContent).not.toContain('طلع من مخزن');
  });

  it('and a counted parcel says it too, in the record view', async () => {
    returnRows = (view) => (view === 'received' ? [counted('R1', { sourceWarehouseName: PLACE }), counted('R2')] : []);
    await draw();
    fireEvent.change(screen.getByLabelText('العرض'), { target: { value: 'received' } });
    const row = await vi.waitFor(() => deskRow('ORD-R1'));
    expect(cellOf(row, 'شركة الشحن').textContent).toBe(`أمانطلع من مخزن ${PLACE}`);
    expect(cellOf(deskRow('ORD-R2'), 'شركة الشحن').textContent).toBe('أمان');
  });
});
