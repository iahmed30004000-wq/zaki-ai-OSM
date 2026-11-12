// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «أقفل القديمة بلا باركود» ON THE TRACKING SCREEN (12/11) — the button is the owner's, and sits where the old money is.
 *
 * The server says who holds the key (`acts.closeLegacy`, from `ops.close_legacy`); the screen only draws what it would answer. The
 * button lives in the strip «N مسلَّم بانتظار التحصيل» — the place the old orders pile up — so it is drawn only where that strip is.
 * A press opens the dialog; a success shows the door's sentence and reads the list again, which is the proof the orders left it.
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
// The dialog has its own file; here only the screen's side of it: when it opens, and what a success does.
vi.mock('@/components/screens/tracking/CloseLegacyDialog', () => ({
  CloseLegacyDialog: ({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) => (
    <div role="dialog" aria-label="نافذة القفل">
      <button onClick={() => onDone('اتقفل 7 طلب كمحصَّل — بلا أي حركة مصاري')}>تمّ</button>
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
  trackingNumber: null,
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

const answerFor = (over: { collect?: boolean; acts?: Record<string, boolean> | undefined }) => ({
  count: 1,
  orders: [owed],
  lateCount: 0,
  dialCode: '962',
  pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
  facts: {
    total: 1,
    tasks: { ...NO_TASKS, COLLECT: 1274 },
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
beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async () => answer);
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TrackingScreen />);
  await screen.findByLabelText('جهة الشحن');
};
const BUTTON = 'أقفل القديمة بلا باركود…';
const ACTS = { deliver: true, transfer: true, writeOff: true };

describe('who gets the button', () => {
  it('the holder of the key, in the strip «مسلَّم بانتظار التحصيل»', async () => {
    answer = answerFor({ acts: { ...ACTS, closeLegacy: true } });
    await draw();
    expect(screen.getByText(/1274 مسلَّم بانتظار التحصيل/)).toBeTruthy();
    expect(screen.getByRole('button', { name: BUTTON })).toBeTruthy();
  });

  it('NEGATIVE: someone who does not hold the key never sees it', async () => {
    answer = answerFor({ acts: { ...ACTS, closeLegacy: false } });
    await draw();
    expect(screen.getByText(/1274 مسلَّم بانتظار التحصيل/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('NEGATIVE: an answer that does not name the key (an older server) is read as «no» — a button for a door nobody said they hold is not drawn', async () => {
    answer = answerFor({ acts: ACTS });
    await draw();
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
    cleanup();
    answer = answerFor({ acts: undefined });
    await draw();
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('it lives in the money strip: without the right to act on the courier’s money there is no strip and no button', async () => {
    answer = answerFor({ collect: false, acts: { ...ACTS, closeLegacy: true } });
    await draw();
    expect(screen.queryByText(/مسلَّم بانتظار التحصيل/)).toBeNull();
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('it steps aside once parcels are ticked for «استلمت منه» (the strip is then about those)', async () => {
    answer = answerFor({ acts: { ...ACTS, closeLegacy: true } });
    await draw();
    expect(screen.getByRole('button', { name: BUTTON })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await waitFor(() => expect(screen.queryByRole('button', { name: BUTTON })).toBeNull());
  });
});

describe('the press', () => {
  beforeEach(() => {
    answer = answerFor({ acts: { ...ACTS, closeLegacy: true } });
  });

  it('opens the dialog, and closing it leaves the screen as it was', async () => {
    await draw();
    expect(screen.queryByRole('dialog', { name: 'نافذة القفل' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    expect(screen.getByRole('dialog', { name: 'نافذة القفل' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'إغلاق النافذة' }));
    expect(screen.queryByRole('dialog', { name: 'نافذة القفل' })).toBeNull();
  });

  it('a success shows the door’s sentence, closes the dialog and reads the list AGAIN — the orders are gone from it only if the server says so', async () => {
    await draw();
    const before = api.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    fireEvent.click(screen.getByRole('button', { name: 'تمّ' }));

    expect(await screen.findByText('اتقفل 7 طلب كمحصَّل — بلا أي حركة مصاري')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'نافذة القفل' })).toBeNull();
    await waitFor(() => expect(api.mock.calls.length).toBeGreaterThan(before));
  });
});
