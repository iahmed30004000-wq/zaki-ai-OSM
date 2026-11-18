// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «المرتجعات» ON THE KIT (R11e, 18/11) — THE SAME PRESSES, THE SAME FIELDS, THE SAME DOORS.
 *
 * The screen moved onto `PageShell`, `Button`, `Card` and `Checkbox`. A return receipt moves stock back onto a shelf, so
 * nothing a returns clerk does may change: this file holds the screen to what it did BEFORE the move — the numbers below
 * were counted on `osm/main` before the first edit, and the same file passes on both:
 *
 *   (a) how many presses, boxes, fields, columns, links and windows each state of the screen draws;
 *   (b) every press reaches the same handler with the same arguments — the same request body, the same dialog for the
 *       same parcel — and the presses that must send nothing send nothing (NEGATIVE);
 *   (g) on a phone nothing is wider than the screen.
 *
 * Class names are built from pieces: Tailwind reads test files too.
 */

const { api, phone } = vi.hoisted(() => ({ api: vi.fn(), phone: { value: false } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/returns' }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => false }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));

import { ReturnsScreen } from './ReturnsScreen';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 60000 });

/** Three units went out, the customer kept two, one is coming back: the «هل الطلب استلم؟» question is asked. */
const SPLIT = {
  id: 'o1',
  orderNumber: 'ORD-o1',
  merchantRef: null,
  trackingNumber: 'TRK-1',
  shippingStatus: 'PARTIALLY_DELIVERED',
  returnReason: null,
  expectedQty: 1,
  daysWaited: 2,
  customer: { fullName: 'سارة', phone: '0790000000' },
  region: { name: 'عمّان' },
  deliveryProvider: { name: 'ناقل' },
  lines: [{ itemId: 'i1', productName: 'منتج أ', shipped: 3, delivered: 2, expectedBack: 1 }],
  completion: {
    halves: [
      { key: 'MONEY', label: 'تحصيل المال', settled: false, units: 2 },
      { key: 'GOODS', label: 'استلام الراجع', settled: false, units: 1 },
    ],
    settledCount: 0,
    degree: 'NONE',
    complete: false,
    awaiting: ['MONEY', 'GOODS'],
    label: 'تمّ 0 من 2',
  },
  action: { key: 'GOODS', question: 'هل رجعت القطع؟', yes: 'نعم وصلت', no: 'لا ما وصلت' },
};

/** A whole parcel announced as coming back: straight to the count. */
const WHOLE = {
  ...SPLIT,
  id: 'o2',
  orderNumber: 'ORD-o2',
  trackingNumber: null,
  shippingStatus: 'RETURN_REQUESTED',
  expectedQty: 3,
  customer: { fullName: 'ليلى', phone: null },
  lines: [{ itemId: 'i2', productName: 'منتج ب', shipped: 3, delivered: null, expectedBack: 3 }],
  completion: { halves: [{ key: 'GOODS', label: 'استلام الراجع', settled: false, units: 3 }], settledCount: 0, degree: 'NONE', complete: false, awaiting: ['GOODS'], label: 'تمّ 0 من 1' },
  action: null,
};

const listAnswer = (rows: unknown[]) => ({
  count: rows.length,
  orders: rows,
  pagination: { total: rows.length, page: 1, limit: 25, totalPages: 1 },
  facts: {
    views: { pending: rows.length, received: 0 },
    statuses: { RETURN_REQUESTED: 1, RETURNED: 0, FAILED_DELIVERY: 0, PARTIALLY_DELIVERED: 1 },
    couriers: [{ id: 'c1', name: 'ناقل', count: rows.length }],
    ages: { fresh: 2, few: 0, week: 0, old: 0 },
    noBarcode: 1,
  },
  applied: { view: 'pending' },
  mayChargeFee: true,
  mayReceiveAll: true,
});

let posts: { url: string; body: unknown }[];

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  posts = [];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url === '/api/ops/returns/receive-all') return { received: 2, skipped: {}, nextCursor: null };
      return { missingQty: 0, courierFeeAmount: 0, completion: { complete: true, label: '' } };
    }
    return listAnswer([SPLIT, WHOLE]);
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<ReturnsScreen />);
  await screen.findAllByText('ORD-o2');
};

/** What a person can reach on the screen, counted the way a hand would. */
const census = () => ({
  presses: document.querySelectorAll('button').length,
  boxes: document.querySelectorAll('input[type="checkbox"]').length,
  fields: document.querySelectorAll('input:not([type="checkbox"]), select, textarea').length,
  columns: document.querySelectorAll('thead th').length,
  links: document.querySelectorAll('a[href]').length,
  windows: document.querySelectorAll('[role="dialog"]').length,
});
const table = () => document.querySelector('table') as HTMLElement;
const dialog = () => screen.getByRole('dialog');
const rowOf = (ref: string) => within(table()).getByText(ref).closest('tr') as HTMLElement;
/** «استلام» on a parcel's row: the desk's word in the table, or the phone's wide press on its card. */
const receiveOn = (ref: string) =>
  phone.value
    ? within(within(document.querySelector('ul') as HTMLElement).getByText(ref).closest('li') as HTMLElement).getByRole('button', { name: 'استلام' })
    : within(rowOf(ref)).getByRole('button', { name: 'استلام' });
const open = async (ref: string) => {
  await draw();
  fireEvent.click(receiveOn(ref));
  return dialog();
};
const tick = (name: RegExp) => fireEvent.click(within(dialog()).getByLabelText(name));

describe('(a) the same count of everything a hand can reach — before and after the move', () => {
  it.each([
    ['desk, the list', false, null, null, { presses: 15, boxes: 0, fields: 6, columns: 9, links: 0, windows: 0 }],
    ['phone, the list', true, null, null, { presses: 15, boxes: 0, fields: 6, columns: 9, links: 0, windows: 0 }],
    ['desk, the split parcel asked', false, 'ORD-o1', null, { presses: 19, boxes: 0, fields: 6, columns: 9, links: 0, windows: 1 }],
    ['desk, the split parcel answered «نعم»', false, 'ORD-o1', 'نعم وصلت', { presses: 21, boxes: 2, fields: 9, columns: 9, links: 0, windows: 1 }],
    ['desk, the split parcel answered «لا»', false, 'ORD-o1', 'لا ما وصلت', { presses: 19, boxes: 0, fields: 6, columns: 9, links: 0, windows: 1 }],
    ['desk, the whole parcel', false, 'ORD-o2', null, { presses: 19, boxes: 2, fields: 9, columns: 9, links: 0, windows: 1 }],
    ['phone, the whole parcel', true, 'ORD-o2', null, { presses: 19, boxes: 2, fields: 9, columns: 9, links: 0, windows: 1 }],
  ] as const)('%s', async (_state, onPhone, ref, answer, expected) => {
    phone.value = onPhone;
    if (ref) {
      await open(ref);
      if (answer) fireEvent.click(within(dialog()).getByRole('button', { name: answer }));
    } else {
      await draw();
    }
    expect(census()).toEqual(expected);
  });

  it('«استلام الكل», asked', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'استلام الكل (2)' }));
    expect(census()).toEqual({ presses: 18, boxes: 1, fields: 6, columns: 9, links: 0, windows: 1 });
  });
});

describe('(b) every press reaches the same handler with the same arguments', () => {
  it.each([
    ['desk', false],
    ['phone', true],
  ] as const)('«استلام» (%s) opens the window on its own parcel', async (_n, onPhone) => {
    phone.value = onPhone;
    await open('ORD-o2');
    expect(within(dialog()).getByText('استلام مرتجع')).toBeTruthy();
    expect(dialog().textContent).toContain('ORD-o2');
    expect(dialog().textContent).toContain('منتج ب');
  });

  it.each([
    ['desk, as it came', false, false, false, '', { orderId: 'o2', receivedQty: 3, damagedQty: 0, countedAndInspected: true, chargeCourierFee: false }],
    ['desk, with the fee and a note', false, true, true, 'علبة مفتوحة', { orderId: 'o2', receivedQty: 3, damagedQty: 0, countedAndInspected: true, chargeCourierFee: true, note: 'علبة مفتوحة' }],
    ['phone, from the foot of the window', true, false, true, '', { orderId: 'o2', receivedQty: 3, damagedQty: 0, countedAndInspected: true, chargeCourierFee: true }],
  ] as const)('«تأكيد الاستلام» (%s) sends exactly what it sent', async (_n, onPhone, _unused, fee, note, body) => {
    phone.value = onPhone;
    await open('ORD-o2');
    if (fee) tick(/احتساب أجرة إرجاع/);
    if (note) fireEvent.change(within(dialog()).getByLabelText('ملاحظة (اختياري)'), { target: { value: note } });
    tick(/أقرّ بأنني عددت البضاعة/);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'تأكيد الاستلام' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/ops/returns', body });
    await waitFor(() => expect(screen.getByText(/تم استلام ORD-o2: سليم 3، تالف 0، ناقص 0/)).toBeTruthy());
  });

  it('a damaged count is carried as typed', async () => {
    await open('ORD-o2');
    fireEvent.change(within(dialog()).getByLabelText('سليم'), { target: { value: '1' } });
    fireEvent.change(within(dialog()).getByLabelText('تالف'), { target: { value: '1' } });
    tick(/أقرّ بأنني عددت البضاعة/);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'تأكيد الاستلام' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toMatchObject({ receivedQty: 1, damagedQty: 1 });
  });

  it('«تأكيد الاستلام» stays off until the count is acknowledged — a press sends nothing (NEGATIVE)', async () => {
    await open('ORD-o2');
    const press = within(dialog()).getByRole('button', { name: 'تأكيد الاستلام' }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    fireEvent.click(press);
    expect(posts).toHaveLength(0);
  });

  it('«نعم» re-opens the count at the whole expected figure; it submits nothing (NEGATIVE)', async () => {
    await open('ORD-o1');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'نعم وصلت' }));
    expect((within(dialog()).getByLabelText('سليم') as HTMLInputElement).value).toBe('1');
    fireEvent.change(within(dialog()).getByLabelText('سليم'), { target: { value: '0' } });
    // A second press on «نعم» puts the count back — the handler runs on every press, not only on a change.
    fireEvent.click(within(dialog()).getByRole('button', { name: 'نعم وصلت' }));
    expect((within(dialog()).getByLabelText('سليم') as HTMLInputElement).value).toBe('1');
    expect(posts).toHaveLength(0);
  });

  it('«لا» records nothing and the way out reads «إغلاق» (NEGATIVE)', async () => {
    await open('ORD-o1');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'لا ما وصلت' }));
    expect(within(dialog()).queryByRole('button', { name: 'تأكيد الاستلام' })).toBeNull();
    // The window's own corner «إغلاق» is drawn too; this is the one at the end of the form.
    fireEvent.click(within(dialog().querySelector('form') as HTMLElement).getByRole('button', { name: 'إغلاق' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('«إلغاء» closes the window and sends nothing — it is not the form’s submit (NEGATIVE)', async () => {
    await open('ORD-o2');
    tick(/أقرّ بأنني عددت البضاعة/);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('every press inside the form that is not «تأكيد الاستلام» says it does not submit', async () => {
    await open('ORD-o1');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'نعم وصلت' }));
    const form = dialog().querySelector('form') as HTMLFormElement;
    const inside = Array.from(form.querySelectorAll('button')).filter((b) => b.textContent !== 'تأكيد الاستلام');
    expect(inside.length).toBeGreaterThan(0);
    for (const b of inside) expect(b.getAttribute('type'), b.textContent ?? '').toBe('button');
  });

  it('«استلام الكل»: the confirm is off until the tick, then it walks the door with the chosen filters', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'استلام الكل (2)' }));
    const yes = within(dialog()).getByRole('button', { name: 'نعم، استلم الكل' }) as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    fireEvent.click(yes);
    expect(posts).toHaveLength(0);
    tick(/أقرّ إني عددت وفحصت المرتجعات/);
    fireEvent.click(yes);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/api/ops/returns/receive-all',
      body: { view: 'pending', status: 'all', courier: 'all', age: 'all', barcode: 'all', countedAndInspected: true, cursor: null },
    });
  });

  it('«استلام الكل»: «إلغاء» closes it and sends nothing (NEGATIVE)', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'استلام الكل (2)' }));
    tick(/أقرّ إني عددت وفحصت المرتجعات/);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('each tick box is its own: a press on one words leaves the other clear', async () => {
    await open('ORD-o2');
    tick(/احتساب أجرة إرجاع/);
    const boxes = Array.from(dialog().querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    // R11e: each box has its own id, so the kit's label points at it and no other (an empty or shared id breaks a press on the words).
    expect(boxes.map((b) => b.id)).toEqual(['returns-fee-o2', 'returns-ack-o2']);
  });

  it('the «استلام الكل» tick box has its own id too', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'استلام الكل (2)' }));
    expect((dialog().querySelector('input[type="checkbox"]') as HTMLInputElement).id).toBe('returns-receive-all-ack');
  });

  it('the yes/no pair says which answer is chosen', async () => {
    await open('ORD-o1');
    const yes = within(dialog()).getByRole('button', { name: 'نعم وصلت' });
    const no = within(dialog()).getByRole('button', { name: 'لا ما وصلت' });
    expect([yes.getAttribute('aria-pressed'), no.getAttribute('aria-pressed')]).toEqual(['false', 'false']);
    fireEvent.click(no);
    expect([yes.getAttribute('aria-pressed'), no.getAttribute('aria-pressed')]).toEqual(['false', 'true']);
  });
});

describe('the frame', () => {
  it('one h1, the registry’s name; the page is wide; the search box sits in the frame’s row of filters, above the list', async () => {
    const { routeLabel } = await import('@/lib/route-registry');
    await draw();
    const h1s = document.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(routeLabel('/ops/returns'));
    const frame = h1s[0].closest(`.${['max', 'w', '6xl'].join('-')}`) as HTMLElement;
    expect(frame).not.toBeNull();
    const search = frame.querySelector('input:not([type="checkbox"])') as HTMLElement;
    expect(search.compareDocumentPosition(table()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('(g) a phone: nothing wider than the screen', () => {
  const px = (cls: string) => Number(/\[(\d+)px\]/.exec(cls)?.[1] ?? 0);
  it.each([
    ['the list', null],
    ['the window', 'ORD-o2'],
  ] as const)('%s: no fixed width past 375, and no long line that refuses to wrap', async (_n, ref) => {
    phone.value = true;
    if (ref) await open(ref);
    else await draw();
    const nowrap = ['whitespace', 'nowrap'].join('-');
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const classes = (el.getAttribute('class') ?? '').split(/\s+/);
      for (const c of classes) {
        if (/^(min-)?w-\[\d+px\]$/.test(c)) expect(px(c), c).toBeLessThanOrEqual(375);
      }
      if (classes.includes(nowrap)) expect((el.textContent ?? '').length, el.textContent ?? '').toBeLessThanOrEqual(20);
    }
  });
});
