// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «متابعة الشحن» ON THE KIT (R11d, 18/11) — THE SAME PRESSES, THE SAME FIELDS, THE SAME DOORS.
 *
 * The screen moved onto `PageShell`, `Button` and `Card`; the five small parts beside it (`CourierSaidChip`, `ParcelCopy`,
 * `ParcelPhone`, `DifferenceMark`, `BulkDeliverReport`) with it. Nothing a warehouse or shipping person does may change, so
 * this file holds the screen to what it did BEFORE the move — the numbers below were counted on `osm/main` before the
 * first edit, and the same file passes on both:
 *
 *   (a) how many presses, boxes, fields, columns, links and windows each state of the screen draws;
 *   (b) every press reaches the same handler with the same arguments — the same request body, the same dialog for the
 *       same parcel (table-driven, on one page of fixtures that carries every kind of row);
 *   (g) on a phone nothing is wider than the screen: no fixed width past 375, and a line that refuses to wrap only
 *       inside the strip that slides.
 *
 * Class names are built from pieces: Tailwind reads test files too, and a whole class name written here would grow
 * the stylesheet.
 */

/** Every window the screen opens is drawn as a marker that says which parcel(s) it was opened for. */
type Opened = { order?: { id: string }; orders?: { id: string }[] };
const { api, confirm, ask, phone, marker } = vi.hoisted(() => ({
  marker: (name: string) => (p: Opened) =>
    React.createElement('div', {
      role: 'dialog',
      'aria-label': name,
      'data-for': p.order ? p.order.id : (p.orders ?? []).map((o) => o.id).join(','),
    }),
  api: vi.fn(),
  confirm: vi.fn<(o: { title: string; body?: string }) => Promise<boolean>>(async () => true),
  ask: vi.fn<(o: unknown) => Promise<string | null>>(async () => 'المندوب قال بكرة'),
  phone: { value: false },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/components/ui/Confirm', () => ({
  useAsk: () => (o: unknown) => ask(o),
  useConfirm: () => (o: { title: string; body?: string }) => confirm(o),
  useTell: () => async () => undefined,
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));

vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: marker('TransferDialog') }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: marker('CollectDialog') }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: marker('DeliverDialog') }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: marker('WriteOffDialog') }));
vi.mock('@/components/screens/tracking/UndoDeliveryDialog', () => ({ UndoDeliveryDialog: marker('UndoDeliveryDialog') }));
vi.mock('@/components/screens/tracking/CloseLegacyDialog', () => ({ CloseLegacyDialog: marker('CloseLegacyDialog') }));
vi.mock('@/components/screens/tracking/ClosePickedDialog', () => ({ ClosePickedDialog: marker('ClosePickedDialog') }));
vi.mock('@/components/screens/tracking/DifferenceDialog', () => ({ DifferenceDialog: marker('DifferenceDialog') }));

import { TrackingScreen } from '@/components/screens/TrackingScreen';
import { BulkDeliverReport } from '@/components/screens/tracking/BulkDeliverReport';

configure({ asyncUtilTimeout: 8000 });
// The whole screen, drawn as a table and as cards at once, in jsdom: slow on a loaded machine, not wrong.
vi.setConfig({ testTimeout: 60000 });

const P1 = '11111111-1111-4111-8111-111111111111';
const word = (status: string, label: string) => ({ status, label, note: null, at: '2026-11-09T10:00:00.000Z', ageMinutes: 120 });
const parcel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  shippingStatus: 'SHIPPED',
  collectionStatus: 'NOT_APPLICABLE',
  settlementStatus: 'NOT_APPLICABLE',
  daysInTransit: 4,
  lateThresholdDays: 3,
  late: true,
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
  difference: null,
  ...over,
});

/** One page carrying every kind of row the screen draws a press for. */
const PAGE = () => [
  // A live alert: the notice (phone) and the desk's «أدركتُ الإجراء»; on the road, so «استلم» / «رفض» / «استلم جزءاً».
  parcel('alert1', { alert: { kind: 'CANCELLED', at: '2026-11-09T10:00:00.000Z', acknowledged: false } }),
  // The company says «تم التوصيل»: the bulk «استلم المحدد» box.
  parcel('said2', { courierSaid: word('DELIVERED', 'تم التوصيل'), late: false }),
  // Delivered, money waiting: the «استلمت منه» box, «تراجع عن التسليم…», and a difference at matching.
  parcel('owed3', {
    shippingStatus: 'DELIVERED',
    settlementStatus: 'PENDING_COLLECTION',
    collectionStatus: 'PENDING_COLLECTION',
    late: false,
    daysInTransit: 2,
    difference: {
      matchId: 'm1', statementId: 's1', statement: 'ST-1', ours: 40, theirs: 35, gap: 5, answered: false, resolution: null,
      resolutionKind: null, resolutionNote: null, claim: null, closed: false, note: null, decisions: null, courierWord: null,
    },
  }),
  // Lost with the company: «أغلقه كخسارة»; a failure sentence, an unpriced lane.
  parcel('lost4', { shippingStatus: 'RETURN_REQUESTED', deliveryFailureReason: 'الزبون ما رد', lateThresholdDays: null, _count: { deliveryAttempts: 2, notes: 1 } }),
];

const TASKS = { CANCELLED: 1, CHANGED: 0, FAILED: 0, RETURNING: 1, LATE: 1, NO_BARCODE: 0, COLLECT: 1 };
let access: { money: boolean; returns: boolean; collect: boolean };
let posts: { url: string; body: unknown }[];
let answer: unknown;

const listAnswer = (rows: ReturnType<typeof parcel>[]) => ({
  count: rows.length,
  orders: rows,
  lateCount: 1,
  dialCode: '962',
  pagination: { total: rows.length, page: 1, limit: 25, totalPages: 1 },
  facts: {
    total: rows.length,
    tasks: TASKS,
    lateCount: 1,
    notLate: 2,
    difference: 1,
    couriers: [{ id: P1, name: 'الباشا', count: rows.length }],
    regions: [],
    ages: { fresh: 1, few: 0, week: 0, old: 0 },
    said: { DELIVERED: 1, PARTIALLY_DELIVERED: 0, RETURNED: 0, CANCELLED: 0, FAILED_DELIVERY: 0 },
  },
  applied: {},
  capped: false,
  access,
  acts: { deliver: true, transfer: true, writeOff: true, closeLegacy: true, undoDelivery: true, decide: true },
});
const gets = () => api.mock.calls.filter((c) => !(c[1] && (c[1] as RequestInit).method)).map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  confirm.mockImplementation(async () => true);
  ask.mockImplementation(async () => 'المندوب قال بكرة');
  access = { money: true, returns: true, collect: true };
  posts = [];
  answer = { message: 'تم', results: [{ orderId: 'said2', orderNumber: 'ORD-said2', ok: true }], delivered: 1, refused: 0 };
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return answer;
    }
    return listAnswer(PAGE());
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TrackingScreen />);
  await screen.findByLabelText('جهة الشحن');
  await screen.findAllByText('ORD-alert1');
};

/** What a person can reach on the screen, counted the way a hand would: presses, boxes, fields, columns, links, windows. */
const census = () => ({
  presses: document.querySelectorAll('button').length,
  boxes: document.querySelectorAll('input[type="checkbox"]').length,
  fields: document.querySelectorAll('input:not([type="checkbox"]), select, textarea').length,
  columns: document.querySelectorAll('thead th').length,
  links: document.querySelectorAll('a[href]').length,
  windows: document.querySelectorAll('[role="dialog"]').length,
});
const deskBoxes = () => Array.from(document.querySelectorAll('tbody input[type="checkbox"]')) as HTMLInputElement[];
const table = () => document.querySelector('table') as HTMLElement;
const btn = (name: string | RegExp) => screen.getByRole('button', { name });
const opened = (name: string) => screen.getByRole('dialog', { name }).getAttribute('data-for');

describe('(a) the same count of everything a hand can reach — before and after the move', () => {
  it.each([
    // [state, phone?, what is ticked, expected]
    ['desk, nothing ticked', false, null, { presses: 85, boxes: 4, fields: 6, columns: 14, links: 21, windows: 0 }],
    ['desk, a parcel owed money ticked', false, 'owed3', { presses: 86, boxes: 4, fields: 6, columns: 14, links: 21, windows: 0 }],
    ['desk, a «تم التوصيل» parcel ticked', false, 'said2', { presses: 86, boxes: 4, fields: 6, columns: 14, links: 21, windows: 0 }],
    ['phone, nothing ticked', true, null, { presses: 85, boxes: 4, fields: 6, columns: 14, links: 21, windows: 0 }],
    ['phone, a parcel owed money ticked', true, 'owed3', { presses: 85, boxes: 4, fields: 6, columns: 14, links: 21, windows: 0 }],
    ['phone, a «تم التوصيل» parcel ticked', true, 'said2', { presses: 86, boxes: 4, fields: 6, columns: 14, links: 21, windows: 0 }],
  ] as const)('%s', async (_state, onPhone, tick, expected) => {
    phone.value = onPhone;
    await draw();
    if (tick) {
      const row = within(table()).getAllByText(`ORD-${tick}`)[0].closest('tr') as HTMLElement;
      fireEvent.click(row.querySelector('input[type="checkbox"]') as HTMLInputElement);
    }
    expect(census()).toEqual(expected);
  });
});

describe('(b) every press reaches the same handler with the same arguments', () => {
  it.each([
    ['«أدركتُ الإجراء» (desk)', async () => fireEvent.click(within(table()).getByRole('button', { name: /أدركتُ الإجراء/ })), { url: '/api/ops/tracking/acknowledge', body: { orderId: 'alert1', kind: 'CANCELLED' } }],
    ['«استلم»', async () => fireEvent.click(within(table()).getAllByRole('button', { name: 'استلم' })[0]), { url: '/api/ops/tracking/deliver', body: { orderId: 'alert1', outcome: 'ALL' } }],
    ['«رفض / ملغى»', async () => fireEvent.click(within(table()).getAllByRole('button', { name: /رفض \/ ملغى/ })[0]), { url: '/api/ops/tracking/deliver', body: { orderId: 'alert1', outcome: 'NONE' } }],
    ['«ملاحظة»', async () => fireEvent.click(within(table()).getAllByRole('button', { name: /ملاحظة/ })[3]), { url: '/api/orders/lost4/notes', body: { body: 'المندوب قال بكرة', kind: 'follow_up' } }],
  ] as const)('%s — sends exactly what it sent', async (_name, pressIt, expected) => {
    await draw();
    await pressIt();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual(expected);
  });

  it('«أدركتُ الإجراء» on the phone card’s notice — the same request', async () => {
    phone.value = true;
    await draw();
    const cards = document.querySelector('ul') as HTMLElement;
    // The notice is the card's first; the desk's copy is drawn too (a class hides it on a phone, which jsdom does not apply).
    fireEvent.click(within(cards).getAllByRole('button', { name: /أدركتُ الإجراء/ })[0]);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/ops/tracking/acknowledge', body: { orderId: 'alert1', kind: 'CANCELLED' } });
  });

  it('«رفض / ملغى» asks first, and a «no» sends nothing (NEGATIVE)', async () => {
    confirm.mockImplementation(async () => false);
    await draw();
    fireEvent.click(within(table()).getAllByRole('button', { name: /رفض \/ ملغى/ })[0]);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(posts).toHaveLength(0);
  });

  it('«ملاحظة» with nothing written sends nothing (NEGATIVE)', async () => {
    ask.mockImplementation(async () => '   ');
    await draw();
    fireEvent.click(within(table()).getAllByRole('button', { name: /ملاحظة/ })[0]);
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(posts).toHaveLength(0);
  });

  it.each([
    ['«استلم جزءاً»', () => within(table()).getAllByRole('button', { name: 'استلم جزءاً' })[1], 'DeliverDialog', 'said2'],
    ['«أغلقه كخسارة»', () => within(table()).getByRole('button', { name: /أغلقه كخسارة/ }), 'WriteOffDialog', 'lost4'],
    ['«تراجع عن التسليم…»', () => within(table()).getByRole('button', { name: /تراجع عن التسليم/ }), 'UndoDeliveryDialog', 'owed3'],
    ['«تحويل»', () => within(table()).getAllByRole('button', { name: 'تحويل' })[2], 'TransferDialog', 'owed3'],
    ['the «فيه فرق» mark', () => within(table()).getByRole('button', { name: /نقص/ }), 'DifferenceDialog', 'owed3'],
    ['«أقفل القديمة بلا باركود…»', () => btn(/أقفل القديمة بلا باركود/), 'CloseLegacyDialog', ''],
  ] as const)('%s opens its window for its own parcel', async (_name, find, dialog, id) => {
    await draw();
    fireEvent.click(find());
    expect(opened(dialog)).toBe(id);
    // One window at a time: the press opened exactly that one.
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it.each([
    ['desk', false],
    ['phone', true],
  ] as const)('the money strip (%s): «اختر الكل» ticks the owed parcel, «استلمت منه» and «أقفل المحدّد…» open on it, «إلغاء الاختيار» puts it away', async (_n, onPhone) => {
    phone.value = onPhone;
    await draw();
    fireEvent.click(btn('اختر الكل'));
    expect(deskBoxes().filter((b) => b.checked)).toHaveLength(1);
    fireEvent.click(btn(/استلمت منه/));
    expect(opened('CollectDialog')).toBe('owed3');
    fireEvent.click(btn(/أقفل المحدّد بلا حركة مال/));
    expect(opened('ClosePickedDialog')).toBe('owed3');
    fireEvent.click(btn('إلغاء الاختيار'));
    expect(deskBoxes().filter((b) => b.checked)).toHaveLength(0);
  });

  it.each([
    ['desk', false],
    ['phone', true],
  ] as const)('the «تم التوصيل» strip (%s): «حدّد كل…» then «استلم المحدد» asks, then sends the ticked ids, once', async (_n, onPhone) => {
    phone.value = onPhone;
    await draw();
    fireEvent.click(btn(/حدّد كل اللي الشركة بتقول عنهم/));
    fireEvent.click(btn(/استلم المحدد \(1\)/));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(posts[0]).toEqual({ url: '/api/ops/tracking/deliver-many', body: { orderIds: ['said2'] } });
    // The report is drawn, and «تمام» puts it away.
    const report = await screen.findByRole('region', { name: 'تقرير الاستلام الجماعي' });
    fireEvent.click(within(report).getByRole('button', { name: 'تمام' }));
    expect(screen.queryByRole('region', { name: 'تقرير الاستلام الجماعي' })).toBeNull();
  });

  it('«استلمت منه» is off when two companies are ticked (NEGATIVE)', async () => {
    api.mockImplementation(async () =>
      listAnswer([...PAGE(), parcel('owed5', { shippingStatus: 'DELIVERED', late: false, deliveryProvider: { id: 'p2', name: 'أخرى', kind: 'AGENT' } })])
    );
    await draw();
    fireEvent.click(btn('اختر الكل'));
    expect((btn(/استلمت منه/) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe('اختر طرود شركة وحدة');
  });

  it.each([
    ['«الكل»', /^الكل /, 'task=all'],
    ['«اعرضها»', 'اعرضها', 'task=COLLECT'],
  ] as const)('%s asks the server the chip’s question', async (_n, name, query) => {
    await draw();
    // Leave «الكل» first, so pressing it is a change the screen has to ask about.
    fireEvent.click(btn(/^متأخرة \d+$/));
    await waitFor(() => expect(gets().some((u) => u.includes('task=LATE'))).toBe(true));
    fireEvent.click(btn(name));
    if (query === 'task=all') await waitFor(() => expect(gets().at(-1)).not.toContain('task='));
    else await waitFor(() => expect(gets().at(-1)).toContain(query));
  });
});

describe('the parts beside the screen', () => {
  it('BulkDeliverReport: one line per parcel and «تمام» is the only press, which closes it', () => {
    const onClose = vi.fn();
    render(
      <BulkDeliverReport
        lines={[{ id: 'a', label: 'ORD-a', ok: true }, { id: 'b', label: 'ORD-b', ok: false, reason: 'الحالة تغيّرت' }]}
        delivered={1}
        refused={1}
        onClose={onClose}
      />
    );
    const report = screen.getByRole('region', { name: 'تقرير الاستلام الجماعي' });
    expect(within(report).getAllByRole('listitem')).toHaveLength(2);
    expect(within(report).getAllByRole('button')).toHaveLength(1);
    expect(report.textContent).toContain('انسجّل 1 وما انسجّل 1');
    expect(report.textContent).toContain('الحالة تغيّرت');
    fireEvent.click(within(report).getByRole('button', { name: 'تمام' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('(g) a phone: nothing wider than the screen', () => {
  const px = (cls: string) => Number(/\[(\d+)px\]/.exec(cls)?.[1] ?? 0);
  it('no fixed width past 375, and a line that will not wrap only inside the strip that slides', async () => {
    phone.value = true;
    await draw();
    const nowrap = ['whitespace', 'nowrap'].join('-');
    const slides = ['overflow', 'x', 'auto'].join('-');
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const classes = (el.getAttribute('class') ?? '').split(/\s+/);
      for (const c of classes) {
        if (/^(min-)?w-\[\d+px\]$/.test(c)) expect(px(c), c).toBeLessThanOrEqual(375);
      }
      // A figure (an amount, a count) is kept on one line on purpose, and it is a few characters wide.
      if (classes.includes(nowrap) && (el.textContent ?? '').length > 20) {
        expect(el.closest(`.${slides}`), 'سطر ما بيلف برّا الشريط اللي بينزلق').not.toBeNull();
      }
    }
  });
});
