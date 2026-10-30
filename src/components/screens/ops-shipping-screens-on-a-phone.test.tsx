// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * THE SHIPPING SCREENS ON A PHONE — M7 of the phone audit (OPS-SHIP-2..5 · OPS-BATCH-1..2 · OPS-TRK-2..4).
 *
 * «إنشاء شحنة» · «دفعات الشحن» · «متابعة الشحن» · the part-delivery dialog.
 *
 * Each claim is made twice: on a phone the layout is the new one, and on a DESK nothing is different — the same
 * controls in the same elements. A phone is `useIsPhone` (the screens draw ONE layout each, not two hidden copies),
 * so the desk is the same render with the hook answering `false`.
 *
 * jsdom has no layout: the 44px, the wrapping and the stacking were measured in a real browser at 375px (see the
 * pull request). What is held here is WHICH elements carry WHAT: the warnings in the card's notice, the strip that
 * slides, the presses side by side, the fold that names what it holds.
 */

const { apiJson, apiFetch, confirmFn, user, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  confirmFn: vi.fn(async (_o: unknown) => true),
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
vi.mock('@/context/StoreCurrency', () => ({ useStoreCurrency: () => ({ code: 'JOD', minorUnit: 3 }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => confirmFn,
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  // Once, on mount, and not at all where the screen says `initial: false` (it loads by itself): re-running on every
  // render would call a fresh arrow each time and never settle.
  useLiveRefresh: (load: () => Promise<void> | void, opts?: { initial?: boolean }) => {
    React.useEffect(() => {
      if (opts?.initial !== false) void load();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
  },
}));
vi.mock('@/components/labels/LabelSize', () => ({
  useLabelSize: () => ({ dims: { width: 100, height: 150 } }),
  LabelSizePicker: () => <i data-picker />,
}));
vi.mock('@/components/labels/openWaybills', () => ({
  openWaybills: vi.fn(async () => ({ count: 1, refused: [], opened: true })),
  describeRefused: () => '',
  BLOCKED_WAYBILLS: 'x',
  WaybillError: class extends Error {},
}));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null, ScanSheet: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({ DelayShipmentDialog: () => null }));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));

import { ShipmentsNewScreen } from './ShipmentsNewScreen';
import { ShippingBatchesScreen } from './ShippingBatchesScreen';
import { TrackingScreen } from './TrackingScreen';
import { DeliverDialog } from './tracking/DeliverDialog';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 15000 });

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = true;
  user.current = { id: 'u1', status: 'ACTIVE', role: 'SUPER_ADMIN', permissions: ['ops.ship', 'ops.labels', 'ops.track'] };
});
afterEach(cleanup);

/** The first card of a list of cards (a table row is a `tr`, a card is an `li`). */
const card = () => document.querySelector('li') as HTMLElement;

/* ═══════════════════════ إنشاء شحنة ═══════════════════════ */

describe('«إنشاء شحنة»', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: '1',
    orderNumber: 'ORD-1',
    merchantRef: 'ORD-1',
    customer: { id: 'c1', fullName: 'سامر خليل', phone: '0790000000', city: 'عمّان' },
    previousOrders: 0,
    region: { id: 'r1', name: 'عمّان' },
    items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
    cod: { subtotal: 20, discount: 2, deliveryFee: 3, cod: 21, currency: 'JOD', feeSource: 'region' },
    blocks: [],
    selectable: true,
    hardBlocked: false,
    shipHoldUntil: null,
    standDownBlocked: null,
    shipHoldReason: null,
    ...over,
  });
  const serve = (rows: ReturnType<typeof row>[]) =>
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { batch: { id: 'b-1', batchNumber: 'B-26-0001' }, shipped: 1, exceptions: [], courierApi: false };
      if (url.includes('/api/ops/shipments')) return { orders: rows, heldCount: 0 };
      return { providers: [{ id: 'p1', name: 'شركة الشحن أ' }], regions: [{ id: 'r1', name: 'عمّان' }] };
    });
  const draw = async () => {
    render(<ShipmentsNewScreen />);
    await waitFor(() => expect(document.querySelector('li')).not.toBeNull(), WAIT);
  };
  const SOFT = { code: 'ADDR', message: 'العنوان غير مكتمل', hard: false };

  it('PHONE: the province and the dates are folded behind a row that says so — the courier stays outside', async () => {
    serve([row()]);
    await draw();
    const fold = document.querySelector('details[data-advanced-group]') as HTMLDetailsElement;
    expect(fold).not.toBeNull();
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toContain('المحافظة · التاريخ');
    for (const name of ['المحافظة', 'من', 'إلى']) expect(within(fold).getByLabelText(name)).toBeTruthy();
    expect(within(fold).queryByLabelText(/شركة الشحن/)).toBeNull();
    expect(screen.getByLabelText(/شركة الشحن/)).toBeTruthy();
  });

  it('PHONE: a province or a date chosen inside the closed fold is counted on the row that closes over it', async () => {
    serve([row()]);
    await draw();
    const summary = () => (document.querySelector('details[data-advanced-group]') as HTMLElement).querySelector('summary')!.textContent!;
    expect(summary()).toContain('المحافظة · التاريخ');
    expect(summary()).not.toContain('(');
    const fold = document.querySelector('details[data-advanced-group]') as HTMLElement;
    fireEvent.change(within(fold).getByLabelText('المحافظة'), { target: { value: 'r1' } });
    expect(summary()).toContain('المحافظة · التاريخ (1)');
    fireEvent.change(within(fold).getByLabelText('من'), { target: { value: '2026-10-01' } });
    fireEvent.change(within(fold).getByLabelText('إلى'), { target: { value: '2026-10-30' } });
    expect(summary()).toContain('المحافظة · التاريخ (3)');
    fireEvent.change(within(fold).getByLabelText('المحافظة'), { target: { value: '' } });
    expect(summary()).toContain('المحافظة · التاريخ (2)');
  });

  it('DESK: nothing changed — the province and the dates are cells of the filter grid, no fold', async () => {
    phone.value = false;
    serve([row()]);
    await draw();
    expect(document.querySelector('details')).toBeNull();
    for (const name of ['المحافظة', 'من', 'إلى', /شركة الشحن/]) expect(screen.getByLabelText(name)).toBeTruthy();
  });

  it('PHONE: the warnings are the first thing on the card, with the box that acknowledges them — and not a «تنبيهات» line', async () => {
    serve([row({ blocks: [SOFT] })]);
    await draw();
    const li = card();
    expect(li.firstElementChild!.textContent).toContain('العنوان غير مكتمل');
    expect(li.firstElementChild!.textContent).toContain('أقرّ بالتنبيه وأتابع');
    expect(within(li).queryByText('تنبيهات')).toBeNull();
    // The acknowledgement is a label with room around the box (a bare box is 13px).
    const box = within(li).getByLabelText('أقرّ بالتنبيه وأتابع') as HTMLInputElement;
    expect(box.closest('label')!.className).toContain('min-h-11');
    expect(box.className).toContain('h-5');
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });

  it('PHONE: a hard block is in the notice too, with no acknowledgement to tick', async () => {
    serve([row({ blocks: [{ code: 'NOFEE', message: 'لا أجرة لهذه المحافظة', hard: true }], hardBlocked: true, selectable: false })]);
    await draw();
    expect(card().firstElementChild!.textContent).toContain('لا أجرة لهذه المحافظة');
    expect(within(card()).queryByLabelText('أقرّ بالتنبيه وأتابع')).toBeNull();
  });

  it('DESK: nothing changed — the warnings are the «تنبيهات» cell, in the card as in the table', async () => {
    phone.value = false;
    serve([row({ blocks: [SOFT] })]);
    await draw();
    expect(within(card()).getByText('تنبيهات')).toBeTruthy();
    expect(card().firstElementChild!.textContent).not.toContain('أقرّ بالتنبيه');
    // The box in the cell is the bare one it always was.
    expect((within(card()).getByLabelText('أقرّ بالتنبيه وأتابع') as HTMLInputElement).className).toBe('');
  });

  it('PHONE: the amount the courier collects is first, the sum it came from is the line under it — no equals sign', async () => {
    serve([row()]);
    await draw();
    const dd = within(card()).getByText('تفصيل التحصيل').nextElementSibling as HTMLElement;
    expect(dd.textContent).not.toContain('=');
    expect(dd.textContent).toMatch(/21/);
    expect(dd.textContent).toContain('20 − 2 + 3');
    expect(dd.textContent!.indexOf('21')).toBeLessThan(dd.textContent!.indexOf('20 − 2 + 3'));
  });

  it('DESK: nothing changed — the sum, the equals sign and the amount, on one line', async () => {
    phone.value = false;
    serve([row()]);
    await draw();
    const dd = within(card()).getByText('تفصيل التحصيل').nextElementSibling as HTMLElement;
    expect(dd.textContent).toContain('20 − 2 + 3 =');
  });

  it('PHONE: «أجّل» and «ألغِ» are two equal halves of one row; the hold reason is read in full', async () => {
    serve([row({ shipHoldReason: 'ينتظر ردّ الزبون على العنوان الجديد' })]);
    await draw();
    const postpone = within(card()).getByRole('button', { name: /أجّل/ });
    const cancel = within(card()).getByRole('button', { name: /ألغِ/ });
    expect(postpone.parentElement).toBe(cancel.parentElement);
    expect(postpone.parentElement!.className).toContain('grid-cols-2');
    expect(cancel.className).not.toContain('ms-1');
    const reason = within(card()).getByText('ينتظر ردّ الزبون على العنوان الجديد');
    expect(reason.className).not.toContain('truncate');
  });

  it('DESK: nothing changed — one no-wrap line, 4px between the two, the reason cut to ten rem', async () => {
    phone.value = false;
    serve([row({ shipHoldReason: 'ينتظر ردّ الزبون على العنوان الجديد' })]);
    await draw();
    const postpone = within(card()).getByRole('button', { name: /أجّل/ });
    const cancel = within(card()).getByRole('button', { name: /ألغِ/ });
    expect(postpone.parentElement!.className).toBe('whitespace-nowrap');
    expect(cancel.className).toContain('ms-1');
    expect(within(card()).getByText('ينتظر ردّ الزبون على العنوان الجديد').className).toContain('truncate');
  });

  it('PHONE: the list is not drawn inside a second frame', async () => {
    serve([row()]);
    await draw();
    expect(card().closest('ul')!.parentElement!.className).not.toContain('overflow-hidden');
  });

  it('DESK: the frame around the list is still there', async () => {
    phone.value = false;
    serve([row()]);
    await draw();
    expect(card().closest('ul')!.parentElement!.className).toContain('overflow-hidden');
  });

  /** Ship the one order on a phone, ending on the banner. */
  const shipOnPhone = async () => {
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    fireEvent.click(within(card()).getByLabelText('اختر السجل'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /إنشاء شحنة \(1\)/ }));
    });
    await screen.findByText(/تم إنشاء الدفعة B-26-0001/, undefined, WAIT);
  };

  it('PHONE: after the shipment, «اطبع البوالص» is a button across the banner, not an underlined word', async () => {
    serve([row()]);
    await shipOnPhone();
    const print = screen.getByRole('button', { name: 'اطبع البوالص' });
    expect(print.className).not.toContain('underline');
    expect(print.className).toContain('w-full');
    expect(print.parentElement!.className).toContain('flex-col');
  });

  it('DESK: after the shipment, «اطبع البوالص» is still the underlined word inside the sentence', async () => {
    phone.value = false;
    serve([row()]);
    await draw();
    fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
    fireEvent.click(document.querySelector('thead input[type="checkbox"]') as HTMLInputElement);
    await act(async () => {
      fireEvent.click(screen.getAllByText(/إنشاء شحنة \(/)[0]);
    });
    await screen.findByText(/تم إنشاء الدفعة B-26-0001/, undefined, WAIT);
    const print = screen.getByRole('button', { name: 'اطبع البوالص' });
    expect(print.className).toContain('underline');
    expect(print.parentElement!.tagName).toBe('P');
  });
});

/* ═══════════════════════ دفعات الشحن ═══════════════════════ */

describe('«دفعات الشحن»', () => {
  const SEND = 'رحّل إلى الشركة واجلب الباركود';
  const SHIP = /إغلاق الشحنة — سُلّمت للشركة/;
  const batch = (over: Record<string, unknown> = {}) => ({
    id: 'b1',
    batchNumber: 'BATCH-2026-0001',
    status: 'READY',
    provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: true },
    creator: { id: 'u1', name: 'سارة' },
    createdAt: '2026-10-28T08:00:00.000Z',
    shippedAt: null,
    notes: null,
    _count: { orders: 6 },
    courierCityGap: null,
    ...over,
  });
  const serve = (...bs: unknown[]) =>
    apiJson.mockImplementation(async (url: string) =>
      url.startsWith('/api/shipping-batches/')
        ? { batch: { orders: [{ id: 'o1', orderNumber: 'ORD-1', trackingNumber: null, customer: { fullName: 'سارة' } }] } }
        : { batches: bs, pagination: { total: bs.length } }
    );
  const draw = async () => {
    render(<ShippingBatchesScreen />);
    await screen.findByText('BATCH-2026-0001', undefined, WAIT);
  };
  const names = (el: Element) => [...el.querySelectorAll('button')].map((b) => b.textContent!.trim());

  it('PHONE: the presses that move the batch on come first, one per line, in the order of the work', async () => {
    serve(batch());
    await draw();
    const send = screen.getByRole('button', { name: SEND });
    expect(send.className).toContain('w-full');
    expect(send.parentElement!.className).toContain('flex-col');
    expect(names(send.parentElement!)).toEqual([SEND, 'إغلاق الشحنة — سُلّمت للشركة']);
    // …and they come before the print and the check in the document.
    const print = screen.getByRole('button', { name: /طباعة بوالص الدفعة/ });
    expect(send.compareDocumentPosition(print)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('PHONE: print and check are side by side; the two files are folded behind a row that names them', async () => {
    serve(batch());
    await draw();
    const print = screen.getByRole('button', { name: /طباعة بوالص الدفعة/ });
    const verify = screen.getByRole('button', { name: /تحقّق من الطرود/ });
    expect(print.parentElement).toBe(verify.parentElement);
    expect(print.parentElement!.className).toContain('grid-cols-2');
    const pdf = screen.getByRole('button', { name: 'PDF' });
    const fold = pdf.closest('details') as HTMLDetailsElement;
    expect(fold).not.toBeNull();
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toContain('PDF · CSV');
    expect(within(fold).getByRole('button', { name: 'CSV' })).toBeTruthy();
  });

  it('PHONE: a manual courier is a sentence under the buttons, not a pill that looks pressable', async () => {
    serve(batch({ provider: { id: 'dp2', name: 'يدوي', code: 'M', kind: 'AGENT', apiEnabled: false } }));
    await draw();
    const note = screen.getByText('يدوية — اطبع البوالص');
    expect(note.tagName).toBe('P');
    expect(note.className).not.toContain('border');
    expect(screen.queryByRole('button', { name: SEND })).toBeNull();
  });

  it('PHONE: a batch already handed over offers only «أنهِ الدفعة بعد التسوية», across the card', async () => {
    serve(batch({ status: 'SHIPPED', shippedAt: '2026-10-29T08:00:00.000Z' }));
    await draw();
    const close = screen.getByRole('button', { name: /أنهِ الدفعة بعد التسوية/ });
    expect(close.className).toContain('w-full');
    expect(screen.queryByRole('button', { name: SHIP })).toBeNull();
  });

  it('PHONE: the four states are one strip that slides; the paper has a row of its own, with its name', async () => {
    serve(batch());
    await draw();
    const strip = screen.getByRole('button', { name: /الكل \(1\)/ }).parentElement as HTMLElement;
    expect(strip.className).toContain('overflow-x-auto');
    expect(strip.className).not.toContain('flex-wrap');
    expect(screen.getByRole('button', { name: /الكل \(1\)/ }).className).toContain('shrink-0');
    expect(strip.querySelector('[data-picker]')).toBeNull();
    expect(screen.getByText('مقاس البوليصة')).toBeTruthy();
    expect(document.querySelector('[data-picker]')).not.toBeNull();
  });

  it('PHONE: the three ways to take a parcel off the open trolley are three equal columns', async () => {
    serve(batch());
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /طرود الدفعة/ }));
    const cancel = await screen.findByRole('button', { name: 'ألغِ' }, WAIT);
    expect(cancel.parentElement!.className).toContain('grid-cols-3');
    expect(cancel.parentElement!.querySelectorAll('button')).toHaveLength(3);
  });

  it('PHONE: «سُلّمت للشركة» asks first — declined, nothing is written; confirmed, the handover is written', async () => {
    serve(batch());
    await draw();
    confirmFn.mockResolvedValueOnce(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHIP }));
    });
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect((confirmFn.mock.calls[0][0] as { title: string }).title).toContain('BATCH-2026-0001');
    expect((confirmFn.mock.calls[0][0] as { tone?: string }).tone).toBe('danger');
    const writes = () => apiJson.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
    expect(writes()).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHIP }));
    });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(String((writes()[0][1] as RequestInit).body))).toEqual({ status: 'SHIPPED' });
  });

  it('DESK: nothing changed — «سُلّمت للشركة» is written on the press, with no question', async () => {
    phone.value = false;
    serve(batch());
    await draw();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SHIP }));
    });
    expect(confirmFn).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(apiJson.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')).toHaveLength(1)
    );
  });

  it('DESK: nothing changed — all eight presses in one wrapping row in the old order, no fold, the pill is a pill', async () => {
    phone.value = false;
    serve(batch({ provider: { id: 'dp1', name: 'الباشا', code: 'B', kind: 'COMPANY', apiEnabled: true } }));
    await draw();
    expect(document.querySelector('details')).toBeNull();
    const send = screen.getByRole('button', { name: SEND });
    const row = send.parentElement as HTMLElement;
    expect(row.className).toContain('flex-wrap');
    expect(names(row)).toEqual([
      'طباعة بوالص الدفعة',
      'تحقّق من الطرود',
      'PDF',
      'CSV',
      SEND,
      'إغلاق الشحنة — سُلّمت للشركة',
    ]);
    expect(send.className).not.toContain('w-full');
    // the chips wrap and the paper is among them, at the end
    const strip = screen.getByRole('button', { name: /الكل \(1\)/ }).parentElement as HTMLElement;
    expect(strip.className).toContain('flex-wrap');
    expect(strip.querySelector('[data-picker]')).not.toBeNull();
    expect(screen.queryByText('مقاس البوليصة')).toBeNull();
  });

  it('DESK: a manual courier is the bordered pill it was', async () => {
    phone.value = false;
    serve(batch({ provider: { id: 'dp2', name: 'يدوي', code: 'M', kind: 'AGENT', apiEnabled: false } }));
    await draw();
    const note = screen.getByText('يدوية — اطبع البوالص');
    expect(note.tagName).toBe('SPAN');
    expect(note.className).toContain('border');
  });
});

/* ═══════════════════════ متابعة الشحن ═══════════════════════ */

describe('«متابعة الشحن»', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const parcel = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    orderNumber: `ORD-${id}`,
    merchantRef: null,
    trackingNumber: `TRK-${id}`,
    shippingStatus: 'SHIPPED',
    collectionStatus: 'NOT_COLLECTED',
    settlementStatus: 'NOT_APPLICABLE',
    daysInTransit: 3,
    lateThresholdDays: 3,
    late: true,
    totalAmount: 40,
    currency: 'JOD',
    deliveryFailureReason: null,
    customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
    region: { name: 'عمّان' },
    deliveryProvider: { id: A, name: 'أبو علي', kind: 'COMPANY' },
    expectedCollection: null,
    _count: { deliveryAttempts: 0, notes: 0 },
    alert: null,
    ...over,
  });
  const serve = (orders: ReturnType<typeof parcel>[]) =>
    apiJson.mockImplementation(async () => ({
      count: orders.length,
      orders,
      lateCount: orders.length,
      dialCode: '962',
      pagination: { total: orders.length, page: 1, limit: 25, totalPages: 1 },
      facts: {
        total: orders.length,
        tasks: { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: orders.length, NO_BARCODE: 0, COLLECT: 0 },
        lateCount: orders.length,
        notLate: 0,
        couriers: [{ id: A, name: 'أبو علي', count: orders.length }],
        regions: [],
        ages: { fresh: 0, few: 0, week: orders.length, old: 0 },
      },
      applied: {},
      capped: false,
    }));
  const draw = async () => {
    render(<TrackingScreen />);
    await waitFor(() => expect(document.querySelector('li')).not.toBeNull(), WAIT);
  };

  it('PHONE: the task chips are one strip that slides sideways and no chip shrinks into the next', async () => {
    serve([parcel('a')]);
    await draw();
    const all = screen.getByRole('button', { name: /^الكل 1$/ });
    expect(all.parentElement!.className).toContain('overflow-x-auto');
    expect(all.parentElement!.className).not.toContain('flex-wrap');
    for (const chip of all.parentElement!.querySelectorAll('button')) expect(chip.className).toContain('shrink-0');
  });

  it('DESK: nothing changed — the chips wrap, none is told to hold its width', async () => {
    phone.value = false;
    serve([parcel('a')]);
    await draw();
    const all = screen.getByRole('button', { name: /^الكل 1$/ });
    expect(all.parentElement!.className).toContain('flex-wrap');
    expect(all.parentElement!.className).not.toContain('overflow-x-auto');
    for (const chip of all.parentElement!.querySelectorAll('button')) expect(chip.className).not.toContain('shrink-0');
  });

  it('PHONE: «استلم جزءاً» · «تحويل» · «ملاحظة» are three bordered targets sharing the row', async () => {
    serve([parcel('a')]);
    await draw();
    for (const name of ['استلم جزءاً', 'تحويل', 'ملاحظة']) {
      const b = within(card()).getByRole('button', { name });
      expect(b.className, name).toContain('flex-1');
      expect(b.className, name).toContain('border');
      expect(b.className, name).toContain('px-3');
    }
  });

  it('DESK: nothing changed — the three are the plain words they were', async () => {
    phone.value = false;
    serve([parcel('a')]);
    await draw();
    for (const name of ['استلم جزءاً', 'تحويل', 'ملاحظة']) {
      const b = within(card()).getByRole('button', { name });
      expect(b.className, name).not.toContain('flex-1');
      expect(b.className, name).not.toContain('border');
    }
  });

  it('PHONE: «أغلقه كخسارة» spans the card when it applies', async () => {
    serve([parcel('a', { shippingStatus: 'RETURN_REQUESTED' })]);
    await draw();
    expect(within(card()).getByRole('button', { name: /أغلقه كخسارة/ }).className).toContain('w-full');
  });
});

/* ═══════════════════════ التسليم الجزئي ═══════════════════════ */

describe('the part-delivery dialog', () => {
  const open = async () => {
    apiJson.mockResolvedValue({
      order: { items: [{ id: 'i1', productName: 'كريم تفتيح البشرة الطبيعي 50 مل', quantity: 3, freeQuantity: 0, unitPrice: 10, discountShare: 0 }] },
    });
    render(
      <DeliverDialog
        order={{ id: 'o1', orderNumber: 'SY-1', merchantRef: null, currency: 'JOD', deliveryFee: 5, priceIncludesDelivery: false }}
        onClose={() => {}}
        onDone={() => {}}
      />
    );
    await waitFor(() => screen.getByDisplayValue('3'));
    return screen.getByText('كريم تفتيح البشرة الطبيعي 50 مل');
  };

  it('PHONE: the product name is shown whole — it is the thing being checked', async () => {
    expect((await open()).className).not.toContain('truncate');
  });

  it('DESK: the name is one line with an ellipsis, as it was', async () => {
    phone.value = false;
    expect((await open()).className).toContain('truncate');
  });
});
