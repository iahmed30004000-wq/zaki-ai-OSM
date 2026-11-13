// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «تراجع عن التسليم» ON THE TRACKING SCREEN (13/11) — the button is the owner's, and sits on a parcel that was recorded delivered.
 *
 *   «هاد الطلب بالغلط حطيتو تم والشركة بتقول تم ارجاعها لازم يكون في زر تراجع مش محدود بمدة زمنية ويكون عليه صلاحية للمالك متاح» (the owner)
 *
 * The server says who holds the key (`acts.undoDelivery`, from `ops.undo_delivery`); the screen only draws what it would answer. The button
 * is on the row of a parcel whose state is DELIVERED or PARTIALLY_DELIVERED and nowhere else — a button that always refuses is a broken one.
 * A press opens the dialog for THAT parcel; a success shows the door's sentence and reads the list again, which is the proof the parcel is no
 * longer delivered only if the server says so. Phone and desk draw the same press: a 44px target on both.
 */

const { api, phone } = vi.hoisted(() => ({ api: vi.fn(), phone: { value: false } }));
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
// The dialog has its own file; here only the screen's side of it: which parcel it opens for, and what a success does.
vi.mock('@/components/screens/tracking/UndoDeliveryDialog', () => ({
  UndoDeliveryDialog: ({ order, onClose, onDone }: { order: { id: string; orderNumber: string }; onClose: () => void; onDone: (m: string) => void }) => (
    <div role="dialog" aria-label="نافذة التراجع">
      <span data-testid="for">{order.orderNumber}</span>
      <button onClick={() => onDone(`اتراجع عن تسليم الطلب ${order.orderNumber} — رجع «مشحون»`)}>تمّ</button>
      <button onClick={onClose}>إغلاق النافذة</button>
    </div>
  ),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));

import { TrackingScreen } from '@/components/screens/TrackingScreen';

configure({ asyncUtilTimeout: 8000 });
// Each test draws the whole screen twice over (the desk's table and the phone's cards) in jsdom: on a loaded machine that is slow, not wrong.
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
const BUTTON = 'تراجع عن التسليم…';
const buttons = () => screen.queryAllByRole('button', { name: BUTTON });

const ALL_STATES = ['NOT_READY', 'READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'];

describe('who gets the button — and where', () => {
  it('the holder of the key, on a delivered parcel and on a part-delivered one', async () => {
    answer = answerFor([parcel('1', 'DELIVERED'), parcel('2', 'PARTIALLY_DELIVERED')], { ...ACTS, undoDelivery: true });
    await draw();
    // the desk's table and the phone's cards both draw each row
    expect(buttons()).toHaveLength(4);
  });

  it('NEGATIVE: on a parcel that is not recorded delivered there is no button — every other state', async () => {
    answer = answerFor(ALL_STATES.map((s, i) => parcel(String(i + 1), s)), { ...ACTS, undoDelivery: true });
    await draw();
    expect(buttons()).toHaveLength(0);
  });

  it('only the delivered rows of a mixed page carry it', async () => {
    answer = answerFor([parcel('1', 'SHIPPED'), parcel('2', 'DELIVERED'), parcel('3', 'RETURNED'), parcel('4', 'PARTIALLY_DELIVERED'), parcel('5', 'OUT_FOR_DELIVERY')], { ...ACTS, undoDelivery: true });
    await draw();
    expect(buttons()).toHaveLength(4); // two rows, drawn twice
  });

  it('NEGATIVE: someone who does not hold the key never sees it — even on a delivered parcel, even with every other act', async () => {
    answer = answerFor([parcel('1', 'DELIVERED'), parcel('2', 'PARTIALLY_DELIVERED')], { ...ACTS, closeLegacy: true, undoDelivery: false });
    await draw();
    expect(buttons()).toHaveLength(0);
  });

  it('NEGATIVE: an answer that does not name the key (an older server) is read as «no» — a button for a door nobody said they hold is not drawn', async () => {
    answer = answerFor([parcel('1', 'DELIVERED')], ACTS);
    await draw();
    expect(buttons()).toHaveLength(0);
    cleanup();
    answer = answerFor([parcel('1', 'DELIVERED')], undefined);
    await draw();
    expect(buttons()).toHaveLength(0);
  });

  it('the key says nothing about the other acts: with it and nothing else, «استلم» and «تحويل» are those of their own keys', async () => {
    answer = answerFor([parcel('1', 'DELIVERED')], { deliver: false, transfer: false, writeOff: false, closeLegacy: false, undoDelivery: true });
    await draw();
    expect(buttons().length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: 'تحويل' })).toHaveLength(0);
  });
});

describe('the press', () => {
  beforeEach(() => {
    answer = answerFor([parcel('1', 'SHIPPED'), parcel('2', 'DELIVERED')], { ...ACTS, undoDelivery: true });
  });

  it('opens the dialog for THAT parcel, and closing it leaves the screen as it was', async () => {
    await draw();
    expect(screen.queryByRole('dialog', { name: 'نافذة التراجع' })).toBeNull();
    fireEvent.click(buttons()[0]);
    expect(screen.getByRole('dialog', { name: 'نافذة التراجع' })).toBeTruthy();
    expect(screen.getByTestId('for').textContent).toBe('ORD-2');

    fireEvent.click(screen.getByRole('button', { name: 'إغلاق النافذة' }));
    expect(screen.queryByRole('dialog', { name: 'نافذة التراجع' })).toBeNull();
  });

  it('a success shows the door’s sentence, closes the dialog and reads the list AGAIN', async () => {
    await draw();
    const before = api.mock.calls.length;
    fireEvent.click(buttons()[0]);
    fireEvent.click(screen.getByRole('button', { name: 'تمّ' }));

    expect(await screen.findByText('اتراجع عن تسليم الطلب ORD-2 — رجع «مشحون»')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'نافذة التراجع' })).toBeNull();
    await waitFor(() => expect(api.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('a phone and a desk press the same button', () => {
  it('on a desk it is the quiet link of «تحويل» beside it — the very same classes, 44px under a finger', async () => {
    phone.value = false;
    answer = answerFor([parcel('2', 'DELIVERED')], { ...ACTS, undoDelivery: true });
    await draw();
    const undo = buttons()[0];
    const transfer = screen.getAllByRole('button', { name: 'تحويل' })[0];
    expect(undo.className).toBe(transfer.className);
    expect(undo.className).toContain('min-h-11');
    expect(undo.className).toContain('md:min-h-0');
    expect(undo.className).not.toContain('rounded-lg border');
  });

  it('on a phone it is a bordered target of its own, 44px — never a bare word a thumb can miss', async () => {
    phone.value = true;
    answer = answerFor([parcel('2', 'DELIVERED')], { ...ACTS, undoDelivery: true });
    await draw();
    const undo = buttons()[0];
    expect(undo.className).toContain('min-h-11');
    expect(undo.className).toContain('rounded-lg border');
    expect(undo.className).toContain('flex-1');
    // the same classes as «تحويل» on the phone: one family of quiet targets at the foot of the card
    expect(undo.className).toBe(screen.getAllByRole('button', { name: 'تحويل' })[0].className);
  });

  it('it says in a tooltip what it does, in Arabic', async () => {
    answer = answerFor([parcel('2', 'DELIVERED')], { ...ACTS, undoDelivery: true });
    await draw();
    expect(buttons()[0].getAttribute('title')).toBe('رجّع الطلب لحالتو قبل التسليم — لما انسجّل تسليمو بالغلط');
  });
});

describe('the button is where the door can answer — read from the source, so the two cannot drift', () => {
  const screenSrc = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/TrackingScreen.tsx'), 'utf8'));

  it('appears only for the server’s word, and only on the two delivered states', () => {
    expect(screenSrc).toContain("{acts.undoDelivery && (o.shippingStatus === 'DELIVERED' || o.shippingStatus === 'PARTIALLY_DELIVERED') && (");
    expect(screenSrc).toContain('setUndoFor(o)');
  });

  it('and an answer that does not name the key is read as «no» (the default for the key is false)', () => {
    expect(screenSrc).toMatch(/closeLegacy: false, undoDelivery: false \}/);
  });

  it('and those two states are the ones the follow-up list calls delivered', () => {
    const list = stripComments(readFileSync(join(process.cwd(), 'src/app/api/ops/tracking/route.ts'), 'utf8'));
    expect(list).toContain("const AWAITING_COLLECTION = ['DELIVERED', 'PARTIALLY_DELIVERED']");
  });
});
