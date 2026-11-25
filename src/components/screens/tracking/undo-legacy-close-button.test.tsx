// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «تراجع عن إقفال القديمة» ON THE TRACKING SCREEN (25/11) — the owner's button, on a parcel «إقفال القديمة» made «مسوّى» with no money.
 * The close's own key (acts.closeLegacy), and the server's word that the close's mark is still live on THIS parcel (legacyClosed):
 * only an explicit «yes» on a SETTLED parcel draws it. The dialog is the same one, asked about the close (kind legacy).
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
      <button onClick={() => onDone(`رجعت تسوية الطلب ${order.orderNumber} لـ«لم يُحصَّل»`)}>تمّ</button>
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
const BUTTON = 'تراجع عن الإقفال…';
const buttons = () => screen.queryAllByRole('button', { name: BUTTON });


describe('who gets «تراجع عن الإقفال» — and where', () => {
  const closed = (id: string, over: Record<string, unknown> = {}) =>
    parcel(id, 'DELIVERED', { settlementStatus: 'SETTLED', collectionStatus: 'SETTLED', legacyClosed: true, ...over });

  it('the holder of the close’s key, on a SETTLED parcel whose close is still live (desk table and phone cards both draw the row)', async () => {
    answer = answerFor([closed('1')], { ...ACTS, closeLegacy: true });
    await draw();
    expect(buttons()).toHaveLength(2);
  });

  it('NEGATIVE: a settled parcel the close did not settle, or whose answer does not say, has no button', async () => {
    answer = answerFor([closed('1', { legacyClosed: false }), closed('2', { legacyClosed: undefined })], { ...ACTS, closeLegacy: true });
    await draw();
    expect(buttons()).toHaveLength(0);
  });

  it('NEGATIVE: a parcel no longer SETTLED (already taken back) has no button, whatever the flag says', async () => {
    answer = answerFor([closed('1', { settlementStatus: 'PENDING_COLLECTION', collectionStatus: 'PENDING_COLLECTION' })], { ...ACTS, closeLegacy: true });
    await draw();
    expect(buttons()).toHaveLength(0);
  });

  it('NEGATIVE: someone without the close’s key never sees it — even holding «تراجع عن التسليم»; an answer that does not name the key is «no»', async () => {
    answer = answerFor([closed('1')], { ...ACTS, closeLegacy: false, undoDelivery: true });
    await draw();
    expect(buttons()).toHaveLength(0);
    cleanup();
    answer = answerFor([closed('1')], { deliver: true, transfer: true, writeOff: true });
    await draw();
    expect(buttons()).toHaveLength(0);
  });
});

describe('the press', () => {
  it('opens the dialog for THAT parcel, asked about the CLOSE; a success says the door’s sentence and reads the list again', async () => {
    answer = answerFor([parcel('1', 'DELIVERED'), parcel('2', 'DELIVERED', { settlementStatus: 'SETTLED', legacyClosed: true })], { ...ACTS, closeLegacy: true });
    await draw();
    fireEvent.click(buttons()[0]);
    expect(screen.getByTestId('for').textContent).toBe('ORD-2');
    expect(screen.getByTestId('kind').textContent).toBe('legacy');
    const before = api.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'تمّ' }));
    expect(await screen.findByText('رجعت تسوية الطلب ORD-2 لـ«لم يُحصَّل»')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'نافذة التراجع' })).toBeNull();
    await waitFor(() => expect(api.mock.calls.length).toBeGreaterThan(before));
  });

  it('on a desk it is the same quiet link as «تحويل», and it says what it does in Arabic', async () => {
    answer = answerFor([parcel('2', 'DELIVERED', { settlementStatus: 'SETTLED', legacyClosed: true })], { ...ACTS, closeLegacy: true });
    await draw();
    const b = buttons()[0];
    expect(b.className).toBe(screen.getAllByRole('button', { name: 'تحويل' })[0].className);
    expect(b.getAttribute('title')).toBe('رجّع تسوية الطلب لحالتها قبل «إقفال القديمة» — لما الطرد رجع فعلاً');
  });
});

describe('read from the sources, so the screen and the list cannot drift', () => {
  it('the screen draws it for the close’s key, the server’s flag and a SETTLED parcel only', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/TrackingScreen.tsx'), 'utf8'));
    expect(src).toContain("{acts.closeLegacy && o.legacyClosed === true && o.settlementStatus === 'SETTLED' && (");
  });

  it('the list asks for the mark only for whoever holds the close’s key, only over the page’s SETTLED parcels', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/app/api/ops/tracking/route.ts'), 'utf8'));
    expect(src).toContain("const settledIds = can(user, 'ops.close_legacy') ? orders.filter((o) => o.settlementStatus === 'SETTLED').map((o) => o.id) : [];");
    expect(src).toContain('action: LEGACY_CLOSE_ACTION');
    expect(src).toContain('legacyClosed: legacyClosed.has(o.id),');
  });
});
