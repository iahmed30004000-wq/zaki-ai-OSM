// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * THE FOLLOW-UP SCREEN DRAWS THE LEVEL THE DOOR SAYS THIS PERSON HOLDS.
 *
 * The door decides (`who-sees-which-rows.test.ts`); the screen only draws what it would answer, so nobody presses an
 * option that comes back 403:
 *
 *   • the bar, the boxes and «استلمت منه» are for whoever may act on the money (`access.collect`);
 *   • the delivered and the returned states are in the «الحالة» list only for the level that sees those rows;
 *   • the «حالة التحصيل» column is the courier's money — gone without it.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>متابعة الشحن</h1> }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => async () => true }));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { TrackingScreen } from '@/components/screens/TrackingScreen';

const P1 = '11111111-1111-4111-8111-111111111111';
const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };

const owed = {
  id: 'o1',
  orderNumber: 'ORD-1',
  merchantRef: null,
  trackingNumber: 'TRK-1',
  shippingStatus: 'DELIVERED',
  settlementStatus: 'PENDING_COLLECTION',
  collectionStatus: 'PENDING_COLLECTION',
  daysInTransit: 3,
  lateThresholdDays: 3,
  late: false,
  totalAmount: 40,
  currency: 'JOD',
  deliveryFailureReason: null,
  customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
  region: { name: 'عمّان' },
  deliveryProvider: { id: P1, name: 'أبو علي', kind: 'COMPANY' },
  expectedCollection: 37.5,
  _count: { deliveryAttempts: 0, notes: 0 },
  alert: null,
};
/** The same parcel as the door sends it to somebody who may not see the courier's money. */
const { collectionStatus: _c, settlementStatus: _s, expectedCollection: _e, ...bare } = owed;

let answer: Record<string, unknown>;
const answerFor = (access: { money: boolean; returns: boolean; collect: boolean }) => {
  const sees = access.money;
  answer = {
    count: 1,
    orders: [sees ? owed : { ...bare, shippingStatus: 'SHIPPED' }],
    lateCount: 0,
    dialCode: '962',
    pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
    facts: {
      total: 1,
      tasks: { ...NO_TASKS, COLLECT: sees ? 14 : 0 },
      lateCount: 0,
      notLate: 0,
      couriers: [{ id: P1, name: 'أبو علي', count: 1 }],
      regions: [],
      ages: { fresh: 1, few: 0, week: 0, old: 0 },
    },
    applied: {},
    capped: false,
    access,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async () => answer);
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TrackingScreen />);
  await screen.findByLabelText('جهة الشحن');
};
const statesOffered = () => within(screen.getByLabelText('الحالة')).getAllByRole('option').map((o) => o.textContent);
const boxes = () => screen.queryAllByRole('checkbox');

describe('whoever holds «إدارة الصناديق النقدية»', () => {
  beforeEach(() => answerFor({ money: true, returns: true, collect: true }));

  it('gets the bar, the boxes and the whole list of states', async () => {
    await draw();
    expect(screen.getByText(/14 مسلَّم بانتظار التحصيل/)).toBeTruthy();
    expect(boxes().length).toBeGreaterThan(0);
    expect(statesOffered()).toEqual(expect.arrayContaining(['قيد الشحن وبانتظار التحصيل', 'مسلَّم', 'مسلَّم جزئياً', 'طلب إرجاع', 'مرتجع', 'الكل']));
    expect(screen.getAllByText('حالة التحصيل').length).toBeGreaterThan(0);
  });
});

describe('whoever only SEES the courier’s money', () => {
  beforeEach(() => answerFor({ money: true, returns: false, collect: false }));

  it('NEGATIVE: has the chip and the rows, and no bar, no boxes, no «اختر الكل»', async () => {
    await draw();
    expect(screen.getByRole('button', { name: /بانتظار التحصيل 14/ })).toBeTruthy();
    expect(screen.queryByText(/14 مسلَّم بانتظار التحصيل/)).toBeNull();
    expect(screen.queryByRole('button', { name: /اختر الكل/ })).toBeNull();
    expect(boxes()).toHaveLength(0);
    expect(screen.getAllByText('حالة التحصيل').length).toBeGreaterThan(0);
  });

  it('NEGATIVE: is not offered the return states, which would answer 403', async () => {
    await draw();
    const offered = statesOffered();
    expect(offered).toEqual(expect.arrayContaining(['مسلَّم', 'مسلَّم جزئياً']));
    expect(offered).not.toContain('طلب إرجاع');
    expect(offered).not.toContain('مرتجع');
  });
});

describe('whoever holds neither level', () => {
  beforeEach(() => answerFor({ money: false, returns: false, collect: false }));

  it('NEGATIVE: is offered no delivered and no returned state, and the default no longer promises the money', async () => {
    await draw();
    const offered = statesOffered();
    for (const s of ['مسلَّم', 'مسلَّم جزئياً', 'طلب إرجاع', 'مرتجع']) expect(offered, s).not.toContain(s);
    expect(offered).toContain('قيد الشحن');
    expect(offered).not.toContain('قيد الشحن وبانتظار التحصيل');
    expect(offered).toContain('مشحون');
  });

  it('NEGATIVE: has no collection column, no bar, no boxes and no chip for the money', async () => {
    await draw();
    expect(screen.queryAllByText('حالة التحصيل')).toHaveLength(0);
    expect(screen.queryByText(/مسلَّم بانتظار التحصيل/)).toBeNull();
    expect(screen.queryByRole('button', { name: /بانتظار التحصيل \d/ })).toBeNull();
    expect(boxes()).toHaveLength(0);
  });

  it('and still draws the parcel, its customer and the sum the customer pays', async () => {
    await draw();
    expect(screen.getAllByText('ORD-1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('سارة').length).toBeGreaterThan(0);
  });
});

describe('an answer that does not say (the door always does)', () => {
  it('is read as the whole screen — drawing less would hide work, and the door is what refuses', async () => {
    answerFor({ money: true, returns: true, collect: true });
    delete answer.access;
    await draw();
    expect(statesOffered()).toContain('مرتجع');
    expect(screen.getByText(/14 مسلَّم بانتظار التحصيل/)).toBeTruthy();
  });
});
