// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * THE OPERATIONS BUTTONS ARE DRAWN FOR WHO THE DOOR WILL ANSWER (perm-plan PR-8).
 *
 *   · «استلم» / «رفض / ملغى» / «استلم جزءاً» ask `ops.deliver`, «تحويل» asks `ops.transfer`, «أغلقه كخسارة» asks `ops.write_off` —
 *     the server says which the reader holds (`acts`) on the tracking list;
 *   · the courier-fee tick-box of the returns dialog asks `ops.return_fee` (`mayChargeFee`) — receiving the return stays;
 *   · the PREPARATION screen draws a waybill-print button for `ops.labels` (D8: the warehouse holds that key and no screen
 *     that prints), and the paper-size picker beside it — never for a reader without the key, and a failed print is SAID
 *     in a dialog, never put in the screen’s `error` (which would replace the whole screen).
 *
 * Each case has its NEGATIVE: the same screen, the same row, the key absent. An answer that does not say is read as «yes»
 * (an older server): the door itself still asks.
 */

const { api, apiFetch, user, printed, told } = vi.hoisted(() => ({
  api: vi.fn(),
  apiFetch: vi.fn(),
  user: { current: { id: 'u1', name: 'سارة', role: 'CUSTOM', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
  printed: { calls: [] as unknown[][], outcome: { count: 1, refused: [] as Array<{ orderNumber: string; reason: string }>, opened: true } },
  told: { calls: [] as unknown[] },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current, t: { cancel: 'إلغاء' }, locale: 'ar', isRtl: true }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), warn: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useAsk: () => async () => null,
  useConfirm: () => async () => true,
  useTell: () => (o: unknown) => {
    told.calls.push(o);
    return Promise.resolve();
  },
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null, ScanSheet: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ChangeRequestReview', () => ({ ChangeRequestReview: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/screens/ops/PickingAssistant', () => ({ PickingAssistant: () => null }));
vi.mock('@/components/labels/LabelSize', () => ({
  useLabelSize: () => ({ dims: { width: 100, height: 150 } }),
  LabelSizePicker: () => <select aria-label="مقاس البوليصة" />,
}));
vi.mock('@/components/labels/openWaybills', () => ({
  BLOCKED_WAYBILLS: 'المتصفح منع فتح نافذة البوالص.',
  describeRefused: (r: Array<{ orderNumber: string }>) => r.map((x) => x.orderNumber).join('، '),
  openWaybills: async (...a: unknown[]) => {
    printed.calls.push(a);
    return printed.outcome;
  },
  WaybillError: class extends Error {},
}));

import { TrackingScreen } from './TrackingScreen';
import { ReturnsScreen } from './ReturnsScreen';
import { PreparationScreen } from './PreparationScreen';

const holding = (...keys: string[]) => {
  user.current = { id: 'u1', name: 'سارة', role: 'CUSTOM', permissions: keys, status: 'ACTIVE' };
};

beforeEach(() => {
  vi.clearAllMocks();
  printed.calls = [];
  printed.outcome = { count: 1, refused: [], opened: true };
  told.calls = [];
  holding();
});
afterEach(cleanup);

// ───────────────────────────── the tracking list ─────────────────────────────

const parcel = (id: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber: `ORD-${id}`, merchantRef: null, trackingNumber: `TRK-${id}`, shippingStatus: 'SHIPPED',
  collectionStatus: 'NOT_APPLICABLE', settlementStatus: 'NOT_APPLICABLE', daysInTransit: 1, lateThresholdDays: 3, late: false,
  totalAmount: 40, currency: 'JOD', deliveryFailureReason: null, customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
  region: { name: 'عمّان' }, deliveryProvider: { id: 'dp1', name: 'أبو علي', kind: 'COMPANY' }, expectedCollection: 37.5,
  _count: { deliveryAttempts: 0, notes: 0 }, alert: null, ...over,
});
const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };
const trackingAnswer = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  count: rows.length, orders: rows, lateCount: 0, dialCode: '962',
  pagination: { total: rows.length, page: 1, limit: 25, totalPages: 1 },
  facts: { total: rows.length, tasks: NO_TASKS, lateCount: 0, couriers: [], regions: [], ages: { fresh: 0, few: 0, week: 0, old: 0 } },
  applied: {}, capped: false, ...extra,
});
const drawTracking = async (rows: unknown[], extra: Record<string, unknown> = {}) => {
  api.mockResolvedValue(trackingAnswer(rows, extra));
  render(<TrackingScreen />);
  await screen.findAllByText(/ORD-/);
};
// The list draws each parcel twice (a table row and a phone card), so a button is looked for by NAME, never counted.
const some = (name: string | RegExp) => screen.queryAllByRole('button', { name }).length > 0;
const ALL = { deliver: true, transfer: true, writeOff: true };

describe('the tracking list', () => {
  it('draws the outcome buttons, the transfer and the write-off when the server says the reader holds all three', async () => {
    await drawTracking([parcel('A'), parcel('B', { shippingStatus: 'RETURN_REQUESTED' })], { acts: ALL });
    expect(some(/^استلم$/)).toBe(true);
    expect(some(/رفض \/ ملغى/)).toBe(true);
    expect(some('استلم جزءاً')).toBe(true);
    expect(screen.getAllByRole('button', { name: 'تحويل' }).length).toBeGreaterThanOrEqual(2);
    expect(some(/أغلقه كخسارة/)).toBe(true);
  });

  it('an answer that does not say is read as «all» (an older server): the door itself still asks', async () => {
    await drawTracking([parcel('A'), parcel('B', { shippingStatus: 'RETURN_REQUESTED' })]);
    expect(screen.getAllByRole('button', { name: 'تحويل' }).length).toBeGreaterThanOrEqual(2);
    expect(some(/أغلقه كخسارة/)).toBe(true);
    expect(some(/^استلم$/)).toBe(true);
  });

  it('NEGATIVE: without ops.deliver the three outcome buttons are gone — the transfer and the note stay', async () => {
    await drawTracking([parcel('A')], { acts: { ...ALL, deliver: false } });
    expect(some(/^استلم$/)).toBe(false);
    expect(some(/رفض \/ ملغى/)).toBe(false);
    expect(some('استلم جزءاً')).toBe(false);
    expect(some('تحويل')).toBe(true);
    expect(some(/ملاحظة/)).toBe(true);
  });

  it('NEGATIVE: without ops.transfer «تحويل» is gone — the outcome buttons stay', async () => {
    await drawTracking([parcel('A')], { acts: { ...ALL, transfer: false } });
    expect(some('تحويل')).toBe(false);
    expect(some(/^استلم$/)).toBe(true);
  });

  it('NEGATIVE: without ops.write_off «أغلقه كخسارة» is gone on the parcel that would show it', async () => {
    await drawTracking([parcel('B', { shippingStatus: 'RETURN_REQUESTED' })], { acts: { ...ALL, writeOff: false } });
    expect(some(/أغلقه كخسارة/)).toBe(false);
    expect(some('تحويل')).toBe(true);
  });

  it('the door is where the keys are counted: the list route says which acts, from the three keys', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/app/api/ops/tracking/route.ts'), 'utf8'));
    expect(src).toContain("deliver: can(user, 'ops.deliver')");
    expect(src).toContain("transfer: can(user, 'ops.transfer')");
    expect(src).toContain("writeOff: can(user, 'ops.write_off')");
  });
});

// ───────────────────────────── the returns desk ─────────────────────────────

const RETURN_ROW = {
  id: 'o1', orderNumber: 'SY-2026-0148', merchantRef: null, trackingNumber: 'TRK-1', shippingStatus: 'RETURN_REQUESTED',
  settlementStatus: 'PENDING_COLLECTION', returnReason: null, expectedQty: 3, customer: { fullName: 'سارة' }, region: { name: 'دمشق' },
  deliveryProvider: { name: 'ناقل' }, lines: [{ itemId: 'i1', productName: 'ماء الكمأ', shipped: 3, delivered: null, expectedBack: 3 }],
  completion: { halves: [{ key: 'GOODS', label: 'استلام الراجع وعدّه في المستودع', settled: false, units: 3 }], settledCount: 0, degree: 'NONE', complete: false, awaiting: ['GOODS'], label: 'تمّ 0 من 1' },
  action: null,
};
const returnsAnswer = (extra: Record<string, unknown>) => ({
  count: 1, orders: [RETURN_ROW], pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
  facts: { views: { pending: 1, received: 0 }, statuses: { RETURN_REQUESTED: 1, RETURNED: 0, FAILED_DELIVERY: 0, PARTIALLY_DELIVERED: 0 }, couriers: [], ages: { fresh: 0, few: 0, week: 0, old: 0 } },
  applied: { view: 'pending', status: null, courier: null, age: null, q: null }, ...extra,
});
const openReceive = async (extra: Record<string, unknown>) => {
  api.mockResolvedValue(returnsAnswer(extra));
  render(<ReturnsScreen />);
  await userEvent.click(await waitFor(() => screen.getAllByRole('button', { name: 'استلام' })[0], { timeout: 4000 }));
  await screen.findByText('استلام مرتجع');
};
const FEE = /احتساب أجرة إرجاع لشركة الشحن/;

describe('the returns dialog', () => {
  it('draws the courier-fee tick-box when the server says the reader holds the fee box', async () => {
    await openReceive({ mayChargeFee: true });
    expect(screen.getByLabelText(FEE)).toBeTruthy();
  });

  it('an answer that does not say is read as «yes» (an older server)', async () => {
    await openReceive({});
    expect(screen.getByLabelText(FEE)).toBeTruthy();
  });

  it('NEGATIVE: without the fee box the tick-box is gone — and receiving the return is still there', async () => {
    await openReceive({ mayChargeFee: false });
    expect(screen.queryByLabelText(FEE)).toBeNull();
    expect(screen.getByText('استلام مرتجع')).toBeTruthy();
  });
});

// ───────────────────────────── the preparation screen ─────────────────────────────

const PREPARATION = {
  groups: [{
    productId: 'p1', productName: 'كريم', orders: 1, required: 2, available: 5, shortage: 0,
    lines: [{ orderId: 'o-77', orderNumber: 'SY-77', customerName: 'سعاد', regionName: null, pendingChangeRequestId: null, quantity: 2, freeQuantity: 0, reservedQty: 2, shippingStatus: 'CONFIRMED' }],
  }],
  totals: { products: 1, orders: 1, shortages: 0 },
  allowNegativeStock: false,
};
const drawPreparation = async () => {
  api.mockResolvedValue(PREPARATION);
  render(<PreparationScreen />);
  await screen.findByText('منتجات للتجهيز');
};

describe('the preparation screen prints the waybill for ops.labels (D8)', () => {
  it('draws the print button on the row and the paper-size picker for who holds the key', async () => {
    holding('ops.prepare', 'ops.labels');
    await drawPreparation();
    expect(screen.getAllByRole('button', { name: 'اطبع البوليصة' }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('مقاس البوليصة')).toBeTruthy();
  });

  it('NEGATIVE: not drawn without the key — the list is the whole screen, and it is there', async () => {
    holding('ops.prepare');
    await drawPreparation();
    expect(screen.queryAllByRole('button', { name: 'اطبع البوليصة' })).toEqual([]);
    expect(screen.queryByLabelText('مقاس البوليصة')).toBeNull();
    expect(screen.getByText('كريم')).toBeTruthy();
  });

  it('pressing it prints THAT order only, on the device’s paper', async () => {
    holding('ops.prepare', 'ops.labels');
    await drawPreparation();
    fireEvent.click(screen.getAllByRole('button', { name: 'اطبع البوليصة' })[0]);
    await waitFor(() => expect(printed.calls.length).toBe(1));
    expect(printed.calls[0]).toEqual([{ orderIds: ['o-77'], width: 100, height: 150 }, 'print']);
    expect(told.calls).toEqual([]);
  });

  it('the orders the server could not print are NAMED in a dialog, and the screen is not replaced by an error', async () => {
    holding('ops.prepare', 'ops.labels');
    printed.outcome = { count: 0, refused: [{ orderNumber: 'SY-77', reason: 'بلا شركة شحن' }], opened: true };
    await drawPreparation();
    fireEvent.click(screen.getAllByRole('button', { name: 'اطبع البوليصة' })[0]);
    await waitFor(() => expect(told.calls.length).toBe(1));
    expect(JSON.stringify(told.calls[0])).toContain('SY-77');
    expect(screen.getByText('كريم')).toBeTruthy();
  });

  it('a blocked pop-up is said in a dialog too — never put in the error that replaces the screen', async () => {
    holding('ops.prepare', 'ops.labels');
    printed.outcome = { count: 1, refused: [], opened: false };
    await drawPreparation();
    fireEvent.click(screen.getAllByRole('button', { name: 'اطبع البوليصة' })[0]);
    await waitFor(() => expect(told.calls.length).toBe(1));
    expect(JSON.stringify(told.calls[0])).toContain('منع');
    expect(screen.getByText('كريم')).toBeTruthy();
  });
});

