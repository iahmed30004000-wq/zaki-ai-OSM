// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «تراجع عن المرتجع» ON THE TRACKING SCREEN (25/11) — the owner's button, on a parcel «رجعت» recorded RETURNED that the returns desk has
 * not counted. The same key as «تراجع عن التسليم» (`acts.undoDelivery`), the same screen, the same dialog asked about the other mistake.
 * The server says whether the desk counted it (`returnCounted`); only an explicit «no» draws the button.
 */

const { api, phone } = vi.hoisted(() => ({ api: vi.fn(), phone: { value: false } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => async () => true, useTell: () => async () => undefined }));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('@/components/screens/tracking/CloseLegacyDialog', () => ({ CloseLegacyDialog: () => null }));
vi.mock('@/components/screens/tracking/UndoDeliveryDialog', () => ({
  UndoDeliveryDialog: ({ order, kind, onClose, onDone }: { order: { orderNumber: string }; kind?: string; onClose: () => void; onDone: (m: string) => void }) => (
    <div role="dialog" aria-label="نافذة التراجع">
      <span data-testid="for">{order.orderNumber}</span>
      <span data-testid="kind">{kind ?? 'delivery'}</span>
      <button onClick={() => onDone(`اتراجع عن مرتجع الطلب ${order.orderNumber} — رجع «مشحون»`)}>تمّ</button>
      <button onClick={onClose}>إغلاق النافذة</button>
    </div>
  ),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));

import { TrackingScreen } from '@/components/screens/TrackingScreen';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 60000 });

const P1 = '11111111-1111-4111-8111-111111111111';
const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };

const parcel = (id: string, shippingStatus: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  shippingStatus,
  settlementStatus: 'PENDING_COLLECTION',
  collectionStatus: 'PENDING_COLLECTION',
  daysInTransit: 5,
  lateThresholdDays: 3,
  late: false,
  totalAmount: 40,
  currency: 'USD',
  deliveryFailureReason: null,
  customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
  region: { name: 'عمّان' },
  deliveryProvider: { id: P1, name: 'الباشا', kind: 'COMPANY' },
  expectedCollection: 37.5,
  _count: { deliveryAttempts: 0, notes: 0 },
  alert: null,
  courierSaid: null,
  returnCounted: false,
  ...over,
});

const ACTS = { deliver: true, transfer: true, writeOff: true, closeLegacy: false };

const answerFor = (rows: ReturnType<typeof parcel>[], acts: Record<string, boolean> | undefined) => ({
  count: rows.length,
  orders: rows,
  lateCount: 0,
  dialCode: '962',
  pagination: { total: rows.length, page: 1, limit: 25, totalPages: 1 },
  facts: {
    total: rows.length,
    tasks: NO_TASKS,
    lateCount: 0,
    notLate: 0,
    couriers: [{ id: P1, name: 'الباشا', count: rows.length }],
    regions: [],
    ages: { fresh: 0, few: 0, week: 0, old: 0 },
    said: { DELIVERED: 0, PARTIALLY_DELIVERED: 0, RETURNED: 0, CANCELLED: 0, FAILED_DELIVERY: 0 },
  },
  applied: {},
  capped: false,
  access: { money: true, returns: true, collect: false },
  ...(acts === undefined ? {} : { acts }),
});

let answer: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  api.mockImplementation(async () => answer);
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TrackingScreen />);
  await screen.findByLabelText('جهة الشحن');
};
const BUTTON = 'تراجع عن المرتجع…';
const buttons = () => screen.queryAllByRole('button', { name: BUTTON });

const OTHER_STATES = ['NOT_READY', 'READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED'];

describe('who gets «تراجع عن المرتجع» — and where', () => {
  it('the holder of the key, on a RETURNED parcel the desk has not counted (desk table and phone cards both draw the row)', async () => {
    answer = answerFor([parcel('1', 'RETURNED')], { ...ACTS, undoDelivery: true });
    await draw();
    expect(buttons()).toHaveLength(2);
  });

  it('NEGATIVE: a returned parcel the desk COUNTED has no button — nor one whose answer does not say', async () => {
    answer = answerFor([parcel('1', 'RETURNED', { returnCounted: true }), parcel('2', 'RETURNED', { returnCounted: undefined })], { ...ACTS, undoDelivery: true });
    await draw();
    expect(buttons()).toHaveLength(0);
  });

  it('NEGATIVE: every other state has no return button', async () => {
    answer = answerFor(OTHER_STATES.map((s, i) => parcel(String(i + 1), s)), { ...ACTS, undoDelivery: true });
    await draw();
    expect(buttons()).toHaveLength(0);
  });

  it('NEGATIVE: someone without the key never sees it; an answer that does not name the key is «no»', async () => {
    answer = answerFor([parcel('1', 'RETURNED')], { ...ACTS, closeLegacy: true, undoDelivery: false });
    await draw();
    expect(buttons()).toHaveLength(0);
    cleanup();
    answer = answerFor([parcel('1', 'RETURNED')], ACTS);
    await draw();
    expect(buttons()).toHaveLength(0);
  });

  it('a returned parcel never shows «تراجع عن التسليم», and a delivered one never shows this', async () => {
    answer = answerFor([parcel('1', 'RETURNED'), parcel('2', 'DELIVERED')], { ...ACTS, undoDelivery: true });
    await draw();
    expect(buttons()).toHaveLength(2);
    expect(screen.queryAllByRole('button', { name: 'تراجع عن التسليم…' })).toHaveLength(2);
  });
});

describe('the press', () => {
  it('opens the dialog for THAT parcel, asked about the RETURN; a success says the door’s sentence and reads the list again', async () => {
    answer = answerFor([parcel('1', 'SHIPPED'), parcel('2', 'RETURNED')], { ...ACTS, undoDelivery: true });
    await draw();
    fireEvent.click(buttons()[0]);
    expect(screen.getByTestId('for').textContent).toBe('ORD-2');
    expect(screen.getByTestId('kind').textContent).toBe('return');
    const before = api.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'تمّ' }));
    expect(await screen.findByText('اتراجع عن مرتجع الطلب ORD-2 — رجع «مشحون»')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'نافذة التراجع' })).toBeNull();
    await waitFor(() => expect(api.mock.calls.length).toBeGreaterThan(before));
  });

  it('the «تراجع عن التسليم» press still opens the delivery dialog', async () => {
    answer = answerFor([parcel('2', 'DELIVERED')], { ...ACTS, undoDelivery: true });
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'تراجع عن التسليم…' })[0]);
    expect(screen.getByTestId('kind').textContent).toBe('delivery');
  });

  it('on a desk it is the same quiet link as «تحويل», and it says what it does in Arabic', async () => {
    answer = answerFor([parcel('2', 'RETURNED')], { ...ACTS, undoDelivery: true });
    await draw();
    const undo = buttons()[0];
    expect(undo.className).toBe(screen.getAllByRole('button', { name: 'تحويل' })[0].className);
    expect(undo.getAttribute('title')).toBe('رجّع الطلب لحالتو قبل «رجعت» — لما انسجّل مرتجع بالغلط');
  });
});

describe('read from the sources, so the screen and the list cannot drift', () => {
  it('the screen draws it for the server’s key, a RETURNED parcel and an explicit «not counted» only', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/TrackingScreen.tsx'), 'utf8'));
    expect(src).toContain("{acts.undoDelivery && o.shippingStatus === 'RETURNED' && o.returnCounted === false && (");
  });

  it('the list sends whether the desk counted it — the answer, never the receipt', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/app/api/ops/tracking/route.ts'), 'utf8'));
    expect(src).toContain('returnCounted: _returnReceipt != null,');
  });
});
