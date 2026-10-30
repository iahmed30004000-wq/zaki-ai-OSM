// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * WHAT RECORDS THE TICKED ROWS IS IN THE BAR, NOT IN A STRIP SCROLLED OUT OF SIGHT.
 *
 * M5 of the phone audit (FIN-03 · OPS-SHIP-1 · OPS-TRK-1 · ORD-15 · ORD-14). Four
 * screens let a person tick rows far down a list of cards, and on every one the
 * button that acts on them sat above the list — off the screen by the time the
 * third row was ticked. The shell already has the answer (`BulkBar`: the bottom of
 * the phone while something is ticked, the same slot on a desk); these screens now
 * use it, and this file holds them to it:
 *
 *   • nothing ticked: no bar;
 *   • something ticked: the bar holds the count, the way out and the buttons that
 *     do the work, and the in-page strip holds none of those (one copy of each
 *     name — a second copy is a button two tests and one thumb cannot tell apart);
 *   • the bar is the PHONE's layout. On a desk nothing changed: the strip, the
 *     button in the filters and the old bar are exactly what they were, and the
 *     bar is not drawn (a second copy of every button would be one more thing
 *     a screen reader and a test could not tell apart).
 *
 * jsdom has no layout; the 44px, the fixed strip and the stacking were measured in
 * a real browser at 375px (see the pull request).
 */

const { apiJson, apiFetch, user, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  user: { current: null as unknown },
  phone: { value: true },
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => apiJson(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ locale: 'ar', t: {}, currentUser: user.current }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [] }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [] }) }));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => 'thermal', LabelSizePicker: () => <i data-picker /> }));
vi.mock('@/components/labels/openWaybills', () => ({
  openWaybills: vi.fn(),
  describeRefused: () => '',
  BLOCKED_WAYBILLS: 'x',
  WaybillError: class extends Error {},
}));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/AiOrderModal', () => ({ AiOrderModal: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ImportOrdersDialog', () => ({ ImportOrdersDialog: () => null }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => null }));
vi.mock('@/components/ui/SavedViews', () => ({ SavedViews: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({ DelayShipmentDialog: () => null }));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('@/components/screens/finance/ManualStatementDialog', () => ({ ManualStatementDialog: () => null }));

import { OrdersScreen } from './OrdersScreen';
import { TrackingScreen } from './TrackingScreen';
import { ShipmentsNewScreen } from './ShipmentsNewScreen';
import { ManualMatching } from './finance/ManualMatching';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const bar = () => document.querySelector('[role="toolbar"]') as HTMLElement | null;
const inBar = (name: string | RegExp) => within(bar()!).getByRole('button', { name });
const outsideBar = (name: string | RegExp) =>
  screen.queryAllByRole('button', { name }).filter((b) => !bar()?.contains(b));

beforeEach(() => {
  vi.clearAllMocks();
  // The bar is the PHONE's layout (useIsPhone); the desk describe at the end turns it off.
  phone.value = true;
});
afterEach(cleanup);

/* ═══════════════════════ الطلبات — ORD-15 · ORD-14 ═══════════════════════ */

describe('«الطلبات» — the bar and the boxes', () => {
  const ORDERS = Array.from({ length: 3 }, (_, i) => ({
    id: `o${i + 1}`,
    orderNumber: `ORD-26-${7000 + i}`,
    state: 'CONFIRMED',
    customer: { id: `c${i + 1}`, fullName: `زبون ${i + 1}`, city: 'عمّان' },
    region: { name: 'إربد' },
    productNameSnapshot: 'منتج',
    quantity: 1,
    source: 'Sheet import',
    moderator: { name: 'سارة' },
    createdAt: '2026-10-20T09:00:00.000Z',
    totalAmount: 40,
    confirmationStatus: 'NEW',
    deliveryProvider: { kind: 'COMPANY', name: 'ناقل' },
  }));

  beforeEach(() => {
    user.current = { id: 'u1', name: 'سارة', role: 'SUPER_ADMIN', permissions: ['orders.view', 'ops.labels'], status: 'ACTIVE' };
    apiFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).startsWith('/api/orders?')
          ? { orders: ORDERS, pagination: { page: 1, limit: 25, total: 3, totalPages: 1 } }
          : { orders: [], pagination: { page: 1, pages: 1, total: 0 } },
    }));
  });

  const draw = async () => {
    render(<OrdersScreen />);
    await screen.findByLabelText(`تحديد الطلب ${ORDERS[2].orderNumber}`);
  };

  it('nothing ticked: no bar. Everything ticked: the bar holds the count, the way out and the labels', async () => {
    await draw();
    expect(bar()).toBeNull();
    fireEvent.click(screen.getByLabelText('تحديد كل الطلبات في هذه الصفحة'));
    expect(bar()!.textContent).toContain('محدَّد: 3 طلب');
    // The one thing the bar is for is a button of its own, outside every fold.
    expect(inBar('طباعة البوالص').closest('details')).toBeNull();
    expect(inBar('إلغاء التحديد')).toBeTruthy();
  });

  it('the way out is a mark with a name, not a word that takes a row of the bar', async () => {
    await draw();
    fireEvent.click(screen.getByLabelText('تحديد كل الطلبات في هذه الصفحة'));
    const out = inBar('إلغاء التحديد');
    expect(out.textContent?.trim(), 'الزر يحمل نصاً').toBe('');
    expect(out.getAttribute('title')).toBe('إلغاء التحديد');
    fireEvent.click(out);
    expect(bar()).toBeNull();
  });

  it('the paper, the PDF and the export are one tap away, folded and saying so — not removed', async () => {
    await draw();
    fireEvent.click(screen.getByLabelText('تحديد كل الطلبات في هذه الصفحة'));
    const fold = bar()!.querySelector('details[data-advanced-group]') as HTMLDetailsElement;
    expect(fold, 'لا طيّة في الشريط').not.toBeNull();
    expect(fold.open).toBe(false);
    const summary = fold.querySelector('summary')!.textContent!;
    for (const word of ['مقاس الورق', 'PDF', 'تصدير']) expect(summary, word).toContain(word);
    expect(within(fold).getByRole('button', { name: 'PDF' })).toBeTruthy();
    expect(fold.querySelector('[data-picker]')).not.toBeNull();
  });

  it('each box is inside a label, so the label carries a 44px hit area the box cannot', async () => {
    await draw();
    for (const name of ['تحديد كل الطلبات في هذه الصفحة', ...ORDERS.map((o) => `تحديد الطلب ${o.orderNumber}`)]) {
      const label = screen.getByLabelText(name).closest('label');
      expect(label, name).not.toBeNull();
      expect(label!.className, name).toContain('tap-safe');
    }
  });

  it('pressing the label beside the box ticks it — a miss no longer opens the order', async () => {
    await draw();
    const label = screen.getByLabelText(`تحديد الطلب ${ORDERS[0].orderNumber}`).closest('label')!;
    fireEvent.click(label);
    expect((screen.getByLabelText(`تحديد الطلب ${ORDERS[0].orderNumber}`) as HTMLInputElement).checked).toBe(true);
    expect(bar()!.textContent).toContain('محدَّد: 1 طلب');
  });

  it('DESK: nothing changed — the paper, the PDF, the export and a worded cancel sit beside the print button, none of them folded', async () => {
    phone.value = false;
    await draw();
    fireEvent.click(screen.getByLabelText('تحديد كل الطلبات في هذه الصفحة'));
    expect(bar()!.querySelector('details')).toBeNull();
    expect(bar()!.querySelector('[data-picker]')).not.toBeNull();
    for (const name of ['طباعة البوالص', 'PDF', 'إلغاء التحديد']) {
      expect(inBar(name).textContent?.trim(), name).not.toBe('');
    }
    expect(inBar('إلغاء التحديد').textContent).toContain('إلغاء التحديد');
  });
});

/* ═══════════════════════ متابعة الشحن — OPS-TRK-1 ═══════════════════════ */

describe('«متابعة الشحن» — «استلمت منه»', () => {
  const owed = (id: string, courier = A) => ({
    id,
    orderNumber: `ORD-${id}`,
    merchantRef: null,
    trackingNumber: `TRK-${id}`,
    shippingStatus: 'DELIVERED',
    collectionStatus: 'PENDING_COLLECTION',
    settlementStatus: 'PENDING_COLLECTION',
    daysInTransit: 3,
    lateThresholdDays: 3,
    late: false,
    totalAmount: 40,
    currency: 'JOD',
    deliveryFailureReason: null,
    customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
    region: { name: 'عمّان' },
    deliveryProvider: { id: courier, name: courier === A ? 'أبو علي' : 'أمان', kind: 'COMPANY' },
    expectedCollection: 37.5,
    _count: { deliveryAttempts: 0, notes: 0 },
    alert: null,
  });
  const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };

  const answerWith = (orders: ReturnType<typeof owed>[]) =>
    apiJson.mockImplementation(async () => ({
      count: orders.length,
      orders,
      lateCount: 0,
      dialCode: '962',
      pagination: { total: orders.length, page: 1, limit: 25, totalPages: 1 },
      facts: {
        total: orders.length,
        tasks: { ...NO_TASKS, COLLECT: orders.length },
        lateCount: 0,
        notLate: 0,
        couriers: [
          { id: A, name: 'أبو علي', count: orders.length },
          { id: B, name: 'أمان', count: orders.length },
        ],
        regions: [],
        ages: { fresh: orders.length, few: 0, week: 0, old: 0 },
      },
      applied: {},
      capped: false,
    }));
  const draw = async () => {
    render(<TrackingScreen />);
    await screen.findByLabelText('جهة الشحن');
  };
  const strip = () => screen.getByText(/مسلَّم بانتظار التحصيل/).parentElement as HTMLElement;

  it('nothing ticked: the strip offers «اختر الكل» and there is no bar', async () => {
    answerWith([owed('a'), owed('b')]);
    await draw();
    expect(bar()).toBeNull();
    expect(within(strip()).getByRole('button', { name: 'اختر الكل' })).toBeTruthy();
  });

  it('ticked: the count, the way out and «استلمت منه» are in the bar — and the strip holds none of them', async () => {
    answerWith([owed('a'), owed('b')]);
    await draw();
    fireEvent.click(within(strip()).getByRole('button', { name: 'اختر الكل' }));
    expect(bar()!.textContent).toContain('مختار 2 طلب · صافي 75');
    expect(inBar('استلمت منه')).toBeTruthy();
    expect(inBar('إلغاء الاختيار')).toBeTruthy();
    // One copy of each name in the whole page.
    expect(screen.getAllByRole('button', { name: 'استلمت منه' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'إلغاء الاختيار' })).toHaveLength(1);
    // The strip stays on a phone, so the list does not jump up under the finger.
    expect(strip().isConnected).toBe(true);
    expect(within(strip()).queryByRole('button', { name: 'اختر الكل' })).toBeNull();
  });

  it('«اختر الكل» is still there after a tick, in the bar — until every row is ticked', async () => {
    answerWith([owed('a'), owed('b')]);
    await draw();
    fireEvent.click(document.querySelector('tbody tr input[type="checkbox"]') as HTMLInputElement);
    expect(inBar('اختر الكل')).toBeTruthy();
    expect(outsideBar('اختر الكل')).toHaveLength(0);
    fireEvent.click(inBar('اختر الكل'));
    expect(within(bar()!).queryByRole('button', { name: 'اختر الكل' })).toBeNull();
  });

  it('two couriers: the bar says so beside the button, and the button is shut', async () => {
    answerWith([owed('a', A), owed('b', B)]);
    await draw();
    fireEvent.click(within(strip()).getByRole('button', { name: 'اختر الكل' }));
    expect(within(bar()!).getByRole('alert').textContent).toBe('اختر طرود شركة وحدة');
    expect((inBar('استلمت منه') as HTMLButtonElement).disabled).toBe(true);
  });

  it('«إلغاء الاختيار» puts the bar away', async () => {
    answerWith([owed('a')]);
    await draw();
    fireEvent.click(within(strip()).getByRole('button', { name: 'اختر الكل' }));
    fireEvent.click(inBar('إلغاء الاختيار'));
    expect(bar()).toBeNull();
  });

  it('DESK: nothing changed — the count, the net, the way out and «استلمت منه» are in the strip, and there is no bar', async () => {
    phone.value = false;
    answerWith([owed('a'), owed('b')]);
    await draw();
    fireEvent.click(within(strip()).getByRole('button', { name: 'اختر الكل' }));
    expect(bar()).toBeNull();
    const row = screen.getByText(/مختار 2 طلب · صافي 75/).parentElement as HTMLElement;
    expect(within(row).getByRole('button', { name: 'استلمت منه' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'إلغاء الاختيار' })).toBeTruthy();
    // «اختر الكل» stays in the strip, as it always did
    expect(within(row).getByRole('button', { name: 'اختر الكل' })).toBeTruthy();
  });
});

/* ═══════════════════════ المطابقة اليدوية — FIN-03 ═══════════════════════ */

describe('«مطابقة يدوية» — «تم تسليمها» / «رجعت» / «استلمت منه»', () => {
  const parcel = (ref: string, over: Record<string, unknown> = {}) => ({
    id: `id-${ref}`,
    orderNumber: `ORD-${ref}`,
    merchantRef: ref,
    trackingNumber: `TRK-${ref}`,
    shippingStatus: 'SHIPPED',
    settlementStatus: 'NOT_APPLICABLE',
    daysInTransit: 1,
    late: false,
    totalAmount: 40,
    currency: 'JOD',
    customer: { fullName: `زبون ${ref}`, phone: '0790000000', city: 'عمّان' },
    deliveryProvider: { id: A, name: 'أبو علي', kind: 'AGENT' },
    expectedCollection: 37.5,
    alert: null,
    ...over,
  });
  const delivered = (ref: string) => parcel(ref, { shippingStatus: 'DELIVERED', settlementStatus: 'UNSETTLED' });

  const holds = (parcels: ReturnType<typeof parcel>[]) =>
    apiJson.mockImplementation(async (url: string) => {
      const u = new URL(url, 'http://x');
      if (u.pathname !== '/api/ops/tracking') return { providers: [], wallets: [], products: [], statements: [] };
      return {
        orders: parcels,
        pagination: { total: parcels.length, page: 1, limit: 50, totalPages: 1 },
        facts: {
          total: parcels.length,
          tasks: { ...NO_TASKS, COLLECT: 0 },
          lateCount: 0,
          couriers: [{ id: A, name: 'أبو علي', count: parcels.length }],
          regions: [],
          ages: { fresh: 0, few: 0, week: 0, old: 0 },
        },
      };
    });
  const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };

  const draw = async () => {
    user.current = { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['ops.track', 'finance.cashbox', 'settlement.review'] };
    render(<ManualMatching />);
    await screen.findByLabelText('جهة الشحن');
    await waitFor(() => expect(document.querySelector('tbody tr')).not.toBeNull());
  };
  const tick = (index: number) =>
    fireEvent.click(document.querySelectorAll('tbody tr input[type="checkbox"]')[index] as HTMLInputElement);
  const strip = () => screen.getByText('علّم الطلبات التي تريد تسجيلها.').parentElement as HTMLElement;

  it('nothing ticked: the strip offers the picks, and there is no bar', async () => {
    holds([parcel('M1'), parcel('M2')]);
    await draw();
    expect(bar()).toBeNull();
    expect(within(strip()).getByRole('button', { name: /اختر كل ما بانتظار التسليم \(2\)/ })).toBeTruthy();
  });

  it('a parcel at the door ticked: «تم تسليمها» and «رجعت» are in the bar, the strip has neither', async () => {
    holds([parcel('M1'), parcel('M2')]);
    await draw();
    tick(0);
    expect(bar()!.textContent).toContain('مختار 1 طلب');
    expect(inBar(/تم تسليمها \(1\)/)).toBeTruthy();
    expect(inBar(/رجعت \(1\)/)).toBeTruthy();
    expect(inBar(/إلغاء الاختيار/)).toBeTruthy();
    expect(outsideBar(/تم تسليمها|رجعت/)).toHaveLength(0);
    expect(outsideBar(/إلغاء الاختيار/)).toHaveLength(0);
    expect(strip().isConnected).toBe(true);
    // And the picks are not offered twice: once something is ticked they are gone from the strip.
    expect(within(strip()).queryByRole('button', { name: /اختر كل/ })).toBeNull();
  });

  it('a delivered parcel ticked: «استلمت منه» is in the bar', async () => {
    holds([delivered('D1')]);
    await draw();
    tick(0);
    expect(inBar(/استلمت منه \(1\)/)).toBeTruthy();
    expect(outsideBar(/استلمت منه/)).toHaveLength(0);
  });

  it('a mixed choice: the reason is in the bar and no button that would be refused', async () => {
    holds([parcel('M1'), delivered('D1')]);
    await draw();
    tick(0);
    tick(1);
    const text = bar()!.textContent ?? '';
    expect(text).toContain('مختار 2 طلب');
    expect(within(bar()!).queryByRole('button', { name: /تم تسليمها|استلمت منه/ })).toBeNull();
    // The reason is said where the buttons would have been.
    expect(text.length).toBeGreaterThan('مختار 2 طلب إلغاء الاختيار'.length);
  });

  it('«إلغاء الاختيار» puts the bar away and the strip comes back whole', async () => {
    holds([parcel('M1')]);
    await draw();
    tick(0);
    fireEvent.click(inBar(/إلغاء الاختيار/));
    expect(bar()).toBeNull();
  });

  it('DESK: nothing changed — the count, the way out and the buttons are in the strip above the list, and there is no bar', async () => {
    phone.value = false;
    holds([parcel('M1'), parcel('M2')]);
    await draw();
    tick(0);
    expect(bar()).toBeNull();
    const row = screen.getByText('مختار 1 طلب').parentElement as HTMLElement;
    expect(row.textContent).toContain('مختار 1 طلب');
    for (const name of ['تم تسليمها (1)', 'رجعت (1)', 'إلغاء الاختيار']) {
      expect(within(row).getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: /إلغاء الاختيار/ })).toHaveLength(1);
  });
});

/* ═══════════════════════ إنشاء شحنة — OPS-SHIP-1 ═══════════════════════ */

describe('«إنشاء شحنة» — the button is in the bar', () => {
  const row = (id: string, name: string) => ({
    id,
    orderNumber: `ORD-${id}`,
    merchantRef: `ORD-${id}`,
    customer: { id: `c-${id}`, fullName: name, phone: '0790000000', city: 'عمّان' },
    previousOrders: 0,
    region: { id: 'r1', name: 'عمّان' },
    items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
    cod: { subtotal: 20, discount: 0, deliveryFee: 0, cod: 20, currency: 'JOD', feeSource: 'region' },
    blocks: [],
    selectable: true,
    hardBlocked: false,
    shipHoldUntil: null,
    standDownBlocked: null,
    shipHoldReason: null,
  });

  beforeEach(() => {
    user.current = null;
    apiJson.mockImplementation(async (url: string) =>
      url.includes('/api/ops/shipments')
        ? { orders: [row('1', 'سامر خليل'), row('2', 'هبة يوسف')], heldCount: 0 }
        : { providers: [{ id: 'p1', name: 'شركة الشحن أ' }], regions: [{ id: 'r1', name: 'عمّان' }] }
    );
  });

  const draw = async () => {
    render(<ShipmentsNewScreen />);
    await waitFor(() => expect(document.querySelector('thead input[type="checkbox"]')).toBeTruthy());
  };
  const tickAll = () => fireEvent.click(document.querySelector('thead input[type="checkbox"]') as HTMLInputElement);

  it('nothing ticked: no bar, and no button that can only refuse', async () => {
    await draw();
    expect(bar()).toBeNull();
    expect(screen.queryByText(/إنشاء شحنة \(/)).toBeNull();
  });

  it('ticked: the button with its count is in the bar, and the courier stays up in the filters', async () => {
    await draw();
    tickAll();
    expect(within(bar()!).getByText('إنشاء شحنة (2)')).toBeTruthy();
    expect(bar()!.textContent).toContain('محدَّد: 2 طلب');
    // The choice the shipment cannot do without is not folded into the bar.
    expect(screen.getByLabelText(/شركة الشحن/).closest('[role="toolbar"]')).toBeNull();
  });

  it('with no courier chosen the bar says so, and the sentence goes once one is', async () => {
    await draw();
    tickAll();
    expect(bar()!.textContent).toContain('اختر شركة الشحن من الأعلى أولاً');
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    expect(bar()!.textContent).not.toContain('اختر شركة الشحن');
  });

  it('and pressing it still asks the door for the shipment, with the courier and every ticked order', async () => {
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    tickAll();
    await act(async () => {
      fireEvent.click(within(bar()!).getByText('إنشاء شحنة (2)'));
    });
    const post = apiJson.mock.calls.find((c) => c[1] && (c[1] as RequestInit).method === 'POST');
    expect(post, 'لم يُرسَل طلب الإنشاء').toBeTruthy();
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(body.deliveryProviderId).toBe('p1');
    expect(body.orderIds.sort()).toEqual(['1', '2']);
  });

  it('DESK: nothing changed — the button is the last cell of the filters with its count, there is no bar and no sentence about the courier', async () => {
    phone.value = false;
    await draw();
    const button = screen.getByRole('button', { name: 'إنشاء شحنة (0)' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.closest('[role="toolbar"]')).toBeNull();
    tickAll();
    expect(bar()).toBeNull();
    expect(screen.getByRole('button', { name: 'إنشاء شحنة (2)' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('اختر شركة الشحن من الأعلى');
    // one button, not two
    expect(screen.getAllByText(/^إنشاء شحنة/)).toHaveLength(1);
  });
});

/* ═══════════════════════ the bar sits ON the edge ═══════════════════════ */

describe('the bar and its parent’s spacing', () => {
  it('stands in a plain box of its own, so the gap a screen puts between its blocks cannot lift it off the edge', async () => {
    user.current = null;
    apiJson.mockImplementation(async (url: string) =>
      url.includes('/api/ops/shipments')
        ? {
            orders: [
              {
                id: '1', orderNumber: 'ORD-1', merchantRef: 'ORD-1',
                customer: { id: 'c1', fullName: 'سامر خليل', phone: '0790000000', city: 'عمّان' }, previousOrders: 0,
                region: { id: 'r1', name: 'عمّان' }, items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
                cod: { subtotal: 20, discount: 0, deliveryFee: 0, cod: 20, currency: 'JOD', feeSource: 'region' },
                blocks: [], selectable: true, hardBlocked: false, shipHoldUntil: null, standDownBlocked: null, shipHoldReason: null,
              },
            ],
            heldCount: 0,
          }
        : { providers: [], regions: [] }
    );
    render(<ShipmentsNewScreen />);
    await waitFor(() => expect(document.querySelector('thead input[type="checkbox"]')).toBeTruthy());
    fireEvent.click(document.querySelector('thead input[type="checkbox"]') as HTMLInputElement);
    const wrap = bar()!.parentElement!;
    // A margin on a fixed box is an offset. The box that takes the parent's margin carries no class of its own,
    // and holds nothing but the bar.
    expect(wrap.tagName).toBe('DIV');
    expect(wrap.getAttribute('class')).toBeNull();
    expect(wrap.children).toHaveLength(1);
  });
});
