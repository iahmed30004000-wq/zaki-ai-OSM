// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «أقفل المحدّد بلا حركة مال» ON THE TRACKING SCREEN (13/11) — the button is the owner's, and it is for the orders he ticked.
 *
 *   «اقدر اعمل هالحركة هاي لاي طلب حتى لو عليه باركود، بس بدي الزر هاد متاح للمالك فقط» (the owner)
 *
 * The server says who holds the key (`acts.closeLegacy`, from `ops.close_legacy`, which nobody but the owner holds by default); the
 * screen only draws what it would answer. The button appears only once something is ticked — on a desk in the strip, on a phone in the
 * bar at the thumb — and it never stands beside «أقفل القديمة بلا باركود…», which is for when nothing is ticked.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>متابعة الشحن</h1> }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => async () => true, useTell: () => async () => undefined }));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('@/components/screens/tracking/CloseLegacyDialog', () => ({ CloseLegacyDialog: () => null }));
// The dialog has its own file; here only the screen's side of it: what it is given, when it opens, and what a success does.
vi.mock('@/components/screens/tracking/ClosePickedDialog', () => ({
  ClosePickedDialog: ({ orders, onClose, onDone }: { orders: { id: string; orderNumber: string }[]; onClose: () => void; onDone: (m: string) => void }) => (
    <div role="dialog" aria-label="نافذة قفل المحدّد">
      <span data-testid="given">{orders.map((o) => o.orderNumber).join(',')}</span>
      <button onClick={() => onDone('اتقفل 1 طلب كمحصَّل — بلا أي حركة مصاري')}>تمّ</button>
      <button onClick={onClose}>إغلاق النافذة</button>
    </div>
  ),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { TrackingScreen } from '@/components/screens/TrackingScreen';

const P1 = '11111111-1111-4111-8111-111111111111';
const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };

const owed = {
  id: 'o1',
  orderNumber: 'ORD-1',
  merchantRef: null,
  // The barcode is NOT what decides: the owner may close an order that carries one.
  trackingNumber: 'BP-1',
  shippingStatus: 'DELIVERED',
  settlementStatus: 'PENDING',
  collectionStatus: 'PENDING',
  daysInTransit: 40,
  lateThresholdDays: 3,
  late: false,
  totalAmount: 40,
  currency: 'USD',
  deliveryFailureReason: null,
  customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
  region: { name: 'عمّان' },
  deliveryProvider: { id: P1, name: 'أبو علي', kind: 'COMPANY' },
  expectedCollection: 37.5,
  _count: { deliveryAttempts: 0, notes: 0 },
  alert: null,
};

const answerFor = (over: { collect?: boolean; acts?: Record<string, boolean> | undefined; orders?: (typeof owed)[] }) => ({
  count: 1,
  orders: over.orders ?? [owed],
  lateCount: 0,
  dialCode: '962',
  pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
  facts: {
    total: 1,
    tasks: { ...NO_TASKS, COLLECT: 707 },
    lateCount: 0,
    notLate: 0,
    couriers: [{ id: P1, name: 'أبو علي', count: 1 }],
    regions: [],
    ages: { fresh: 0, few: 0, week: 0, old: 1 },
  },
  applied: {},
  capped: false,
  access: { money: true, returns: true, collect: over.collect ?? true },
  ...(over.acts === undefined ? {} : { acts: over.acts }),
});

let answer: Record<string, unknown>;
const realMatchMedia = window.matchMedia;
beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async () => answer);
});
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

/** A phone-width screen: the hook the bar reads says «below md». */
const onAPhone = () => {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};

const draw = async () => {
  render(<TrackingScreen />);
  await screen.findByLabelText('جهة الشحن');
};
const PICKED = 'أقفل المحدّد بلا حركة مال…';
const OLD = 'أقفل القديمة بلا باركود…';
const ACTS = { deliver: true, transfer: true, writeOff: true };
const tickFirst = () => fireEvent.click(screen.getAllByRole('checkbox')[0]);

describe('who gets the button — the owner, and only once something is ticked', () => {
  it('the holder of the key sees it after ticking an order (the desk: in the strip) — and not before', async () => {
    answer = answerFor({ acts: { ...ACTS, closeLegacy: true } });
    await draw();
    expect(screen.queryByRole('button', { name: PICKED })).toBeNull();
    tickFirst();
    expect(await screen.findByRole('button', { name: PICKED })).toBeTruthy();
  });

  it('NEGATIVE — THE OWNER ONLY: someone who does not hold the key never sees it, ticked or not', async () => {
    answer = answerFor({ acts: { ...ACTS, closeLegacy: false } });
    await draw();
    tickFirst();
    expect(await screen.findByText(/مختار 1 طلب/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: PICKED })).toBeNull();
    // «استلمت منه» (the courier's money) is theirs as always.
    expect(screen.getAllByRole('button', { name: /استلمت منه/ }).length).toBeGreaterThan(0);
  });

  it('NEGATIVE: an answer that does not name the key (an older server) is read as «no» — a button for a door nobody said they hold is not drawn', async () => {
    answer = answerFor({ acts: ACTS });
    await draw();
    tickFirst();
    expect(await screen.findByText(/مختار 1 طلب/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: PICKED })).toBeNull();
    cleanup();
    answer = answerFor({ acts: undefined });
    await draw();
    tickFirst();
    expect(await screen.findByText(/مختار 1 طلب/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: PICKED })).toBeNull();
  });

  it('the two buttons never stand together: «أقفل القديمة…» is for when nothing is ticked, this one for when something is', async () => {
    answer = answerFor({ acts: { ...ACTS, closeLegacy: true } });
    await draw();
    expect(screen.getByRole('button', { name: OLD })).toBeTruthy();
    expect(screen.queryByRole('button', { name: PICKED })).toBeNull();
    tickFirst();
    await waitFor(() => expect(screen.queryByRole('button', { name: OLD })).toBeNull());
    expect(screen.getByRole('button', { name: PICKED })).toBeTruthy();
    // Un-ticking gives the old one back.
    tickFirst();
    await waitFor(() => expect(screen.queryByRole('button', { name: PICKED })).toBeNull());
    expect(screen.getByRole('button', { name: OLD })).toBeTruthy();
  });

  it('on a PHONE it is in the bar at the thumb — exactly one, beside «استلمت منه»', async () => {
    onAPhone();
    answer = answerFor({ acts: { ...ACTS, closeLegacy: true } });
    await draw();
    tickFirst();
    expect(await screen.findAllByRole('button', { name: PICKED })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /استلمت منه/ })).toHaveLength(1);
  });

  it('NEGATIVE: on a phone, without the key, the bar carries «استلمت منه» alone', async () => {
    onAPhone();
    answer = answerFor({ acts: { ...ACTS, closeLegacy: false } });
    await draw();
    tickFirst();
    expect(await screen.findAllByRole('button', { name: /استلمت منه/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: PICKED })).toBeNull();
  });
});

describe('the press', () => {
  beforeEach(() => {
    answer = answerFor({ acts: { ...ACTS, closeLegacy: true } });
  });

  it('opens the dialog with the ticked orders — an order WITH a barcode is ticked and given like any other', async () => {
    await draw();
    tickFirst();
    expect(screen.queryByRole('dialog', { name: 'نافذة قفل المحدّد' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: PICKED }));
    expect(screen.getByRole('dialog', { name: 'نافذة قفل المحدّد' })).toBeTruthy();
    expect(screen.getByTestId('given').textContent).toBe('ORD-1');
  });

  it('is given ONLY the ticked orders, not every order of the page — two rows, one ticked', async () => {
    answer = answerFor({ acts: { ...ACTS, closeLegacy: true }, orders: [owed, { ...owed, id: 'o2', orderNumber: 'ORD-2', trackingNumber: null }] });
    await draw();
    // The screen draws each row twice (the table and the phone’s cards), so two rows are four boxes: the table’s first.
    const boxes = screen.getAllByRole('checkbox', { name: 'اختر السجل' });
    expect(boxes).toHaveLength(4);
    // The second row only.
    fireEvent.click(boxes[1]);
    fireEvent.click(await screen.findByRole('button', { name: PICKED }));
    expect(screen.getByTestId('given').textContent).toBe('ORD-2');
  });

  it('closing it leaves the screen as it was — the order is still ticked', async () => {
    await draw();
    tickFirst();
    fireEvent.click(await screen.findByRole('button', { name: PICKED }));
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق النافذة' }));
    expect(screen.queryByRole('dialog', { name: 'نافذة قفل المحدّد' })).toBeNull();
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: PICKED })).toBeTruthy();
  });

  it('a success shows the door’s sentence, closes the dialog, puts the ticks away and reads the list AGAIN — the order is gone from it only if the server says so', async () => {
    await draw();
    tickFirst();
    const before = api.mock.calls.length;
    fireEvent.click(await screen.findByRole('button', { name: PICKED }));
    fireEvent.click(screen.getByRole('button', { name: 'تمّ' }));

    expect(await screen.findByText('اتقفل 1 طلب كمحصَّل — بلا أي حركة مصاري')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'نافذة قفل المحدّد' })).toBeNull();
    await waitFor(() => expect(api.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false));
    expect(screen.queryByRole('button', { name: PICKED })).toBeNull();
  });
});
